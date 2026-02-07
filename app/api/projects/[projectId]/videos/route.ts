import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole } from '@prisma/client';
import { validateUrl, validateOptionalUrl } from '@/lib/validation';

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
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        const isOwner = session?.user?.id === project.ownerId;
        const isMember = project.members.length > 0;
        const isPublicOrLink = project.visibility !== 'PRIVATE';

        if (!isOwner && !isMember && !isPublicOrLink) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
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

        return NextResponse.json({ videos });
    } catch (error) {
        console.error('Error fetching videos:', error);
        return NextResponse.json(
            { error: 'Failed to fetch videos' },
            { status: 500 }
        );
    }
}

// POST /api/projects/[projectId]/videos - Add a new video to the project
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Check project access (must be owner or admin)
        const project = await db.project.findUnique({
            where: { id: projectId },
            include: { members: { where: { userId: session.user.id } } },
        });

        if (!project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        const isOwner = project.ownerId === session.user.id;
        const membership = project.members[0];
        const canEdit = isOwner ||
            membership?.role === ProjectMemberRole.ADMIN;

        if (!canEdit) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        const body = await request.json();
        const { title, description, videoUrl, providerId, videoId, thumbnailUrl, duration } = body;

        if (!title || !videoUrl) {
            return NextResponse.json(
                { error: 'Title and video URL are required' },
                { status: 400 }
            );
        }

        // Validate URLs use safe schemes (http/https only)
        const videoUrlError = validateUrl(videoUrl, 'Video URL');
        if (videoUrlError) {
            return NextResponse.json({ error: videoUrlError }, { status: 400 });
        }

        const thumbnailUrlError = validateOptionalUrl(thumbnailUrl, 'Thumbnail URL');
        if (thumbnailUrlError) {
            return NextResponse.json({ error: thumbnailUrlError }, { status: 400 });
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

        return NextResponse.json(video, { status: 201 });
    } catch (error) {
        console.error('Error creating video:', error);
        return NextResponse.json(
            { error: 'Failed to create video' },
            { status: 500 }
        );
    }
}
