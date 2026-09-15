import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import {
  InvitationRole,
  InvitationScope,
  InvitationStatus,
  Prisma,
  ProjectMemberRole,
  WorkspaceMemberRole,
} from '@prisma/client';
import { db } from '@/lib/db';
import {
  brandedEmailTemplate,
  emailButton,
  emailHeading,
  emailHighlight,
  emailRow,
} from '@/lib/email-brand';
import { logError } from '@/lib/logger';

const INVITATION_TTL_DAYS = 7;
const MAX_INVITATION_RETRIES = 3;

function createSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function roleLabel(role: InvitationRole): string {
  return role === 'ADMIN' ? 'Admin' : 'Commentator';
}

function scopeLabel(scope: InvitationScope): string {
  return scope.toLowerCase();
}

export function buildInvitationUrl(token: string): string {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const url = new URL('/invitations/accept', baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export async function sendInvitationEmail(input: {
  to: string;
  inviterName: string;
  role: InvitationRole;
  scope: InvitationScope;
  targetName: string;
  invitationUrl: string;
}): Promise<boolean> {
  const transporter = createSmtpTransport();
  if (!transporter) {
    console.warn('SMTP not configured, skipping invitation email');
    return false;
  }

  const fromAddress =
    process.env.SMTP_FROM || process.env.EMAIL_FROM || 'OpenFrame <info@open-frame.net>';
  const subject = `[OpenFrame] You were invited to a ${scopeLabel(input.scope)}: ${input.targetName}`;
  const html = invitationEmailTemplate({
    inviterName: input.inviterName,
    role: roleLabel(input.role),
    scope: scopeLabel(input.scope),
    targetName: input.targetName,
    invitationUrl: input.invitationUrl,
  });

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: input.to,
      subject,
      html,
    });
    return true;
  } catch (error) {
    logError('Invitation email send failed:', error);
    return false;
  }
}

function invitationEmailTemplate(input: {
  inviterName: string;
  role: string;
  scope: string;
  targetName: string;
  invitationUrl: string;
}): string {
  return brandedEmailTemplate(
    `
      <tr>${emailHeading('✓', `${input.scope.charAt(0).toUpperCase() + input.scope.slice(1)} Invitation`)}</tr>
      <tr><td style="padding:20px;">
        ${emailHighlight('You were invited to join OpenFrame.')}
        <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;">
          ${emailRow('Invited by', input.inviterName, true)}
          ${emailRow('Target', `${input.targetName} (${input.scope})`, true)}
          ${emailRow('Role', input.role)}
          ${emailRow('Expires', `${INVITATION_TTL_DAYS} days`)}
        </table>
        ${emailHighlight('Create an account (or sign in with this email) to accept this invitation.')}
        ${emailButton('Accept Invitation →', input.invitationUrl)}
      </td></tr>
    `,
    {
      footerText: `This invitation expires in ${INVITATION_TTL_DAYS} days.`,
    }
  );
}

