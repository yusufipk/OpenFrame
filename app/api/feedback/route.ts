import { NextRequest } from 'next/server';
import { FeedbackCategory, FeedbackEntryType } from '@prisma/client';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { apiErrors, successResponse } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/logger';

interface FeedbackPayload {
  type?: string;
  category?: string;
  title?: string;
  message?: string;
  screenshotUrl?: string;
  screenshotUrls?: string[];
  rating?: number;
  allowShowcase?: boolean;
}

// POST /api/feedback
export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'feedback-submit');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized('You must be signed in to submit feedback');
    }

    const body = (await request.json()) as FeedbackPayload;
    const type = body.type;
    const title = body.title?.trim() ?? '';
    const message = body.message?.trim() ?? '';
    const legacyScreenshotUrl = body.screenshotUrl?.trim() ?? null;
    const screenshotUrls = Array.isArray(body.screenshotUrls)
      ? body.screenshotUrls
          .map((url) => (typeof url === 'string' ? url.trim() : ''))
          .filter((url) => !!url)
      : legacyScreenshotUrl
        ? [legacyScreenshotUrl]
        : [];

    if (type !== FeedbackEntryType.FEEDBACK && type !== FeedbackEntryType.REVIEW) {
      return apiErrors.badRequest('Invalid entry type');
    }

    if (title.length < 3 || title.length > 120) {
      return apiErrors.badRequest('Title must be between 3 and 120 characters');
    }

    if (message.length < 10 || message.length > 3000) {
      return apiErrors.badRequest('Message must be between 10 and 3000 characters');
    }

    if (screenshotUrls.length > 5) {
      return apiErrors.badRequest('You can upload up to 5 screenshots');
    }

    if (screenshotUrls.some((url) => !url.startsWith('/api/upload/image/'))) {
      return apiErrors.badRequest('Invalid screenshot URL(s)');
    }

    if (type === FeedbackEntryType.FEEDBACK) {
      if (
        body.category !== FeedbackCategory.BUG &&
        body.category !== FeedbackCategory.FEATURE &&
        body.category !== FeedbackCategory.OTHER
      ) {
        return apiErrors.badRequest('Feedback category is required');
      }
    }

    if (type === FeedbackEntryType.REVIEW) {
      if (
        !Number.isInteger(body.rating) ||
        (body.rating as number) < 1 ||
        (body.rating as number) > 5
      ) {
        return apiErrors.badRequest('Review rating must be between 1 and 5');
      }
    }

    let usedLegacyCreatePath = false;
    let entry: { id: string; type: FeedbackEntryType; createdAt: Date };

    try {
      entry = await db.userFeedback.create({
        data: {
          userId: session.user.id,
          type,
          category:
            type === FeedbackEntryType.FEEDBACK ? (body.category as FeedbackCategory) : null,
          title,
          message,
          screenshotUrl: type === FeedbackEntryType.FEEDBACK ? (screenshotUrls[0] ?? null) : null,
          rating: type === FeedbackEntryType.REVIEW ? body.rating : null,
          allowShowcase: type === FeedbackEntryType.REVIEW ? !!body.allowShowcase : false,
          screenshots:
            type === FeedbackEntryType.FEEDBACK
              ? {
                  create: screenshotUrls.map((url) => ({ url })),
                }
              : undefined,
        },
        select: {
          id: true,
          type: true,
          createdAt: true,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      if (!errorMessage.includes('Unknown argument `screenshots`')) {
        throw error;
      }

      usedLegacyCreatePath = true;
      entry = await db.userFeedback.create({
        data: {
          userId: session.user.id,
          type,
          category:
            type === FeedbackEntryType.FEEDBACK ? (body.category as FeedbackCategory) : null,
          title,
          message,
          screenshotUrl: type === FeedbackEntryType.FEEDBACK ? (screenshotUrls[0] ?? null) : null,
          rating: type === FeedbackEntryType.REVIEW ? body.rating : null,
          allowShowcase: type === FeedbackEntryType.REVIEW ? !!body.allowShowcase : false,
        },
        select: {
          id: true,
          type: true,
          createdAt: true,
        },
      });
    }

    if (usedLegacyCreatePath && type === FeedbackEntryType.FEEDBACK && screenshotUrls.length > 1) {
      const screenshotDelegate = (
        db as unknown as {
          userFeedbackScreenshot?: {
            createMany: (args: {
              data: Array<{ feedbackId: string; url: string }>;
            }) => Promise<unknown>;
          };
        }
      ).userFeedbackScreenshot;

      if (screenshotDelegate) {
        await screenshotDelegate
          .createMany({
            data: screenshotUrls.map((url) => ({
              feedbackId: entry.id,
              url,
            })),
          })
          .catch(() => undefined);
      }
    }

    return successResponse(entry, 201);
  } catch (error) {
    logError('Error submitting feedback:', error);
    return apiErrors.internalError('Failed to submit feedback');
  }
}
