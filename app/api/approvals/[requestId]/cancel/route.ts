import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ requestId: string }> };

function isSerializableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

// POST /api/approvals/[requestId]/cancel
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { requestId } = await params;
    const approvalRequest = await db.approvalRequest.findUnique({
      where: { id: requestId },
      include: {
        version: {
          include: {
            video: {
              include: {
                project: { select: { id: true, ownerId: true, workspaceId: true, visibility: true } },
              },
            },
          },
        },
      },
    });
    if (!approvalRequest) return apiErrors.notFound('Approval request');

    const access = await checkProjectAccess(approvalRequest.version.video.project, session.user.id, { intent: 'manage' });
    const canCancel = approvalRequest.requestedById === session.user.id || access.canEdit;
    if (!canCancel) return apiErrors.forbidden('Access denied');

    if (approvalRequest.status !== 'PENDING') {
      return apiErrors.conflict('Only pending approval requests can be canceled');
    }

    const updated = await db.$transaction(async (tx) => {
      const current = await tx.approvalRequest.findUnique({
        where: { id: requestId },
        select: { status: true },
      });
      if (!current) throw new Error('__NOT_FOUND__');
      if (current.status !== 'PENDING') throw new Error('__NOT_PENDING__');

      return tx.approvalRequest.update({
        where: { id: requestId },
        data: {
          status: 'CANCELED',
          canceledAt: new Date(),
          canceledById: session.user.id,
        },
        include: {
          requestedBy: { select: { id: true, name: true, email: true, image: true } },
          canceledBy: { select: { id: true, name: true, email: true, image: true } },
          decisions: {
            orderBy: { createdAt: 'asc' },
            include: { approver: { select: { id: true, name: true, email: true, image: true } } },
          },
        },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });

    const response = successResponse({ request: updated });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === '__NOT_PENDING__') {
        return apiErrors.conflict('Only pending approval requests can be canceled');
      }
      if (error.message === '__NOT_FOUND__') {
        return apiErrors.notFound('Approval request');
      }
    }
    if (isSerializableConflict(error)) {
      return apiErrors.conflict('Request state changed. Please try again.');
    }
    logError('Error canceling approval request:', error);
    return apiErrors.internalError('Failed to cancel approval request');
  }
}
