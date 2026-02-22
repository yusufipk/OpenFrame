import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import crypto from 'crypto';

type RouteParams = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        // Check project access (must be owner, project admin, or workspace admin)
        const project = await db.project.findUnique({
            where: { id: projectId },
            include: {
                members: { where: { userId: session.user.id } },
                workspace: {
                    include: {
                        members: { where: { userId: session.user.id } },
                    },
                },
            },
        });

        if (!project) {
            return apiErrors.notFound('Project');
        }

        const isOwner = project.ownerId === session.user.id;
        const membership = project.members[0];
        const workspaceMembership = project.workspace.members[0];
        const canEdit = isOwner ||
            membership?.role === ProjectMemberRole.ADMIN ||
            workspaceMembership?.role === WorkspaceMemberRole.ADMIN;

        if (!canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { title } = body;

        if (!title) {
            return apiErrors.badRequest('Title is required');
        }

        const apiKey = process.env.BUNNY_STREAM_API_KEY;
        const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;

        if (!apiKey || !libraryId) {
            return apiErrors.internalError('Bunny Stream is not configured correctly');
        }

        // 1. Create video object in Bunny Stream
        const bunnyRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
            method: 'POST',
            headers: {
                'AccessKey': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ title })
        });

        if (!bunnyRes.ok) {
            console.error('Failed to create Bunny Stream video', await bunnyRes.text());
            return apiErrors.internalError('Failed to initialize video upload with provider');
        }

        const bunnyVideo = await bunnyRes.json();
        const videoId = bunnyVideo.guid;

        // 2. Generate TUS upload signature
        const expirationTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity

        // SHA256(library_id + api_key + expiration_time + video_id)
        const hash = crypto.createHash('sha256');
        hash.update(libraryId + apiKey + expirationTime + videoId);
        const signature = hash.digest('hex');

        const response = successResponse({
            videoId,
            libraryId,
            signature,
            expirationTime
        });

        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error initializing Bunny upload:', error);
        return apiErrors.internalError('Failed to initialize upload');
    }
}
