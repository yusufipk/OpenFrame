import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import { InvitationRole, InvitationScope, InvitationStatus, Prisma, ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';
import { db } from '@/lib/db';
import {
  brandedEmailTemplate,
  emailButton,
  emailHeading,
  emailHighlight,
  emailRow,
  escapeHtml,
} from '@/lib/email-brand';

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
  return scope === 'WORKSPACE' ? 'workspace' : 'project';
}

export function buildInvitationUrl(token: string, email: string): string {
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const url = new URL('/invitations/accept', baseUrl);
  url.searchParams.set('token', token);
  url.searchParams.set('email', email);
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
    console.warn('SMTP not configured — skipping invitation email');
    return false;
  }

  const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'OpenFrame <notifications@openframe.app>';
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
    console.error('Invitation email send failed:', error);
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
      <tr>${emailHeading('&#10003;', `${escapeHtml(input.scope.charAt(0).toUpperCase() + input.scope.slice(1))} Invitation`)}</tr>
      <tr><td style="padding:20px;">
        ${emailHighlight('You were invited to join OpenFrame.')}
        <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;">
          ${emailRow('Invited by', escapeHtml(input.inviterName), true)}
          ${emailRow('Target', `${escapeHtml(input.targetName)} (${escapeHtml(input.scope)})`, true)}
          ${emailRow('Role', escapeHtml(input.role))}
          ${emailRow('Expires', `${INVITATION_TTL_DAYS} days`)}
        </table>
        ${emailHighlight('Create an account (or sign in with this email) to accept this invitation.')}
        ${emailButton('Accept Invitation &#8594;', input.invitationUrl)}
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
      return await db.$transaction(async (tx) => {
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
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const isSerializationFailure = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
      if (!isSerializationFailure || attempt === MAX_INVITATION_RETRIES) {
        throw error;
      }
    }
  }

  throw new Error('Failed to create invitation after retrying');
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

async function applyInvitationMembership(tx: Prisma.TransactionClient, invitation: {
  id: string;
  role: InvitationRole;
  scope: InvitationScope;
  workspaceId: string | null;
  projectId: string | null;
}, userId: string) {
  if (invitation.scope === InvitationScope.WORKSPACE && invitation.workspaceId) {
    const workspace = await tx.workspace.findUnique({
      where: { id: invitation.workspaceId },
      select: { ownerId: true },
    });
    if (!workspace) return;

    if (workspace.ownerId !== userId) {
      await tx.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
        update: {
          role: invitation.role === InvitationRole.ADMIN
            ? WorkspaceMemberRole.ADMIN
            : WorkspaceMemberRole.COMMENTATOR,
        },
        create: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role === InvitationRole.ADMIN
            ? WorkspaceMemberRole.ADMIN
            : WorkspaceMemberRole.COMMENTATOR,
        },
      });
    }

    await acceptInvitation(tx, invitation.id);
    return;
  }

  if (invitation.scope === InvitationScope.PROJECT && invitation.projectId) {
    const project = await tx.project.findUnique({
      where: { id: invitation.projectId },
      select: { ownerId: true },
    });
    if (!project) return;

    if (project.ownerId !== userId) {
      await tx.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: invitation.projectId,
            userId,
          },
        },
        update: {
          role: invitation.role === InvitationRole.ADMIN
            ? ProjectMemberRole.ADMIN
            : ProjectMemberRole.COMMENTATOR,
        },
        create: {
          projectId: invitation.projectId,
          userId,
          role: invitation.role === InvitationRole.ADMIN
            ? ProjectMemberRole.ADMIN
            : ProjectMemberRole.COMMENTATOR,
        },
      });
    }

    await acceptInvitation(tx, invitation.id);
  }
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

    await applyInvitationMembership(tx, invitation, input.userId);
    return 'accepted';
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
