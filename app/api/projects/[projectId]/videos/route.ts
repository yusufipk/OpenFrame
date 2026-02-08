import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';
import { validateUrl, validateOptionalUrl } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/videos - List all videos in a project
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        // Check project exists and user has access
        const project = await db.project.findUnique({
            where: { id: projectId },
            include: { members: { where: { userId: session?.user?.id || '' } } },
        });

        if (!project) {
            return apiErrors.notFound('Project');
        }

        const isOwner = session?.user?.id === project.ownerId;
        const isMember = project.members.length > 0;
        const isPublic = project.visibility === 'PUBLIC';

        if (!isOwner && !isMember && !isPublic) {
            return apiErrors.forbidden('Access denied');
        }

        const videos = await db.video.findMany({
            where: { projectId },
            orderBy: { position: 'asc' },
            include: {
                versions: {
                    orderBy: { versionNumber: 'desc' },
                    include: {
                        _count: { select: { comments: true } },
                    },
                },
                _count: { select: { versions: true } },
            },
        });

        const response = successResponse({ videos });
        return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
    } catch (error) {
        console.error('Error fetching videos:', error);
        return apiErrors.internalError('Failed to fetch videos');
    }
}

// POST /api/projects/[projectId]/videos - Add a new video to the project
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'create-video');
        if (limited) return limited;

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
        const { title, description, videoUrl, providerId, videoId, thumbnailUrl, duration } = body;

        if (!title || !videoUrl) {
            return apiErrors.badRequest('Title and video URL are required');
        }

        // Validate URLs use safe schemes (http/https only)
        const videoUrlError = validateUrl(videoUrl, 'Video URL');
        if (videoUrlError) {
            return apiErrors.badRequest(videoUrlError);
        }

        const thumbnailUrlError = validateOptionalUrl(thumbnailUrl, 'Thumbnail URL');
        if (thumbnailUrlError) {
            return apiErrors.badRequest(thumbnailUrlError);
        }

        // Get the next position
        const lastVideo = await db.video.findFirst({
            where: { projectId },
            orderBy: { position: 'desc' },
        });
        const nextPosition = (lastVideo?.position ?? -1) + 1;

        // Create video with initial version
        const video = await db.video.create({
            data: {
                title: title.trim(),
                description: description?.trim() || null,
                position: nextPosition,
                projectId,
                versions: {
                    create: {
                        versionNumber: 1,
                        providerId: providerId || 'youtube',
                        videoId: videoId || '',
                        originalUrl: videoUrl,
                        title: title.trim(),
                        thumbnailUrl: thumbnailUrl || null,
                        duration: duration || null,
                        isActive: true,
                    },
                },
            },
            include: {
                versions: true,
                _count: { select: { versions: true } },
            },
        });

        // Notify project owner (fire-and-forget, skip if they added it themselves)
        if (project.ownerId !== session.user.id) {
            const baseUrl = process.env.NEXTAUTH_URL || '';
            notifyProjectOwner(project.ownerId, {
                type: 'new_video',
                projectName: project.name,
                videoTitle: title.trim(),
                addedBy: session.user.name || 'A team member',
                url: `${baseUrl}/watch/${video.id}`,
            }).catch((err) => console.error('Notification failed:', err));
        }

        const response = successResponse(video, 201);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error creating video:', error);
        return apiErrors.internalError('Failed to create video');
    }
}
