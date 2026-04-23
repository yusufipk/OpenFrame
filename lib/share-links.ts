import bcrypt from 'bcryptjs';
import type { ShareLink, SharePermission } from '@prisma/client';
import { db } from '@/lib/db';
import { hasBillingAccess } from '@/lib/billing';

export const MAX_SHARE_PASSWORD_LENGTH = 128;

interface ValidateShareLinkParams {
  token: string;
  projectId: string;
  videoId?: string;
  requiredPermission?: SharePermission;
  presentedPassword?: string;
  passwordVerified?: boolean;
}

export interface ShareLinkAccessResult {
  hasAccess: boolean;
  canComment: boolean;
  canDownload: boolean;
  allowGuests: boolean;
  requiresPassword: boolean;
  link: ShareLink | null;
}

function hasRequiredPermission(actual: SharePermission, required: SharePermission): boolean {
  if (required === 'VIEW') return actual === 'VIEW' || actual === 'COMMENT';
  return actual === 'COMMENT';
}

function isLinkExpired(link: ShareLink): boolean {
  if (!link.expiresAt) return false;
  return link.expiresAt.getTime() <= Date.now();
}

export async function validateShareLinkAccess({
  token,
  projectId,
  videoId,
  requiredPermission = 'VIEW',
  presentedPassword,
  passwordVerified = false,
}: ValidateShareLinkParams): Promise<ShareLinkAccessResult> {
  const link = await db.shareLink.findUnique({
    where: { token },
    include: {
      project: {
        select: {
          workspace: {
            select: {
              owner: {
                select: {
                  subscriptionStatus: true,
                  trialEndsAt: true,
                  stripeCurrentPeriodEnd: true,
                  billingAccessEndedAt: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!link) {
    return {
      hasAccess: false,
      canComment: false,
      canDownload: false,
      allowGuests: false,
      requiresPassword: false,
      link: null,
    };
  }

  const projectMatches = link.projectId === projectId;
  // When a specific video is requested, require the link to be scoped to that exact video.
  const videoMatches = videoId === undefined ? link.videoId === null : link.videoId === videoId;
  const permissionMatches = hasRequiredPermission(link.permission, requiredPermission);

  if (!projectMatches || !videoMatches || !permissionMatches || isLinkExpired(link)) {
    return {
      hasAccess: false,
      canComment: false,
      canDownload: false,
      allowGuests: false,
      requiresPassword: false,
      link,
    };
  }

  if (!link.project?.workspace.owner || !hasBillingAccess(link.project.workspace.owner)) {
    return {
      hasAccess: false,
      canComment: false,
      canDownload: false,
      allowGuests: false,
      requiresPassword: false,
      link,
    };
  }

  if (link.passwordHash && !passwordVerified) {
    if (!presentedPassword) {
      return {
        hasAccess: false,
        canComment: false,
        canDownload: false,
        allowGuests: false,
        requiresPassword: true,
        link,
      };
    }

    if (presentedPassword.length > MAX_SHARE_PASSWORD_LENGTH) {
      return {
        hasAccess: false,
        canComment: false,
        canDownload: false,
        allowGuests: false,
        requiresPassword: true,
        link,
      };
    }

    const isPasswordValid = await bcrypt.compare(presentedPassword, link.passwordHash);
    if (!isPasswordValid) {
      return {
        hasAccess: false,
        canComment: false,
        canDownload: false,
        allowGuests: false,
        requiresPassword: true,
        link,
      };
    }
  }

  return {
    hasAccess: true,
    canComment: link.permission === 'COMMENT',
    canDownload: link.allowDownloads,
    allowGuests: link.allowGuests,
    requiresPassword: false,
    link,
  };
}
