import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';
import { validateUrl, validateOptionalUrl } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

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
            return apiErrors.notFound('Video');
        }

        const isOwner = session?.user?.id === video.project.ownerId;
        const isMember = video.project.members.length > 0;
        const isPublic = video.project.visibility === 'PUBLIC';

        if (!isOwner && !isMember && !isPublic) {
            return apiErrors.forbidden('Access denied');
        }

        const versions = await db.videoVersion.findMany({
            where: { videoParentId: videoId },
            orderBy: { versionNumber: 'desc' },
            include: {
                _count: { select: { comments: true } },
            },
        });

        const response = successResponse({ versions });
        return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
    } catch (error) {
        console.error('Error fetching versions:', error);
        return apiErrors.internalError('Failed to fetch versions');
    }
}

// POST /api/projects/[projectId]/videos/[videoId]/versions - Add a new version
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'create-version');
        if (limited) return limited;

        const session = await auth();
        const { projectId, videoId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: {
                    include: {
                        members: { where: { userId: session.user.id } },
                        workspace: {
                            include: {
                                members: { where: { userId: session.user.id } },
                            },
                        },
                    },
                },
                versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        const isOwner = video.project.ownerId === session.user.id;
        const membership = video.project.members[0];
        const workspaceMembership = video.project.workspace.members[0];
        const canEdit = isOwner ||
            membership?.role === ProjectMemberRole.ADMIN ||
            workspaceMembership?.role === WorkspaceMemberRole.ADMIN;

        if (!canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { videoUrl, providerId, providerVideoId, versionLabel, thumbnailUrl, duration, setActive } = body;

        if (!videoUrl) {
            return apiErrors.badRequest('Video URL is required');
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

        const nextVersionNumber = (video.versions[0]?.versionNumber || 0) + 1;

        // Use transaction to handle active flag
        const version = await db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
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

        const response = successResponse(version, 201);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Error creating version:', error);
        return apiErrors.internalError('Failed to create version');
    }
}