export async function createOrRefreshInvitation(params: {
  email: string;
  scope: InvitationScope;
  role: InvitationRole;
  invitedById: string;
  workspaceId?: string;
  projectId?: string;
}) {
  const normalizedEmail = params.email.toLowerCase().trim();

  for (let attempt = 1; attempt <= MAX_INVITATION_RETRIES; attempt++) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const token = randomBytes(32).toString('hex');

    try {
      return await db.$transaction(
        async (tx) => {
          await tx.invitation.updateMany({
            where: {
              email: normalizedEmail,
              scope: params.scope,
              workspaceId: params.workspaceId ?? null,
              projectId: params.projectId ?? null,
              status: InvitationStatus.PENDING,
              expiresAt: { lte: now },
            },
            data: {
              status: InvitationStatus.EXPIRED,
            },
          });

          const existingPending = await tx.invitation.findFirst({
            where: {
              email: normalizedEmail,
              scope: params.scope,
              workspaceId: params.workspaceId ?? null,
              projectId: params.projectId ?? null,
              status: InvitationStatus.PENDING,
              expiresAt: { gt: now },
            },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          });

          if (existingPending) {
            await tx.invitation.updateMany({
              where: {
                email: normalizedEmail,
                scope: params.scope,
                workspaceId: params.workspaceId ?? null,
                projectId: params.projectId ?? null,
                status: InvitationStatus.PENDING,
                id: { not: existingPending.id },
              },
              data: {
                status: InvitationStatus.CANCELED,
              },
            });

            return tx.invitation.update({
              where: { id: existingPending.id },
              data: {
                role: params.role,
                invitedById: params.invitedById,
                token,
                expiresAt,
              },
            });
          }

          return tx.invitation.create({
            data: {
              email: normalizedEmail,
              scope: params.scope,
              role: params.role,
              invitedById: params.invitedById,
              workspaceId: params.workspaceId ?? null,
              projectId: params.projectId ?? null,
              token,
              expiresAt,
              status: InvitationStatus.PENDING,
            },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }
      );
    } catch (error) {
      const isSerializationFailure =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
      if (!isSerializationFailure || attempt === MAX_INVITATION_RETRIES) {
        throw error;
      }
    }
  }

  throw new Error('Failed to create invitation after retrying');
}

export interface InvitationPreview {
  email: string;
  role: InvitationRole;
  roleLabel: string;
  scope: InvitationScope;
  scopeLabel: string;
  status: InvitationStatus;
  /** PENDING but past its expiry, the DB row is only flipped to EXPIRED on acceptance. */
  isExpired: boolean;
  inviterName: string;
  targetName: string | null;
  /** Whether an account already exists for the invited address. */
  hasAccount: boolean;
}

/**
 * Public-facing summary of an invitation, safe to render to a signed-out visitor:
 * the token itself is the secret, and everything here was already in the email we sent
 * to that address.
 */
export async function getInvitationPreviewByToken(
  token: string
): Promise<InvitationPreview | null> {
  const invitation = await db.invitation.findUnique({
    where: { token },
    select: {
      email: true,
      role: true,
      scope: true,
      status: true,
      expiresAt: true,
      invitedBy: { select: { name: true } },
      workspace: { select: { name: true } },
      project: { select: { name: true } },
      folder: { select: { name: true } },
      video: { select: { title: true } },
    },
  });

  if (!invitation) return null;

  const existingUser = await db.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });

  return {
    email: invitation.email,
    role: invitation.role,
    roleLabel: roleLabel(invitation.role),
    scope: invitation.scope,
    scopeLabel: scopeLabel(invitation.scope),
    status: invitation.status,
    isExpired: invitation.expiresAt <= new Date(),
    inviterName: invitation.invitedBy?.name?.trim() || 'A team member',
    targetName:
      invitation.folder?.name ??
      invitation.video?.title ??
      invitation.workspace?.name ??
      invitation.project?.name ??
      null,
    hasAccount: Boolean(existingUser),
  };
}

export async function getValidInvitationByToken(token: string) {
  const now = new Date();
  return db.invitation.findFirst({
    where: {
      token,
      status: InvitationStatus.PENDING,
      expiresAt: { gt: now },
    },
  });
}

async function acceptInvitation(tx: Prisma.TransactionClient, invitationId: string) {
  await tx.invitation.update({
    where: { id: invitationId },
    data: {
      status: InvitationStatus.ACCEPTED,
      acceptedAt: new Date(),
    },
  });
}

/**
 * Applies the invited membership and marks the invitation accepted.
 *
 * Returns false when the invitation grants nothing: a scoped row whose target id is null,
 * or one pointing at a workspace or project that no longer exists. The invitation is left
 * PENDING in that case, so the caller can report the failure rather than show a success
 * screen for a no-op the user has no way to detect.
 *
 * An existing membership is never downgraded. Applying the invited role unconditionally
 * turned an invitation into a privilege-change primitive: re-invite a sitting ADMIN as a
 * COMMENTATOR, get them to click the link once, and they are demoted.
 */
