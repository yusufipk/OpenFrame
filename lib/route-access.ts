import { notFound, redirect } from 'next/navigation';
import { auth, checkProjectAccess, checkWorkspaceAccess } from '@/lib/auth';
import { buildBillingAccessWhereInput, hasBillingAccess } from '@/lib/billing';
import { db } from '@/lib/db';

type AccessIntent = 'view' | 'manage';

const LOGIN_REDIRECT = '/login';
const FORBIDDEN_REDIRECT = '/dashboard';
const BILLING_REDIRECT = '/settings';

function redirectForMissingAuth() {
  redirect(LOGIN_REDIRECT);
}

function redirectForForbidden() {
  redirect(FORBIDDEN_REDIRECT);
}

function redirectForBilling() {
  redirect(BILLING_REDIRECT);
}

function ensureGuestPolicy(options: { userId?: string; intent: AccessIntent; allowPublicView: boolean }) {
  const { userId, intent, allowPublicView } = options;
  if (userId) return;

  if (intent !== 'view' || !allowPublicView) {
    redirectForMissingAuth();
  }
}

async function assertProjectAccessOrRedirect(
  project: { id: string; ownerId: string; workspaceId: string; visibility: string },
  options: {
    userId?: string;
    intent: AccessIntent;
    allowPublicView: boolean;
  }
) {
  const { userId, intent, allowPublicView } = options;

  ensureGuestPolicy({ userId, intent, allowPublicView });

  const access = await checkProjectAccess(project, userId, { intent });

  if (!access.hasAccess) {
    if (!userId) {
      redirectForMissingAuth();
    }
    redirectForForbidden();
  }

  if (intent === 'manage' && !access.canEdit) {
    redirectForForbidden();
  }

  return access;
}

export async function requireAuthOrRedirect() {
  const session = await auth();
  if (!session?.user?.id) {
    redirectForMissingAuth();
  }
  return session;
}

export async function requireBillingAccessOrRedirect(options?: {
  userId?: string;
}) {
  const resolvedUserId = options?.userId ?? (await auth())?.user?.id;

  if (!resolvedUserId) {
    redirectForMissingAuth();
  }

  const user = await db.user.findUnique({
    where: { id: resolvedUserId },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      stripeCurrentPeriodEnd: true,
      billingAccessEndedAt: true,
    },
  });

  if (!user || !hasBillingAccess(user)) {
    redirectForBilling();
  }

  return user;
}

export async function hasCollaboratorBillingBackedAccess(userId: string) {
  const now = new Date();

  const [workspaceCount, projectCount] = await Promise.all([
    db.workspace.count({
      where: {
        owner: buildBillingAccessWhereInput(now),
        OR: [
          { ownerId: userId },
          { members: { some: { userId } } },
        ],
      },
    }),
    db.project.count({
      where: {
        workspace: {
          owner: buildBillingAccessWhereInput(now),
        },
        OR: [
          { ownerId: userId },
          { members: { some: { userId } } },
          { workspace: { members: { some: { userId } } } },
        ],
      },
    }),
  ]);

  return workspaceCount > 0 || projectCount > 0;
}

export async function hasAppNavigationAccess(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      stripeCurrentPeriodEnd: true,
      billingAccessEndedAt: true,
    },
  });

  if (user && hasBillingAccess(user)) {
    return true;
  }

  return hasCollaboratorBillingBackedAccess(userId);
}

export async function requireWorkspaceAccessOrRedirect(options: {
  workspaceId: string;
  userId?: string;
  intent?: AccessIntent;
}) {
  const { workspaceId, userId, intent = 'view' } = options;
  const resolvedUserId = userId ?? (await auth())?.user?.id;

  if (!resolvedUserId) {
    redirectForMissingAuth();
  }

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerId: true },
  });

  if (!workspace) {
    notFound();
  }

  const access = await checkWorkspaceAccess(workspace, resolvedUserId);

  if (!access.hasAccess) {
    if (!access.ownerBillingActive) {
      redirectForBilling();
    }
    redirectForForbidden();
  }

  if (intent === 'manage' && !access.canEdit) {
    if (!access.ownerBillingActive) {
      redirectForBilling();
    }
    redirectForForbidden();
  }

  return { workspace, access };
}

export async function requireProjectAccessOrRedirect(options: {
  projectId: string;
  userId?: string;
  intent?: AccessIntent;
  allowPublicView?: boolean;
}) {
  const { projectId, userId, intent = 'view', allowPublicView = false } = options;
  const resolvedUserId = userId ?? (await auth())?.user?.id;

  // Fail closed before resource lookup when the route is not public.
  if (!resolvedUserId && !allowPublicView) {
    redirectForMissingAuth();
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerId: true, workspaceId: true, visibility: true },
  });

  if (!project) {
    if (!resolvedUserId) {
      redirectForMissingAuth();
    }
    notFound();
  }

  const access = await assertProjectAccessOrRedirect(project, {
    userId: resolvedUserId,
    intent,
    allowPublicView,
  });

  return { project, access };
}

export async function requireVideoProjectAccessOrRedirect(options: {
  projectId: string;
  videoId: string;
  userId?: string;
  intent?: AccessIntent;
  allowPublicView?: boolean;
}) {
  const { projectId, videoId, userId, intent = 'view', allowPublicView = false } = options;
  const resolvedUserId = userId ?? (await auth())?.user?.id;

  // Fail closed before resource lookup when the route is not public.
  if (!resolvedUserId && !allowPublicView) {
    redirectForMissingAuth();
  }

  const video = await db.video.findFirst({
    where: { id: videoId, projectId },
    select: {
      id: true,
      project: {
        select: { id: true, ownerId: true, workspaceId: true, visibility: true },
      },
    },
  });

  if (!video) {
    if (!resolvedUserId) {
      redirectForMissingAuth();
    }
    notFound();
  }

  const access = await assertProjectAccessOrRedirect(video.project, {
    userId: resolvedUserId,
    intent,
    allowPublicView,
  });

  return { video, access, project: video.project };
}
