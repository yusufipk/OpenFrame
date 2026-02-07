import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { cleanupVideoVoiceFiles } from '@/lib/r2-cleanup';

type RouteParams = { params: Promise<{ projectId: string; videoId: string }> };

// GET /api/projects/[projectId]/videos/[videoId]
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
                versions: {
                    orderBy: { versionNumber: 'desc' },
                    include: {
                        comments: {
                            orderBy: { timestamp: 'asc' },
                            include: {
                                author: { select: { id: true, name: true, image: true } },
                                tag: { select: { id: true, name: true, color: true } },
                                replies: {
                                    orderBy: { createdAt: 'asc' },
                                    include: {
                                        author: { select: { id: true, name: true, image: true } },
                                        tag: { select: { id: true, name: true, color: true } },
                                    },
                                },
                            },
                            where: { parentId: null }, // Only top-level comments
                        },
                        _count: { select: { comments: true } },
                    },
                },
            },
        });

        if (!video) {
            return NextResponse.json({ error: 'Video not found' }, { status: 404 });
        }

        // Check access
        const isOwner = session?.user?.id === video.project.ownerId;
        const isMember = video.project.members.length > 0;
        const isPublic = video.project.visibility === 'PUBLIC';

        if (!isOwner && !isMember && !isPublic) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }

        return NextResponse.json({
            ...video,
            isAuthenticated: !!session?.user?.id,
        });
    } catch (error) {
        console.error('Error fetching video:', error);
        return NextResponse.json(
            { error: 'Failed to fetch video' },
            { status: 500 }
        );
    }
}

// PATCH /api/projects/[projectId]/videos/[videoId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId, videoId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: { include: { members: { where: { userId: session.user.id } } } },
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
        const { title, description, position } = body;

        const updateData: Record<string, unknown> = {};
        if (title !== undefined) updateData.title = title.trim();
        if (description !== undefined) updateData.description = description?.trim() || null;
        if (position !== undefined) updateData.position = position;

        const updatedVideo = await db.video.update({
            where: { id: videoId },
            data: updateData,
            include: {
                versions: { orderBy: { versionNumber: 'desc' } },
                _count: { select: { versions: true } },
            },
        });

        return NextResponse.json(updatedVideo);
    } catch (error) {
        console.error('Error updating video:', error);
        return NextResponse.json(
            { error: 'Failed to update video' },
            { status: 500 }
        );
    }
}

// DELETE /api/projects/[projectId]/videos/[videoId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId, videoId } = await params;

        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: { include: { members: { where: { userId: session.user.id } } } },
            },
        });

        if (!video) {
            return NextResponse.json({ error: 'Video not found' }, { status: 404 });
        }

        const isOwner = video.project.ownerId === session.user.id;
        const membership = video.project.members[0];
        // Destructive actions limited to OWNER and ADMIN only
        const canDelete = isOwner || membership?.role === ProjectMemberRole.ADMIN;

        if (!canDelete) {
            return NextResponse.json(
                { error: 'Only project owner or admin can delete videos' },
                { status: 403 }
            );
        }

        // Clean up voice files from R2 before cascade delete removes comment rows
        await cleanupVideoVoiceFiles(videoId);

        await db.video.delete({ where: { id: videoId } });

        return NextResponse.json({ success: true, message: 'Video deleted' });
    } catch (error) {
        console.error('Error deleting video:', error);
        return NextResponse.json(
            { error: 'Failed to delete video' },
            { status: 500 }
        );
    }
}
