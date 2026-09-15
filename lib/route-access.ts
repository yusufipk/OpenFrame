import { checkVideoAccess, visibleFolderWhere, visibleVideoWhere } from '@/lib/content-access';
import { notFound, redirect } from 'next/navigation';
import { auth, checkProjectAccess, checkWorkspaceAccess } from '@/lib/auth';
import { buildBillingAccessWhereInput, hasBillingAccess } from '@/lib/billing';
import { db } from '@/lib/db';

type AccessIntent = 'view' | 'manage';

const LOGIN_REDIRECT = '/login';
const FORBIDDEN_REDIRECT = '/dashboard';
const BILLING_REDIRECT = '/settings';

// `never` rather than `void`, so a caller that puts a second redirect after one of these
// gets a compile error instead of silently unreachable code. `redirect()` throws, and
// these are authorization decisions: a helper that ever returned would let the branch
// below it run.
function redirectForMissingAuth(): never {
  redirect(LOGIN_REDIRECT);
}

function redirectForForbidden(): never {
  redirect(FORBIDDEN_REDIRECT);
}

function redirectForBilling(): never {
  redirect(BILLING_REDIRECT);
}

function ensureGuestPolicy(options: {
  userId?: string;
  intent: AccessIntent;
  allowPublicView: boolean;
}) {
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

  const access = await checkProjectAccess(project, userId);

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

export async function requireBillingAccessOrRedirect(options?: { userId?: string }) {
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
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
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

  if (workspaceCount > 0 || projectCount > 0) return true;
  const [folders, videos] = await Promise.all([
    db.projectFolder.count({
      where: { members: { some: { userId } }, AND: visibleFolderWhere(userId) },
    }),
    db.video.count({ where: { members: { some: { userId } }, AND: visibleVideoWhere(userId) } }),
  ]);
  return folders > 0 || videos > 0;
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

  // Only the owner is sent to billing. Keying this off the owner's billing status alone
  // made the redirect target an oracle: a signed-in stranger probing workspace ids landed
  // on /dashboard when the owner was paying and on /settings when the owner had lapsed,
  // which reads off whose subscription is in arrears. It also sent a member whose owner
  // had lapsed to their own billing page, where nothing they can do resolves it.
  const ownerWithLapsedBilling = access.isOwner && !access.ownerBillingActive;

  if (!access.hasAccess) {
    if (ownerWithLapsedBilling) {
      redirectForBilling();
    }
    redirectForForbidden();
  }

  if (intent === 'manage' && !access.canEdit) {
    if (ownerWithLapsedBilling) {
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

  ensureGuestPolicy({ userId: resolvedUserId, intent, allowPublicView });
  const access = await checkVideoAccess(video.id, resolvedUserId);
  if (!access.hasAccess || (intent === 'manage' && !access.canEdit)) redirectForForbidden();

  return { video, access, project: video.project };
}
