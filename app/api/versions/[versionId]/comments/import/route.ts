import { getSession, withApiToken } from '@/lib/api-tokens';
import { checkVideoAccess } from '@/lib/content-access';
import { notifyLiveReviewComments } from '@/lib/live-review/notify';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { checkRateLimit, rateLimit, rateLimitHeaders, RATE_LIMIT_CONFIGS } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { recordAccountActivity } from '@/lib/analytics/record';
import { logError } from '@/lib/logger';
import { EDITOR_PLUGIN_VERSIONS } from '@/lib/editor-plugin-versions';
import { importDedupeKey, parseImportRequest, planMarkerImport } from '@/lib/editor-marker-import';

type RouteParams = { params: Promise<{ versionId: string }> };

function clockTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// POST /api/versions/[versionId]/comments/import
// Body: { fps, markers: [{ startFrame, durationFrames, name, comments }] }
// The editor plugins send the editor's own timeline markers here, and each becomes a
// comment by the caller. A marker whose comment is already there is reported back
// as a duplicate rather than added again.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'comment-import');
    if (limited) return limited;

    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return apiErrors.unauthorized('Authentication required to send markers');
    }
    // One request can add hundreds of comments, so the limit also follows the
    // account, which cannot change IPs to get around it.
    const userLimit = RATE_LIMIT_CONFIGS['comment-import-user']!;
    const perUser = await checkRateLimit(userId, 'comment-import-user', userLimit);
    if (!perUser.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: rateLimitHeaders(perUser, userLimit.maxRequests) }
      );
    }

    const { versionId } = await params;
    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        duration: true,
        video: {
          select: {
            id: true,
            title: true,
            mediaType: true,
            project: {
              select: { name: true, ownerId: true, workspace: { select: { ownerId: true } } },
            },
          },
        },
      },
    });
    if (!version) {
      return apiErrors.notFound('Version');
    }

    const access = await checkVideoAccess(version.video.id, userId);
    if (!access.hasAccess) {
      return apiErrors.notFound('Version');
    }
    if (version.video.mediaType !== 'VIDEO') {
      return apiErrors.badRequest('Markers can only be added to a video');
    }

    const body = await request.json().catch(() => null);
    const parsed = parseImportRequest(body);
    if ('error' in parsed) {
      return apiErrors.badRequest(parsed.error);
    }

    const maxSeconds =
      typeof version.duration === 'number' && Number.isFinite(version.duration)
        ? version.duration
        : null;

    const plan = await db.$transaction(async (tx) => {
      // Two sends of the same timeline at once would both miss the other's rows.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`comment-import:${versionId}:${userId}`}, 715))`;
      const existing = await tx.comment.findMany({
        where: { versionId, authorId: userId, parentId: null },
        select: { timestamp: true, content: true },
      });
      const keys = new Set(
        existing.map((comment) => importDedupeKey(comment.timestamp, comment.content ?? ''))
      );
      const result = planMarkerImport(parsed, keys, maxSeconds);
      if (result.create.length > 0) {
        await tx.comment.createMany({
          data: result.create.map((comment) => ({
            versionId,
            authorId: userId,
            content: comment.content,
            timestamp: comment.timestamp,
            timestampEnd: comment.timestampEnd,
          })),
        });
      }
      return result;
    });

    const project = version.video.project;
    if (plan.create.length > 0) {
      // One notification for the whole timeline rather than one per marker.
      if (userId !== project.ownerId) {
        const first = plan.create[0];
        const baseUrl = process.env.NEXTAUTH_URL || '';
        notifyProjectOwner(project.ownerId, {
          type: 'new_comment',
          projectName: project.name,
          videoTitle: version.video.title || 'Untitled Video',
          commentAuthor: session.user.name || 'Someone',
          commentText:
            plan.create.length === 1
              ? first.content
              : `${plan.create.length} comments from their editing timeline, starting with: ${first.content}`,
          timestamp: clockTime(first.timestamp),
          mediaType: version.video.mediaType,
          url: `${baseUrl}/watch/${version.video.id}`,
        }).catch((err) => logError('Notification failed:', err));
      }
      await recordAccountActivity({
        name: 'COMMENT_ADDED',
        accountId: project.workspace.ownerId,
        actorId: userId,
      });
      await notifyLiveReviewComments(versionId);
    }

    return withCacheControl(
      successResponse(
        {
          created: plan.create.length,
          duplicates: plan.duplicates.length,
          skipped: plan.skipped,
          // Indexes of the sent markers that are now comments on the version, so a
          // plugin can mark exactly those as sent.
          accepted: [...plan.create.map((comment) => comment.index), ...plan.duplicates].sort(
            (a, b) => a - b
          ),
          pluginVersions: EDITOR_PLUGIN_VERSIONS,
        },
        plan.create.length > 0 ? 201 : 200
      ),
      'private, no-store'
    );
  } catch (error) {
    logError('Error importing markers:', error);
    return apiErrors.internalError('Failed to add the markers');
  }
}

// Either scope: `comments:import` is the narrow one the editor plugins' tokens carry.
export const POST = withApiToken(['comments:write', 'comments:import'], handlePost);
