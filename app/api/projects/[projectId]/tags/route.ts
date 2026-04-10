import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string }> };

// GET /api/projects/[projectId]/tags - Get all tags for a project
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const session = await auth();
        const { projectId } = await params;
        const videoId = request.nextUrl.searchParams.get('videoId');

        const project = await db.project.findUnique({
            where: { id: projectId },
            select: { id: true, ownerId: true, workspaceId: true, visibility: true },
        });
        if (!project) return apiErrors.notFound('Project');

        if (session?.user?.id) {
            const access = await checkProjectAccess(project, session.user.id);
            if (!access.hasAccess) {
                return apiErrors.notFound('Project');
            }
        } else {
            let hasGuestAccess = project.visibility === 'PUBLIC';
            if (!hasGuestAccess && videoId) {
                const video = await db.video.findFirst({
                    where: { id: videoId, projectId },
                    select: { id: true },
                });
                if (video) {
                    const shareSession = getShareSessionFromRequest(request, video.id);
                    const shareAccess = shareSession
                        ? await validateShareLinkAccess({
                            token: shareSession.token,
                            projectId,
                            videoId: video.id,
                            requiredPermission: 'COMMENT',
                            passwordVerified: shareSession.passwordVerified,
                        })
                        : { hasAccess: false, canComment: false, canDownload: false, allowGuests: false, requiresPassword: false };
                    hasGuestAccess = shareAccess.canComment && shareAccess.allowGuests;
                }
            }

            if (!hasGuestAccess) {
                return apiErrors.forbidden('Access denied');
            }
        }

        const tags = await db.commentTag.findMany({
            where: { projectId },
            orderBy: { position: 'asc' },
        });

        const response = successResponse(tags);
        const cacheControl = session?.user?.id
            ? 'private, max-age=120, stale-while-revalidate=300'
            : 'private, no-cache';
        return withCacheControl(response, cacheControl);
    } catch (error) {
        logError('Error fetching tags:', error);
        return apiErrors.internalError('Failed to fetch tags');
    }
}

// POST /api/projects/[projectId]/tags - Create a new tag
export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        const { projectId } = await params;

        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const project = await db.project.findUnique({
            where: { id: projectId },
            select: { id: true, ownerId: true, workspaceId: true, visibility: true },
        });
        if (!project) {
            return apiErrors.notFound('Project');
        }

        const access = await checkProjectAccess(project, session.user.id, { intent: 'manage' });
        if (!access.canEdit) {
            return apiErrors.forbidden('Access denied');
        }

        const body = await request.json();
        const { name, color } = body;

        if (!name?.trim() || !color?.trim()) {
            return apiErrors.badRequest('Name and color are required');
        }

        // Hex color validation
        if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
            return apiErrors.badRequest('Invalid color format');
        }

        // Get max position
        const maxPos = await db.commentTag.aggregate({
            where: { projectId },
            _max: { position: true },
        });

        const tag = await db.commentTag.create({
            data: {
                name: name.trim(),
                color: color.toUpperCase(),
                position: (maxPos._max.position ?? -1) + 1,
                projectId,
            },
        });

        const response = successResponse(tag, 201);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error creating tag:', error);
        if ((error as { code?: string }).code === 'P2002') {
            return apiErrors.conflict('Tag name already exists');
        }
        return apiErrors.internalError('Failed to create tag');
    }
}
