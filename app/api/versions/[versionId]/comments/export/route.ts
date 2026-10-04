import { getSession, withApiToken } from '@/lib/api-tokens';
import { checkVideoAccess } from '@/lib/content-access';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  buildCommentsCsv,
  buildExportFileBaseName,
  flattenCommentsForExport,
} from '@/lib/comment-export';
import { buildCommentsPdf } from '@/lib/comment-export-pdf';
import {
  buildNleComments,
  buildPanelMarkers,
  NLE_FORMATS,
  NleExportError,
  parseNleOptions,
  selectNleThreads,
  type NleExportOptions,
} from '@/lib/nle-comment-export';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { canDownloadProjectMedia } from '@/lib/project-download';
import { logError } from '@/lib/logger';
import { EDITOR_PLUGIN_VERSIONS } from '@/lib/editor-plugin-versions';

type RouteParams = { params: Promise<{ versionId: string }> };
const MAX_EXPORT_COMMENTS = 5000;

// GET /api/versions/[versionId]/comments/export?format=csv|pdf&includeResolved=true|false
// format=markers&fps=... returns JSON markers for the editor plugins.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'comment-export');
    if (limited) return limited;

    const session = await getSession();
    if (!session?.user?.id) {
      return apiErrors.unauthorized('Authentication required for exports');
    }

    const { versionId } = await params;
    const { searchParams } = new URL(request.url);

    const format = (searchParams.get('format') || 'csv').toLowerCase();
    if (!['csv', 'pdf', 'markers', ...NLE_FORMATS].includes(format)) {
      return apiErrors.badRequest('Invalid format. Use "csv", "pdf", "edl", "xml" or "markers"');
    }
    const nleFormat = NLE_FORMATS.find((candidate) => candidate === format);

    let nleOptions: NleExportOptions | undefined;
    if (format === 'markers') {
      // A plugin places markers by frame from the start of the timeline, so only the
      // rate matters; the origin and drop-frame labels never reach it.
      nleOptions = { fps: searchParams.get('fps') ?? '', origin: '00:00:00:00', dropFrame: false };
      parseNleOptions(nleOptions);
    } else if (nleFormat) {
      if (!['true', 'false'].includes(searchParams.get('dropFrame') ?? '')) {
        return apiErrors.badRequest(
          'Explicit fps, origin and dropFrame options are required for NLE exports.'
        );
      }
      nleOptions = {
        fps: searchParams.get('fps') ?? '',
        origin: searchParams.get('origin') ?? '',
        dropFrame: searchParams.get('dropFrame') === 'true',
      };
      parseNleOptions(nleOptions);
    }

    const includeResolved = searchParams.get('includeResolved') !== 'false';

    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        versionNumber: true,
        versionLabel: true,
        video: {
          select: {
            id: true,
            title: true,
            mediaType: true,
            project: {
              select: {
                id: true,
                ownerId: true,
                workspaceId: true,
                visibility: true,
                allowDownloads: true,
              },
            },
          },
        },
      },
    });

    if (!version) {
      return apiErrors.notFound('Version');
    }

    const access = await checkVideoAccess(version.video.id, session.user.id);

    if (!access.hasAccess) {
      return apiErrors.notFound('Version');
    }

    // The editor plugins put the review into the cut itself, so they follow the same
    // rule as downloading the media: editors always, everyone else only when the
    // project allows downloads.
    if (format === 'markers' && !canDownloadProjectMedia(version.video.project, access)) {
      return apiErrors.forbidden('You do not have access to send these comments to an editor');
    }

    if (nleOptions && version.video.mediaType !== 'VIDEO') {
      return apiErrors.badRequest('NLE exports require a video. Use CSV or PDF for images.');
    }

    // Count the same scope we emit: roots selected by the resolved filter and all
    // their direct replies. Resolved replies still belong to included threads.
    const rootFilter = { parentId: null, ...(includeResolved ? {} : { isResolved: false }) };
    const exportWhere = {
      versionId,
      OR: [rootFilter, { parent: { versionId, ...rootFilter } }],
    };
    // NLE must preserve arbitrary reply depth. Bound the whole version before
    // reading/filtering its parent graph; legacy CSV/PDF keep direct replies.
    const readWhere = nleOptions ? { versionId } : exportWhere;
    const totalComments = await db.comment.count({ where: readWhere });
    if (totalComments > MAX_EXPORT_COMMENTS) {
      return apiErrors.badRequest(
        `Too many comments to export (${totalComments}). Maximum allowed is ${MAX_EXPORT_COMMENTS}.`
      );
    }

    // A single bounded query also covers comments inserted after the count. A
    // nested take would bound each thread separately, not the whole export.
    const records = await db.comment.findMany({
      where: readWhere,
      take: MAX_EXPORT_COMMENTS + 1,
      orderBy: [{ timestamp: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        parentId: true,
        content: true,
        timestamp: true,
        timestampEnd: true,
        isResolved: true,
        voiceUrl: true,
        voiceDuration: true,
        imageUrl: true,
        annotationData: true,
        createdAt: true,
        author: { select: { name: true } },
        guestName: true,
        tag: { select: { name: true, color: true } },
      },
    });
    if (records.length > MAX_EXPORT_COMMENTS) {
      return apiErrors.badRequest(
        `Too many comments to export. Maximum allowed is ${MAX_EXPORT_COMMENTS}, including replies.`
      );
    }
    const repliesByParent = new Map<string, typeof records>();
    for (const record of records) {
      if (record.parentId !== null) {
        const replies = repliesByParent.get(record.parentId) ?? [];
        replies.push(record);
        repliesByParent.set(record.parentId, replies);
      }
    }
    const comments = records
      .filter((record) => record.parentId === null)
      .map((record) => ({
        ...record,
        replies: (repliesByParent.get(record.id) ?? []).sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
        ),
      }));

    const rows = nleOptions
      ? selectNleThreads(
          flattenCommentsForExport(records.map((record) => ({ ...record, replies: [] }))).map(
            (row, index) => ({
              ...row,
              parentCommentId: records[index].parentId,
              level: records[index].parentId === null ? 0 : 1,
            })
          ),
          includeResolved
        )
      : flattenCommentsForExport(comments);
    if (rows.length > MAX_EXPORT_COMMENTS) {
      return apiErrors.badRequest(
        `Too many comments to export. Maximum allowed is ${MAX_EXPORT_COMMENTS}, including replies.`
      );
    }
    const fileBaseName = buildExportFileBaseName(version.video.title, version.versionNumber);
    const versionMeta = {
      videoTitle: version.video.title,
      mediaType: version.video.mediaType,
      versionNumber: version.versionNumber,
      versionLabel: version.versionLabel,
    };

    if (format === 'markers' && nleOptions) {
      return withCacheControl(
        successResponse({
          videoTitle: version.video.title,
          versionNumber: version.versionNumber,
          versionLabel: version.versionLabel,
          fps: nleOptions.fps,
          markers: buildPanelMarkers(rows, nleOptions.fps),
          pluginVersions: EDITOR_PLUGIN_VERSIONS,
        }),
        'private, no-store'
      );
    }

    if (nleFormat && nleOptions) {
      return withCacheControl(
        new Response(buildNleComments(rows, version.video.title, nleFormat, nleOptions), {
          headers: {
            'Content-Type':
              nleFormat === 'edl' ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8',
            'Content-Disposition': `attachment; filename="${fileBaseName}.${format}"`,
            'X-Content-Type-Options': 'nosniff',
          },
        }),
        'private, no-store'
      );
    }

    if (format === 'csv') {
      const csv = buildCommentsCsv(rows, versionMeta);
      const response = new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileBaseName}.csv"`,
        },
      });

      return withCacheControl(response, 'private, no-store');
    }

    const pdfBytes = await buildCommentsPdf(rows, versionMeta);
    const response = new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileBaseName}.pdf"`,
      },
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof NleExportError) return apiErrors.badRequest(error.message);
    logError('Error exporting comments:', error);
    return apiErrors.internalError('Failed to export comments');
  }
}

export const GET = withApiToken('comments:read', handleGet);
