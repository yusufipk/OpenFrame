import { NextRequest } from 'next/server';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { apiErrors, successResponse } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ feedbackId: string }> };

function extractImageFilenameFromProxyUrl(url: string): string | null {
  const match = url.match(/^\/api\/upload\/image\/([0-9a-f-]+\.[a-z0-9]+)$/i);
  return match ? match[1] : null;
}

// DELETE /api/admin/feedback/[feedbackId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.isAdmin) {
      return apiErrors.forbidden('Admin access required');
    }

    const { feedbackId } = await params;
    const userFeedbackDelegate = (
      db as unknown as {
        userFeedback?: {
          findUnique: (args: unknown) => Promise<{
            id: string;
            screenshotUrl: string | null;
            screenshots?: Array<{ url: string }>;
          } | null>;
          delete: (args: { where: { id: string } }) => Promise<{ id: string }>;
          findFirst: (args: {
            where: { screenshotUrl: string };
            select: { id: true };
          }) => Promise<{ id: string } | null>;
        };
        userFeedbackScreenshot?: {
          findFirst: (args: {
            where: { url: string };
            select: { id: true };
          }) => Promise<{ id: string } | null>;
        };
      }
    ).userFeedback;
    const userFeedbackScreenshotDelegate = (
      db as unknown as {
        userFeedbackScreenshot?: {
          findFirst: (args: {
            where: { url: string };
            select: { id: true };
          }) => Promise<{ id: string } | null>;
        };
      }
    ).userFeedbackScreenshot;

    if (!userFeedbackDelegate) {
      return apiErrors.internalError('Feedback model is not available yet');
    }

    let feedbackRecord = await userFeedbackDelegate
      .findUnique({
        where: { id: feedbackId },
        include: {
          screenshots: {
            select: { url: true },
          },
        },
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('Unknown field `screenshots`')) return null;
        throw error;
      });

    if (!feedbackRecord) {
      feedbackRecord = await userFeedbackDelegate.findUnique({
        where: { id: feedbackId },
      });
    }

    if (!feedbackRecord) {
      return apiErrors.notFound('Feedback');
    }

    const mediaUrls = new Set<string>();
    if (feedbackRecord.screenshotUrl) mediaUrls.add(feedbackRecord.screenshotUrl);
    (feedbackRecord.screenshots ?? []).forEach((item) => {
      if (item.url) mediaUrls.add(item.url);
    });

    await userFeedbackDelegate.delete({
      where: { id: feedbackId },
    });

    await Promise.all(
      Array.from(mediaUrls).map(async (url) => {
        const filename = extractImageFilenameFromProxyUrl(url);
        if (!filename) return;

        const [commentReferenced, feedbackReferenced, feedbackAttachmentReferenced] =
          await Promise.all([
            db.comment.findFirst({
              where: { imageUrl: url },
              select: { id: true },
            }),
            userFeedbackDelegate.findFirst({
              where: { screenshotUrl: url },
              select: { id: true },
            }),
            userFeedbackScreenshotDelegate
              ? userFeedbackScreenshotDelegate.findFirst({
                  where: { url },
                  select: { id: true },
                })
              : Promise.resolve(null),
          ]);

        if (commentReferenced || feedbackReferenced || feedbackAttachmentReferenced) return;

        await r2Client
          .send(
            new DeleteObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: `images/${filename}`,
            })
          )
          .catch(() => undefined);
      })
    );

    return successResponse({ id: feedbackId });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('Record to delete does not exist')) {
      return apiErrors.notFound('Feedback');
    }
    logError('Error deleting feedback:', error);
    return apiErrors.internalError('Failed to delete feedback');
  }
}