async function applyInvitationMembership(
  tx: Prisma.TransactionClient,
  invitation: {
    id: string;
    role: InvitationRole;
    scope: InvitationScope;
    workspaceId: string | null;
    projectId: string | null;
    folderId?: string | null;
    videoId?: string | null;
  },
  userId: string
): Promise<boolean> {
  const invitedAsAdmin = invitation.role === InvitationRole.ADMIN;
  if (invitation.scope === 'FOLDER' || invitation.scope === 'VIDEO') {
    // Atomically claim a pending invitation before granting access; cancellation wins if already committed.
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    if (claimed.count !== 1) return false;
    if (invitation.scope === 'FOLDER' && invitation.folderId) {
      await tx.projectFolderMember.upsert({
        where: { folderId_userId: { folderId: invitation.folderId, userId } },
        create: { folderId: invitation.folderId, userId, role: invitation.role },
        update: invitedAsAdmin ? { role: 'ADMIN' } : {},
      });
      return true;
    }
    if (invitation.scope === 'VIDEO' && invitation.videoId) {
      await tx.videoMember.upsert({
        where: { videoId_userId: { videoId: invitation.videoId, userId } },
        create: { videoId: invitation.videoId, userId, role: invitation.role },
        update: invitedAsAdmin ? { role: 'ADMIN' } : {},
      });
      return true;
    }
    throw new Error('Invitation target is missing');
  }

  if (invitation.scope === InvitationScope.WORKSPACE) {
    if (!invitation.workspaceId) return false;

    const workspace = await tx.workspace.findUnique({
      where: { id: invitation.workspaceId },
      select: { ownerId: true },
    });
    if (!workspace) return false;

    if (workspace.ownerId !== userId) {
      await tx.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
        // Only ever a promotion. An empty update leaves a sitting ADMIN as they were.
        update: invitedAsAdmin ? { role: WorkspaceMemberRole.ADMIN } : {},
        create: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitedAsAdmin ? WorkspaceMemberRole.ADMIN : WorkspaceMemberRole.COMMENTATOR,
        },
      });
    }

    await acceptInvitation(tx, invitation.id);
    return true;
  }

  if (invitation.scope === InvitationScope.PROJECT) {
    if (!invitation.projectId) return false;

    const project = await tx.project.findUnique({
      where: { id: invitation.projectId },
      select: { ownerId: true },
    });
    if (!project) return false;

    if (project.ownerId !== userId) {
      await tx.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: invitation.projectId,
            userId,
          },
        },
        update: invitedAsAdmin ? { role: ProjectMemberRole.ADMIN } : {},
        create: {
          projectId: invitation.projectId,
          userId,
          role: invitedAsAdmin ? ProjectMemberRole.ADMIN : ProjectMemberRole.COMMENTATOR,
        },
      });
    }

    await acceptInvitation(tx, invitation.id);
    return true;
  }

  return false;
}

export async function acceptInvitationTokenForUser(input: {
  token: string;
  userId: string;
  email: string;
}): Promise<'accepted' | 'not_found' | 'forbidden' | 'expired'> {
  const normalizedEmail = input.email.toLowerCase().trim();
  const now = new Date();

  return db.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { token: input.token },
    });

    if (!invitation) return 'not_found';
    if (invitation.email !== normalizedEmail) return 'forbidden';
    if (invitation.status !== InvitationStatus.PENDING) return 'not_found';
    if (invitation.expiresAt <= now) {
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.EXPIRED },
      });
      return 'expired';
    }

    const applied = await applyInvitationMembership(tx, invitation, input.userId);
    // A scoped invitation pointing at nothing grants no membership. Reporting 'accepted'
    // for it showed a success screen for a no-op and left the row PENDING for good.
    return applied ? 'accepted' : 'not_found';
  });
}

export async function acceptPendingInvitationsForUser(userId: string, email: string) {
  const normalizedEmail = email.toLowerCase().trim();
  const now = new Date();

  await db.$transaction(async (tx) => {
    await tx.invitation.updateMany({
      where: {
        email: normalizedEmail,
        status: InvitationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: {
        status: InvitationStatus.EXPIRED,
      },
    });

    const pendingInvitations = await tx.invitation.findMany({
      where: {
        email: normalizedEmail,
        status: InvitationStatus.PENDING,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const invitation of pendingInvitations) {
      await applyInvitationMembership(tx, invitation, userId);
    }
  });
}
