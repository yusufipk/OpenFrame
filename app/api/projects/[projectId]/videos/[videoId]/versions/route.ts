import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { validateUrl, validateOptionalUrl } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { verifyBunnyUploadToken } from '@/lib/bunny-upload-token';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string; videoId: string }> };

// GET /api/projects/[projectId]/videos/[videoId]/versions
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId, videoId } = await params;

        const video = await db.video.findFirst({
            where: { id: videoId, projectId },
            include: {
                project: true,
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        const access = await checkProjectAccess(video.project, session?.user?.id);
        if (!access.hasAccess) {
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
        logError('Error fetching versions:', error);
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
                project: true,
                versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
            },
        });

        if (!video) {
            return apiErrors.notFound('Video');
        }

        const access = await checkProjectAccess(video.project, session.user.id, { intent: 'manage' });
        if (!access.canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const {
            videoUrl,
            providerId,
            providerVideoId,
            versionLabel,
            thumbnailUrl,
            duration,
            setActive,
            uploadToken
        } = body;

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

        const normalizedProviderId = typeof providerId === 'string' && providerId.trim()
            ? providerId.trim().toLowerCase()
            : 'youtube';
        const normalizedProviderVideoId = typeof providerVideoId === 'string' ? providerVideoId.trim() : '';
        const normalizedUploadToken = typeof uploadToken === 'string' ? uploadToken.trim() : '';

        if (normalizedProviderId === 'bunny') {
            if (!normalizedProviderVideoId || !normalizedUploadToken) {
                return apiErrors.badRequest('Bunny uploads must include providerVideoId and uploadToken');
            }

            const isValidUploadToken = verifyBunnyUploadToken(normalizedUploadToken, {
                userId: session.user.id,
                projectId,
                videoId: normalizedProviderVideoId,
            });
            if (!isValidUploadToken) {
                return apiErrors.forbidden('Invalid Bunny upload token');
            }
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
                    providerId: normalizedProviderId,
                    videoId: normalizedProviderVideoId,
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

        // Notify project owner (fire-and-forget, skip if they added it themselves)
        if (video.project.ownerId !== session.user.id) {
            const baseUrl = process.env.NEXTAUTH_URL || '';
            notifyProjectOwner(video.project.ownerId, {
                type: 'new_version',
                projectName: video.project.name,
                videoTitle: video.title,
                versionLabel: version.versionLabel || `Version ${version.versionNumber}`,
                addedBy: session.user.name || 'A team member',
                url: `${baseUrl}/watch/${video.id}`,
            }).catch((err) => logError('Notification failed:', err));
        }

        const response = successResponse(version, 201);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error creating version:', error);
        return apiErrors.internalError('Failed to create version');
    }
}
