import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole } from '@prisma/client';
import { validateUrl, validateOptionalUrl } from '@/lib/validation';

type RouteParams = { params: Promise<{ projectId: string; videoId: string }> };

// GET /api/projects/[projectId]/videos/[videoId]/versions
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId, videoId } = await params;

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: {
                    include: { members: { where: { userId: session?.user?.id || '' } } },
                },
            },
        });

        if (!video) {
            return NextResponse.json({ error: 'Video not found' }, { status: 404 });
        }

        const isOwner = session?.user?.id === video.project.ownerId;
        const isMember = video.project.members.length > 0;
        const isPublicOrLink = video.project.visibility !== 'PRIVATE';

        if (!isOwner && !isMember && !isPublicOrLink) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        const versions = await db.videoVersion.findMany({
            where: { videoParentId: videoId },
            orderBy: { versionNumber: 'desc' },
            include: {
                _count: { select: { comments: true } },
            },
        });

        return NextResponse.json({ versions });
    } catch (error) {
        console.error('Error fetching versions:', error);
        return NextResponse.json(
            { error: 'Failed to fetch versions' },
            { status: 500 }
        );
    }
}

// POST /api/projects/[projectId]/videos/[videoId]/versions - Add a new version
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId, videoId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: { include: { members: { where: { userId: session.user.id } } } },
                versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
            },
        });

        if (!video) {
            return NextResponse.json({ error: 'Video not found' }, { status: 404 });
        }

        const isOwner = video.project.ownerId === session.user.id;
        const membership = video.project.members[0];
        const canEdit = isOwner ||
            membership?.role === ProjectMemberRole.ADMIN;

        if (!canEdit) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        const body = await request.json();
        const { videoUrl, providerId, providerVideoId, versionLabel, thumbnailUrl, duration, setActive } = body;

        if (!videoUrl) {
            return NextResponse.json(
                { error: 'Video URL is required' },
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

        const nextVersionNumber = (video.versions[0]?.versionNumber || 0) + 1;

        // Use transaction to handle active flag
        const version = await db.$transaction(async (tx) => {
            // If setActive, deactivate all other versions
            if (setActive) {
                await tx.videoVersion.updateMany({
                    where: { videoParentId: videoId },
                    data: { isActive: false },
                });
            }

            return tx.videoVersion.create({
                data: {
                    versionNumber: nextVersionNumber,
                    versionLabel: versionLabel?.trim() || null,
                    providerId: providerId || 'youtube',
                    videoId: providerVideoId || '',
                    originalUrl: videoUrl,
                    title: versionLabel?.trim() || `Version ${nextVersionNumber}`,
                    thumbnailUrl: thumbnailUrl || null,
                    duration: duration || null,
                    isActive: setActive ?? false,
                    videoParentId: videoId,
                },
                include: {
                    _count: { select: { comments: true } },
                },
            });
        });

        return NextResponse.json(version, { status: 201 });
    } catch (error) {
        console.error('Error creating version:', error);
        return NextResponse.json(
            { error: 'Failed to create version' },
            { status: 500 }
        );
    }
}
