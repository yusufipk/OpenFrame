import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { notifyUsers } from '@/lib/notifications';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ requestId: string }> };

function isSerializableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

// POST /api/approvals/[requestId]/decision
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { requestId } = await params;
    const body = await request.json().catch(() => ({}));
    const decision = body.decision;
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      return apiErrors.badRequest('Decision must be APPROVED or REJECTED');
    }

    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 2000) {
      return apiErrors.badRequest('Note must be 2000 characters or fewer');
    }

    const approvalRequest = await db.approvalRequest.findUnique({
      where: { id: requestId },
      include: {
        version: {
          include: {
            video: {
              include: {
                project: {
                  select: {
                    id: true,
                    name: true,
                    ownerId: true,
                    workspaceId: true,
                    visibility: true,
                  },
                },
              },
            },
          },
        },
        decisions: {
          where: { approverId: session.user.id },
          select: { id: true, status: true },
        },
      },
    });
    if (!approvalRequest) return apiErrors.notFound('Approval request');

    const access = await checkProjectAccess(approvalRequest.version.video.project, session.user.id);
    if (!access.hasAccess) return apiErrors.forbidden('Access denied');

    const myDecision = approvalRequest.decisions[0];
    if (!myDecision) return apiErrors.forbidden('You are not an approver on this request');
    if (approvalRequest.status !== 'PENDING') {
      return apiErrors.conflict('This approval request is no longer pending');
    }
    if (myDecision.status !== 'PENDING') {
      return apiErrors.conflict('You have already responded to this request');
    }

    const updated = await db.$transaction(
      async (tx) => {
        const currentRequest = await tx.approvalRequest.findUnique({
          where: { id: requestId },
          include: {
            decisions: {
              orderBy: { createdAt: 'asc' },
              include: {
                approver: { select: { id: true, name: true, email: true, image: true } },
              },
            },
            requestedBy: { select: { id: true, name: true, email: true, image: true } },
            version: {
              include: {
                video: {
                  include: {
                    project: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        });
        if (!currentRequest) {
          throw new Error('__NOT_FOUND__');
        }
        if (currentRequest.status !== 'PENDING') {
          throw new Error('__NOT_PENDING__');
        }

        const decisionRow = await tx.approvalDecision.findUnique({
          where: { requestId_approverId: { requestId, approverId: session.user.id } },
          select: { status: true },
        });
        if (!decisionRow) throw new Error('__NOT_APPROVER__');
        if (decisionRow.status !== 'PENDING') throw new Error('__ALREADY_RESPONDED__');

        await tx.approvalDecision.update({
          where: { requestId_approverId: { requestId, approverId: session.user.id } },
          data: {
            status: decision,
            note: note || null,
            respondedAt: new Date(),
          },
        });

        if (decision === 'REJECTED') {
          await tx.approvalRequest.update({
            where: { id: requestId },
            data: {
              status: 'REJECTED',
              resolvedAt: new Date(),
            },
          });
        } else {
          const pendingCount = await tx.approvalDecision.count({
            where: { requestId, status: 'PENDING' },
          });
          const rejectedCount = await tx.approvalDecision.count({
            where: { requestId, status: 'REJECTED' },
          });
          if (pendingCount === 0 && rejectedCount === 0) {
            await tx.approvalRequest.update({
              where: { id: requestId },
              data: {
                status: 'APPROVED',
                resolvedAt: new Date(),
              },
            });
          }
        }

        return tx.approvalRequest.findUnique({
          where: { id: requestId },
          include: {
            requestedBy: { select: { id: true, name: true, email: true, image: true } },
            canceledBy: { select: { id: true, name: true, email: true, image: true } },
            decisions: {
              orderBy: { createdAt: 'asc' },
              include: {
                approver: { select: { id: true, name: true, email: true, image: true } },
              },
            },
            version: {
              include: {
                video: {
                  include: {
                    project: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }
    );

    if (!updated) return apiErrors.notFound('Approval request');

    const actorName = session.user.name || 'A team member';
    const versionLabel = updated.version.versionLabel || `Version ${updated.version.versionNumber}`;
    const baseUrl = process.env.NEXTAUTH_URL || '';
    const requestUrl = `${baseUrl}/projects/${updated.version.video.project.id}/videos/${updated.version.video.id}`;

    notifyUsers([updated.requestedById], {
      type: 'approval_action',
      projectName: updated.version.video.project.name,
      videoTitle: updated.version.video.title,
      versionLabel,
      actorName,
      action: decision === 'APPROVED' ? 'approved' : 'rejected',
      note: note || undefined,
      url: requestUrl,
    }).catch((error) => {
      logError('Approval action notification failed:', error);
    });

    if (updated.status === 'APPROVED') {
      notifyUsers([updated.requestedById], {
        type: 'approval_completed',
        projectName: updated.version.video.project.name,
        videoTitle: updated.version.video.title,
        versionLabel,
        approvedByCount: updated.decisions.filter((item) => item.status === 'APPROVED').length,
        url: requestUrl,
      }).catch((error) => {
        logError('Approval completed notification failed:', error);
      });
    } else if (updated.status === 'REJECTED') {
      notifyUsers([updated.requestedById], {
        type: 'approval_rejected',
        projectName: updated.version.video.project.name,
        videoTitle: updated.version.video.title,
        versionLabel,
        rejectedBy: actorName,
        note: note || undefined,
        url: requestUrl,
      }).catch((error) => {
        logError('Approval rejected notification failed:', error);
      });
    }

    const response = successResponse({ request: updated });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === '__NOT_PENDING__')
        return apiErrors.conflict('This approval request is no longer pending');
      if (error.message === '__ALREADY_RESPONDED__')
        return apiErrors.conflict('You have already responded to this request');
      if (error.message === '__NOT_APPROVER__')
        return apiErrors.forbidden('You are not an approver on this request');
      if (error.message === '__NOT_FOUND__') return apiErrors.notFound('Approval request');
    }
    if (isSerializableConflict(error)) {
      return apiErrors.conflict('Request state changed. Please try again.');
    }
    logError('Error responding to approval request:', error);
    return apiErrors.internalError('Failed to respond to approval request');
  }
}
