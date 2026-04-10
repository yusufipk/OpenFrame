import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  buildCommentsCsv,
  buildCommentsPdf,
  buildExportFileBaseName,
  flattenCommentsForExport,
} from '@/lib/comment-export';
import { apiErrors, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ versionId: string }> };
const MAX_EXPORT_COMMENTS = 5000;

// GET /api/versions/[versionId]/comments/export?format=csv|pdf&includeResolved=true|false
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'comment-export');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized('Authentication required for exports');
    }

    const { versionId } = await params;
    const { searchParams } = new URL(request.url);

    const format = (searchParams.get('format') || 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'pdf') {
      return apiErrors.badRequest('Invalid format. Use "csv" or "pdf"');
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
            title: true,
            project: {
              select: {
                id: true,
                ownerId: true,
                workspaceId: true,
                visibility: true,
              },
            },
          },
        },
      },
    });

    if (!version) {
      return apiErrors.notFound('Version');
    }

    const project = version.video.project;
    const access = await checkProjectAccess(project, session.user.id);

    if (!access.hasAccess) {
      return apiErrors.notFound('Version');
    }

    const totalComments = await db.comment.count({
      where: {
        versionId,
        ...(includeResolved ? {} : { isResolved: false }),
      },
    });
    if (totalComments > MAX_EXPORT_COMMENTS) {
      return apiErrors.badRequest(
        `Too many comments to export (${totalComments}). Maximum allowed is ${MAX_EXPORT_COMMENTS}.`
      );
    }

    const comments = await db.comment.findMany({
      where: {
        versionId,
        parentId: null,
        ...(includeResolved ? {} : { isResolved: false }),
      },
      orderBy: { timestamp: 'asc' },
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
        tag: { select: { name: true } },
        replies: {
          orderBy: { createdAt: 'asc' },
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
            tag: { select: { name: true } },
          },
        },
      },
    });

    const rows = flattenCommentsForExport(comments);
    const fileBaseName = buildExportFileBaseName(version.video.title, version.versionNumber);
    const versionMeta = {
      videoTitle: version.video.title,
      versionNumber: version.versionNumber,
      versionLabel: version.versionLabel,
    };

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

    const pdf = buildCommentsPdf(rows, versionMeta);
    const pdfBytes = Uint8Array.from(pdf);
    const response = new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileBaseName}.pdf"`,
      },
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error exporting comments:', error);
    return apiErrors.internalError('Failed to export comments');
  }
}
