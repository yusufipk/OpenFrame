import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { getApprovalCandidatesForProject } from '@/lib/approval-workflow';
import { notifyUsers } from '@/lib/notifications';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';

type RouteParams = { params: Promise<{ versionId: string }> };

function isSerializableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

// GET /api/versions/[versionId]/approvals
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { versionId } = await params;
    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: { select: { id: true, ownerId: true, workspaceId: true, visibility: true } },
          },
        },
      },
    });
    if (!version) return apiErrors.notFound('Version');

    const access = await checkProjectAccess(version.video.project, session.user.id);
    const hasMembership = access.isOwner || access.isProjectMember || access.isWorkspaceMember;
    if (!hasMembership) return apiErrors.forbidden('Access denied');

    const requests = await db.approvalRequest.findMany({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
      include: {
        requestedBy: { select: { id: true, name: true, email: true, image: true } },
        canceledBy: { select: { id: true, name: true, email: true, image: true } },
        decisions: {
          orderBy: { createdAt: 'asc' },
          include: {
            approver: { select: { id: true, name: true, email: true, image: true } },
          },
        },
      },
    });

    const response = successResponse({ requests });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    console.error('Error fetching approvals:', error);
    return apiErrors.internalError('Failed to fetch approvals');
  }
}

// POST /api/versions/[versionId]/approvals
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { versionId } = await params;
    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: { select: { id: true, name: true, ownerId: true, workspaceId: true, visibility: true } },
          },
        },
      },
    });
    if (!version) return apiErrors.notFound('Version');

    const access = await checkProjectAccess(version.video.project, session.user.id, { intent: 'manage' });
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => ({})) as { approverIds?: unknown; message?: unknown };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message.length > 2000) {
      return apiErrors.badRequest('Message must be 2000 characters or fewer');
    }

    const rawApproverIds = Array.isArray(body.approverIds) ? body.approverIds : [];
    const approverIds = Array.from(new Set(
      rawApproverIds
        .filter((approverId): approverId is string => typeof approverId === 'string' && approverId.trim().length > 0)
        .map((approverId) => approverId.trim())
    ));

    if (approverIds.length === 0) {
      return apiErrors.badRequest('At least one approver is required');
    }

    if (approverIds.includes(session.user.id)) {
      return apiErrors.badRequest('Requester cannot be an approver');
    }

    const candidates = await getApprovalCandidatesForProject(version.video.project.id);
    if (!candidates) return apiErrors.notFound('Project');
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));

    if (approverIds.some((id) => !candidateIds.has(id))) {
      return apiErrors.badRequest('One or more approvers are not eligible for this project');
    }

    const created = await db.$transaction(async (tx) => {
      const existingPending = await tx.approvalRequest.findFirst({
        where: { versionId, status: 'PENDING' },
        select: { id: true },
      });
      if (existingPending) {
        throw new Error('__PENDING_REQUEST_EXISTS__');
      }

      return tx.approvalRequest.create({
        data: {
          versionId,
          requestedById: session.user.id,
          message: message || null,
          decisions: {
            createMany: {
              data: approverIds.map((approverId) => ({
              approverId,
              status: 'PENDING',
              })),
            },
          },
        },
        include: {
          requestedBy: { select: { id: true, name: true, email: true, image: true } },
          canceledBy: { select: { id: true, name: true, email: true, image: true } },
          decisions: {
            orderBy: { createdAt: 'asc' },
            include: {
              approver: { select: { id: true, name: true, email: true, image: true } },
            },
          },
        },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });

    const requesterName = session.user.name || 'A team member';
    const versionLabel = version.versionLabel || `Version ${version.versionNumber}`;
    const baseUrl = process.env.NEXTAUTH_URL || '';
    const requestUrl = `${baseUrl}/projects/${version.video.project.id}/videos/${version.video.id}`;

    notifyUsers(approverIds, {
      type: 'approval_requested',
      projectName: version.video.project.name,
      videoTitle: version.video.title,
      versionLabel,
      requestedBy: requesterName,
      message: message || undefined,
      url: requestUrl,
    }).catch((error) => {
      console.error('Approval request notification failed:', error);
    });

    const response = successResponse({ request: created }, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    if (error instanceof Error && error.message === '__PENDING_REQUEST_EXISTS__') {
      return apiErrors.conflict('An approval request is already pending for this version');
    }
    if (isSerializableConflict(error)) {
      return apiErrors.conflict('Request state changed. Please try again.');
    }
    console.error('Error creating approval request:', error);
    return apiErrors.internalError('Failed to create approval request');
  }
}
