import { apiTokenScopeRefusal, getSession, withApiToken } from '@/lib/api-tokens';
import { ContentError, mergeVideoIntoVersions } from '@/lib/content-mutations';
import { NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { recordAccountActivity } from '@/lib/analytics/record';

type RouteParams = { params: Promise<{ projectId: string; videoId: string }> };

// POST /api/projects/[projectId]/videos/[videoId]/versions/merge
// Adds every version of `sourceVideoId` to this file and removes the source file.
// The first call answers with a confirmation token; repeat it with the token to commit.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const session = await getSession();
    if (!session?.user?.id) return apiErrors.unauthorized();
    // The source's content takes on the target's access, so for a token this is
    // `share` as well as `manage`, the same as moving a video. The source file
    // itself is deleted, which DELETE /videos/[videoId] guards with `delete`.
    const scopeRefusal = apiTokenScopeRefusal('share') ?? apiTokenScopeRefusal('delete');
    if (scopeRefusal) return scopeRefusal;
    const { projectId, videoId } = await params;
    const body = await request.json().catch(() => null);
    const sourceVideoId = body?.sourceVideoId;
    if (typeof sourceVideoId !== 'string' || !sourceVideoId.trim() || sourceVideoId.length > 128)
      return apiErrors.badRequest('Source file required');

    const result = await mergeVideoIntoVersions({
      projectId,
      targetVideoId: videoId,
      sourceVideoId,
      userId: session.user.id,
      confirmationToken: body.confirmationToken,
    });

    if (!('needsConfirmation' in result)) {
      revalidatePath(`/projects/${projectId}`);
      const project = await db.project.findUnique({
        where: { id: projectId },
        select: { workspace: { select: { ownerId: true } } },
      });
      if (project) {
        await recordAccountActivity({
          name: 'VERSION_ADDED',
          accountId: project.workspace.ownerId,
          actorId: session.user.id,
        });
      }
    }
    return withCacheControl(successResponse(result), 'private, no-store');
  } catch (error) {
    if (error instanceof ContentError)
      return error.status === 403
        ? apiErrors.forbidden(error.message)
        : error.status === 404
          ? apiErrors.notFound('File')
          : error.status === 409
            ? apiErrors.conflict(error.message)
            : apiErrors.badRequest(error.message);
    logError('Error stacking versions:', error);
    return apiErrors.internalError('Failed to add the file as a version');
  }
}

export const POST = withApiToken('manage', handlePost);
