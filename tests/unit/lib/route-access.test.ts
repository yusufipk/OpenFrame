import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingSubscriptionStatus } from '@prisma/client';
import { buildBillingAccessWhereInput } from '@/lib/billing';
import {
  hasAppNavigationAccess,
  hasCollaboratorBillingBackedAccess,
  requireAuthOrRedirect,
  requireBillingAccessOrRedirect,
  requireProjectAccessOrRedirect,
  requireVideoProjectAccessOrRedirect,
  requireWorkspaceAccessOrRedirect,
} from '@/lib/route-access';

// The real redirect() and notFound() abort rendering by throwing. A mock that
// returns normally would let execution fall through into code that can never run
// in production, and every assertion after that point would describe a fiction.
// In particular lib/route-access.ts has branches that call redirectForMissingAuth()
// and then redirectForForbidden() on the following line; only a throwing mock
// shows which of the two a real request would land on.
const nav = vi.hoisted(() => {
  class RedirectError extends Error {
    constructor(readonly path: string) {
      super(`NEXT_REDIRECT ${path}`);
    }
  }
  class NotFoundError extends Error {
    constructor() {
      super('NEXT_NOT_FOUND');
    }
  }
  return {
    RedirectError,
    NotFoundError,
    redirect: vi.fn((path: string): never => {
      throw new RedirectError(path);
    }),
    notFound: vi.fn((): never => {
      throw new NotFoundError();
    }),
  };
});

vi.mock('next/navigation', () => ({ redirect: nav.redirect, notFound: nav.notFound }));

// The permission formulas themselves live in lib/auth.ts and are covered by
// tests/unit/lib/project-access.test.ts against the real matrix. Here they are
// stubbed so each test can pin one access verdict and assert only on what
// route-access.ts does with it.
const authModule = vi.hoisted(() => ({
  auth: vi.fn(),
  checkProjectAccess: vi.fn(),
  checkVideoAccess: vi.fn(),
  checkWorkspaceAccess: vi.fn(),
}));

vi.mock('@/lib/auth', () => authModule);
vi.mock('@/lib/content-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/content-access')>()),
  checkVideoAccess: authModule.checkVideoAccess,
}));

const dbMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn(), count: vi.fn() },
  project: { findUnique: vi.fn(), count: vi.fn() },
  video: { findFirst: vi.fn(), count: vi.fn().mockResolvedValue(0) },
  projectFolder: { count: vi.fn().mockResolvedValue(0) },
}));

vi.mock('@/lib/db', () => ({ db: dbMock, default: dbMock, disconnectDb: vi.fn() }));

// The three redirect targets are written out by hand rather than imported, so
// changing a target in lib/route-access.ts fails here instead of silently
// agreeing with itself. /login and /dashboard match what the pages that do their
// own session check use (app/(dashboard)/dashboard/page.tsx redirects anonymous
// callers to /login); /settings is the page that renders the billing-only view
// when hasBillingAccess is false.
const LOGIN = '/login';
const FORBIDDEN = '/dashboard';
const BILLING = '/settings';

const NOW = new Date('2026-01-15T00:00:00.000Z');

const USER_ID = 'user-signed-in';
const OTHER_USER_ID = 'user-from-session';
const PROJECT_ID = 'project-1';
const WORKSPACE_ID = 'workspace-1';
const VIDEO_ID = 'video-1';

const ACTIVE_BILLING = {
  subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
  trialEndsAt: null,
  stripeCurrentPeriodEnd: null,
  billingAccessEndedAt: null,
};

const LAPSED_BILLING = {
  subscriptionStatus: BillingSubscriptionStatus.CANCELED,
  trialEndsAt: new Date('2025-12-01T00:00:00.000Z'),
  stripeCurrentPeriodEnd: new Date('2025-12-08T00:00:00.000Z'),
  billingAccessEndedAt: new Date('2025-12-08T00:00:00.000Z'),
};

const PROJECT_ROW = {
  id: PROJECT_ID,
  ownerId: USER_ID,
  workspaceId: WORKSPACE_ID,
  visibility: 'PRIVATE',
};

const PUBLIC_PROJECT_ROW = { ...PROJECT_ROW, visibility: 'PUBLIC' };

const WORKSPACE_ROW = { id: WORKSPACE_ID, ownerId: USER_ID };

const VIDEO_ROW = { id: VIDEO_ID, project: PROJECT_ROW };

type ProjectAccessResult = {
  isOwner: boolean;
  isProjectMember: boolean;
  isProjectAdmin: boolean;
  isWorkspaceMember: boolean;
  isWorkspaceAdmin: boolean;
  hasAccess: boolean;
  canEdit: boolean;
  canDelete: boolean;
  ownerBillingActive: boolean;
};

function projectAccess(overrides: Partial<ProjectAccessResult> = {}): ProjectAccessResult {
  return {
    isOwner: false,
    isProjectMember: false,
    isProjectAdmin: false,
    isWorkspaceMember: false,
    isWorkspaceAdmin: false,
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    ownerBillingActive: true,
    ...overrides,
  };
}

type WorkspaceAccessResult = {
  isOwner: boolean;
  isMember: boolean;
  isAdmin: boolean;
  hasAccess: boolean;
  canEdit: boolean;
  canDelete: boolean;
  ownerBillingActive: boolean;
};

function workspaceAccess(overrides: Partial<WorkspaceAccessResult> = {}): WorkspaceAccessResult {
  return {
    isOwner: false,
    isMember: false,
    isAdmin: false,
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    ownerBillingActive: true,
    ...overrides,
  };
}

/**
 * Asserts the call aborted through redirect() with exactly one target. The
 * "exactly one" half matters: several branches queue a second redirect on the
 * line below, and only the first one can ever take effect at runtime.
 */
async function expectRedirect(call: Promise<unknown>, path: string) {
  await expect(call).rejects.toBeInstanceOf(nav.RedirectError);
  expect(nav.redirect).toHaveBeenCalledTimes(1);
  expect(nav.redirect).toHaveBeenCalledWith(path);
  expect(nav.notFound).not.toHaveBeenCalled();
}

async function expectNotFound(call: Promise<unknown>) {
  await expect(call).rejects.toBeInstanceOf(nav.NotFoundError);
  expect(nav.notFound).toHaveBeenCalledTimes(1);
  expect(nav.redirect).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  // hasBillingAccess() short-circuits to true when Stripe is off, which would
  // make every lapsed-billing fixture read as paid.
  vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  authModule.auth.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('requireAuthOrRedirect', () => {
  it('sends an anonymous caller to the login page', async () => {
    authModule.auth.mockResolvedValue(null);

    await expectRedirect(requireAuthOrRedirect(), LOGIN);
  });

  it('sends a session with no user id to the login page', async () => {
    // next-auth can hand back a session object whose user was never resolved.
    authModule.auth.mockResolvedValue({ user: { email: 'nobody@example.com' } });

    await expectRedirect(requireAuthOrRedirect(), LOGIN);
  });

  it('returns the session untouched for a signed-in caller', async () => {
    const session = { user: { id: USER_ID, email: 'owner@example.com' } };
    authModule.auth.mockResolvedValue(session);

    await expect(requireAuthOrRedirect()).resolves.toEqual(session);
    expect(nav.redirect).not.toHaveBeenCalled();
  });
});

describe('requireBillingAccessOrRedirect', () => {
  it('sends an anonymous caller to the login page without reading the user row', async () => {
    authModule.auth.mockResolvedValue(null);

    await expectRedirect(requireBillingAccessOrRedirect(), LOGIN);
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('sends a caller whose user row is gone to the billing settings page', async () => {
    dbMock.user.findUnique.mockResolvedValue(null);

    await expectRedirect(requireBillingAccessOrRedirect({ userId: USER_ID }), BILLING);
  });

  it('sends a caller whose billing has lapsed to the billing settings page', async () => {
    dbMock.user.findUnique.mockResolvedValue(LAPSED_BILLING);

    await expectRedirect(requireBillingAccessOrRedirect({ userId: USER_ID }), BILLING);
  });

  it('returns the billing columns for a caller who is still paying', async () => {
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_BILLING);

    await expect(requireBillingAccessOrRedirect({ userId: USER_ID })).resolves.toEqual(
      ACTIVE_BILLING
    );
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it('keeps access for a caller inside an unexpired trial', async () => {
    dbMock.user.findUnique.mockResolvedValue({
      subscriptionStatus: BillingSubscriptionStatus.FREE,
      trialEndsAt: new Date('2026-01-16T00:00:00.000Z'),
      stripeCurrentPeriodEnd: null,
      billingAccessEndedAt: null,
    });

    await expect(requireBillingAccessOrRedirect({ userId: USER_ID })).resolves.toBeTruthy();
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it('trusts the caller-supplied user id over the session', async () => {
    // Pages that already resolved a session pass the id down to save a round
    // trip; the passed id has to win, or one user is billed against another.
    authModule.auth.mockResolvedValue({ user: { id: OTHER_USER_ID } });
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_BILLING);

    await requireBillingAccessOrRedirect({ userId: USER_ID });

    expect(dbMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID } })
    );
    expect(authModule.auth).not.toHaveBeenCalled();
  });
});

describe('hasCollaboratorBillingBackedAccess', () => {
  beforeEach(() => {
    dbMock.workspace.count.mockResolvedValue(0);
    dbMock.project.count.mockResolvedValue(0);
  });

  it('is true when the caller belongs to a workspace whose owner is paying', async () => {
    dbMock.workspace.count.mockResolvedValue(1);

    await expect(hasCollaboratorBillingBackedAccess(USER_ID)).resolves.toBe(true);
  });

  it('is true when the caller belongs to a project whose workspace owner is paying', async () => {
    dbMock.project.count.mockResolvedValue(1);

    await expect(hasCollaboratorBillingBackedAccess(USER_ID)).resolves.toBe(true);
  });

  it('is false when the caller collaborates nowhere', async () => {
    await expect(hasCollaboratorBillingBackedAccess(USER_ID)).resolves.toBe(false);
  });

  it('counts only workspaces and projects whose owner is inside the billing window', async () => {
    await hasCollaboratorBillingBackedAccess(USER_ID);

    // buildBillingAccessWhereInput comes from lib/billing, a separately tested
    // module, so this pins the filter without reading it out of route-access.
    const billingFilter = buildBillingAccessWhereInput(NOW);
    expect(dbMock.workspace.count.mock.calls[0][0].where.owner).toEqual(billingFilter);
    expect(dbMock.project.count.mock.calls[0][0].where.workspace.owner).toEqual(billingFilter);
  });

  it('counts a workspace the caller owns and one they were only invited to', async () => {
    // The membership arm is the whole point of the workspace half: a collaborator
    // who owns no workspace of their own would lose dashboard navigation without
    // it, and the project count only papers over that while they happen to sit on
    // at least one project row.
    await hasCollaboratorBillingBackedAccess(USER_ID);

    expect(dbMock.workspace.count.mock.calls[0][0].where.OR).toEqual([
      { ownerId: USER_ID },
      { members: { some: { userId: USER_ID } } },
    ]);
  });

  it('counts a project reached only through workspace membership', async () => {
    // A workspace COMMENTATOR is on no project row, so dropping this arm would
    // strip navigation from every workspace-level collaborator.
    await hasCollaboratorBillingBackedAccess(USER_ID);

    expect(dbMock.project.count.mock.calls[0][0].where.OR).toEqual([
      { ownerId: USER_ID },
      { members: { some: { userId: USER_ID } } },
      { workspace: { members: { some: { userId: USER_ID } } } },
    ]);
  });
});

describe('hasAppNavigationAccess', () => {
  beforeEach(() => {
    dbMock.workspace.count.mockResolvedValue(0);
    dbMock.project.count.mockResolvedValue(0);
  });

  it('is true for a paying user without counting collaborations', async () => {
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_BILLING);

    await expect(hasAppNavigationAccess(USER_ID)).resolves.toBe(true);
    expect(dbMock.workspace.count).not.toHaveBeenCalled();
    expect(dbMock.project.count).not.toHaveBeenCalled();
  });

  it('is true for a lapsed user who still collaborates on a paid workspace', async () => {
    dbMock.user.findUnique.mockResolvedValue(LAPSED_BILLING);
    dbMock.workspace.count.mockResolvedValue(1);

    await expect(hasAppNavigationAccess(USER_ID)).resolves.toBe(true);
  });

  it('is true when the user row is missing but a collaboration exists', async () => {
    dbMock.user.findUnique.mockResolvedValue(null);
    dbMock.project.count.mockResolvedValue(1);

    await expect(hasAppNavigationAccess(USER_ID)).resolves.toBe(true);
  });

  it('is false for a lapsed user with nothing left to collaborate on', async () => {
    dbMock.user.findUnique.mockResolvedValue(LAPSED_BILLING);

    await expect(hasAppNavigationAccess(USER_ID)).resolves.toBe(false);
  });
});

describe('requireWorkspaceAccessOrRedirect', () => {
  it('sends an anonymous caller to the login page before the workspace is read', async () => {
    authModule.auth.mockResolvedValue(null);

    await expectRedirect(requireWorkspaceAccessOrRedirect({ workspaceId: WORKSPACE_ID }), LOGIN);
    expect(dbMock.workspace.findUnique).not.toHaveBeenCalled();
    expect(authModule.checkWorkspaceAccess).not.toHaveBeenCalled();
  });

  it('renders a 404 for a signed-in caller when the workspace does not exist', async () => {
    dbMock.workspace.findUnique.mockResolvedValue(null);

    await expectNotFound(
      requireWorkspaceAccessOrRedirect({ workspaceId: WORKSPACE_ID, userId: USER_ID })
    );
    expect(authModule.checkWorkspaceAccess).not.toHaveBeenCalled();
  });

  it('sends a signed-in stranger to the dashboard', async () => {
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(workspaceAccess({ hasAccess: false }));

    await expectRedirect(
      requireWorkspaceAccessOrRedirect({ workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID }),
      FORBIDDEN
    );
  });

  it('sends the owner to the billing settings page when their billing has lapsed', async () => {
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(
      workspaceAccess({ isOwner: true, hasAccess: false, ownerBillingActive: false })
    );

    await expectRedirect(
      requireWorkspaceAccessOrRedirect({ workspaceId: WORKSPACE_ID, userId: USER_ID }),
      BILLING
    );
  });

  // The redirect target must not depend on the owner's billing for somebody with no
  // relationship to the workspace, or it becomes an oracle: probe workspace ids, and
  // /settings rather than /dashboard tells you whose subscription has lapsed.
  it.each([
    ['the owner is paying', true],
    ['the owner has lapsed', false],
  ])('sends a signed-in stranger to the dashboard when %s', async (_label, ownerBillingActive) => {
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(
      workspaceAccess({ hasAccess: false, ownerBillingActive })
    );

    await expectRedirect(
      requireWorkspaceAccessOrRedirect({ workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID }),
      FORBIDDEN
    );
  });

  // A member cannot resolve the owner's billing from their own settings page, so sending
  // them there offers no action they can take.
  it('sends a member whose owner has lapsed to the dashboard, not to billing', async () => {
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(
      workspaceAccess({ isMember: true, hasAccess: false, ownerBillingActive: false })
    );

    await expectRedirect(
      requireWorkspaceAccessOrRedirect({ workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID }),
      FORBIDDEN
    );
  });

  it('sends the lapsed owner to billing on the manage intent too', async () => {
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(
      workspaceAccess({
        isOwner: true,
        hasAccess: true,
        canEdit: false,
        ownerBillingActive: false,
      })
    );

    await expectRedirect(
      requireWorkspaceAccessOrRedirect({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        intent: 'manage',
      }),
      BILLING
    );
  });

  it('sends a member who cannot edit to the dashboard when the page needs manage rights', async () => {
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(
      workspaceAccess({ isMember: true, hasAccess: true, canEdit: false })
    );

    await expectRedirect(
      requireWorkspaceAccessOrRedirect({
        workspaceId: WORKSPACE_ID,
        userId: OTHER_USER_ID,
        intent: 'manage',
      }),
      FORBIDDEN
    );
  });

  it('lets a member through on the default view intent even though they cannot edit', async () => {
    const access = workspaceAccess({ isMember: true, hasAccess: true, canEdit: false });
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(access);

    await expect(
      requireWorkspaceAccessOrRedirect({ workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID })
    ).resolves.toEqual({ workspace: WORKSPACE_ROW, access });
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it('lets an admin through on the manage intent', async () => {
    const access = workspaceAccess({
      isMember: true,
      isAdmin: true,
      hasAccess: true,
      canEdit: true,
    });
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(access);

    await expect(
      requireWorkspaceAccessOrRedirect({
        workspaceId: WORKSPACE_ID,
        userId: OTHER_USER_ID,
        intent: 'manage',
      })
    ).resolves.toEqual({ workspace: WORKSPACE_ROW, access });
  });

  it('falls back to the session user when no id is passed', async () => {
    authModule.auth.mockResolvedValue({ user: { id: OTHER_USER_ID } });
    dbMock.workspace.findUnique.mockResolvedValue(WORKSPACE_ROW);
    authModule.checkWorkspaceAccess.mockResolvedValue(
      workspaceAccess({ isOwner: true, hasAccess: true, canEdit: true })
    );

    await requireWorkspaceAccessOrRedirect({ workspaceId: WORKSPACE_ID });

    expect(authModule.checkWorkspaceAccess).toHaveBeenCalledWith(WORKSPACE_ROW, OTHER_USER_ID);
  });
});

describe('requireProjectAccessOrRedirect', () => {
  it('sends an anonymous caller to the login page before the project is read', async () => {
    authModule.auth.mockResolvedValue(null);

    await expectRedirect(requireProjectAccessOrRedirect({ projectId: PROJECT_ID }), LOGIN);
    expect(dbMock.project.findUnique).not.toHaveBeenCalled();
    expect(authModule.checkProjectAccess).not.toHaveBeenCalled();
  });

  it('sends an anonymous caller to the login page on a public route asking for manage rights', async () => {
    // The guest policy runs before any permission check: a guest can only ever
    // read, so a manage page is a login redirect regardless of the project.
    dbMock.project.findUnique.mockResolvedValue(PUBLIC_PROJECT_ROW);

    await expectRedirect(
      requireProjectAccessOrRedirect({
        projectId: PROJECT_ID,
        intent: 'manage',
        allowPublicView: true,
      }),
      LOGIN
    );
    expect(authModule.checkProjectAccess).not.toHaveBeenCalled();
  });

  it('sends an anonymous caller to the login page rather than a 404 for a missing project', async () => {
    // A guest must not be able to tell a project that does not exist apart from
    // one they cannot see; both answers have to look the same.
    dbMock.project.findUnique.mockResolvedValue(null);

    await expectRedirect(
      requireProjectAccessOrRedirect({ projectId: PROJECT_ID, allowPublicView: true }),
      LOGIN
    );
  });

  it('sends an anonymous caller to the login page, not the dashboard, when a public route holds a private project', async () => {
    dbMock.project.findUnique.mockResolvedValue(PROJECT_ROW);
    authModule.checkProjectAccess.mockResolvedValue(projectAccess({ hasAccess: false }));

    await expectRedirect(
      requireProjectAccessOrRedirect({ projectId: PROJECT_ID, allowPublicView: true }),
      LOGIN
    );
  });

  it('renders a 404 for a signed-in caller when the project does not exist', async () => {
    dbMock.project.findUnique.mockResolvedValue(null);

    await expectNotFound(
      requireProjectAccessOrRedirect({ projectId: PROJECT_ID, userId: USER_ID })
    );
    expect(authModule.checkProjectAccess).not.toHaveBeenCalled();
  });

  it('sends a signed-in stranger to the dashboard', async () => {
    dbMock.project.findUnique.mockResolvedValue(PROJECT_ROW);
    authModule.checkProjectAccess.mockResolvedValue(projectAccess({ hasAccess: false }));

    await expectRedirect(
      requireProjectAccessOrRedirect({ projectId: PROJECT_ID, userId: OTHER_USER_ID }),
      FORBIDDEN
    );
  });

  it('sends the owner to the dashboard when the workspace owner billing has lapsed', async () => {
    // Unlike the workspace helper this path has no /settings branch: a lapsed
    // owner lands on /dashboard, which runs its own billing gate and forwards
    // them to /settings from there.
    dbMock.project.findUnique.mockResolvedValue(PROJECT_ROW);
    authModule.checkProjectAccess.mockResolvedValue(
      projectAccess({ isOwner: true, hasAccess: false, ownerBillingActive: false })
    );

    await expectRedirect(
      requireProjectAccessOrRedirect({ projectId: PROJECT_ID, userId: USER_ID }),
      FORBIDDEN
    );
  });

  it('sends a read-only member to the dashboard when the page needs manage rights', async () => {
    dbMock.project.findUnique.mockResolvedValue(PROJECT_ROW);
    authModule.checkProjectAccess.mockResolvedValue(
      projectAccess({ isProjectMember: true, hasAccess: true, canEdit: false })
    );

    await expectRedirect(
      requireProjectAccessOrRedirect({
        projectId: PROJECT_ID,
        userId: OTHER_USER_ID,
        intent: 'manage',
      }),
      FORBIDDEN
    );
  });

  it('returns the project row and the access verdict for a permitted viewer', async () => {
    const access = projectAccess({ isProjectMember: true, hasAccess: true });
    dbMock.project.findUnique.mockResolvedValue(PROJECT_ROW);
    authModule.checkProjectAccess.mockResolvedValue(access);

    await expect(
      requireProjectAccessOrRedirect({ projectId: PROJECT_ID, userId: OTHER_USER_ID })
    ).resolves.toEqual({ project: PROJECT_ROW, access });
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it('lets an anonymous viewer read a public project when the route opts in', async () => {
    const access = projectAccess({ hasAccess: true });
    dbMock.project.findUnique.mockResolvedValue(PUBLIC_PROJECT_ROW);
    authModule.checkProjectAccess.mockResolvedValue(access);

    await expect(
      requireProjectAccessOrRedirect({ projectId: PROJECT_ID, allowPublicView: true })
    ).resolves.toEqual({ project: PUBLIC_PROJECT_ROW, access });
    expect(authModule.checkProjectAccess).toHaveBeenCalledWith(PUBLIC_PROJECT_ROW, undefined);
  });

  it('passes the manage intent down to the permission check', async () => {
    dbMock.project.findUnique.mockResolvedValue(PROJECT_ROW);
    authModule.checkProjectAccess.mockResolvedValue(
      projectAccess({ isOwner: true, hasAccess: true, canEdit: true })
    );

    await requireProjectAccessOrRedirect({
      projectId: PROJECT_ID,
      userId: USER_ID,
      intent: 'manage',
    });

    expect(authModule.checkProjectAccess).toHaveBeenCalledWith(PROJECT_ROW, USER_ID);
  });

  it('falls back to the session user when no id is passed', async () => {
    authModule.auth.mockResolvedValue({ user: { id: OTHER_USER_ID } });
    dbMock.project.findUnique.mockResolvedValue(PROJECT_ROW);
    authModule.checkProjectAccess.mockResolvedValue(
      projectAccess({ isProjectMember: true, hasAccess: true })
    );

    await requireProjectAccessOrRedirect({ projectId: PROJECT_ID });

    expect(authModule.checkProjectAccess).toHaveBeenCalledWith(PROJECT_ROW, OTHER_USER_ID);
  });
});

describe('requireVideoProjectAccessOrRedirect', () => {
  const args = { projectId: PROJECT_ID, videoId: VIDEO_ID };

  it('sends an anonymous caller to the login page before the video is read', async () => {
    authModule.auth.mockResolvedValue(null);

    await expectRedirect(requireVideoProjectAccessOrRedirect(args), LOGIN);
    expect(dbMock.video.findFirst).not.toHaveBeenCalled();
  });

  it('looks the video up inside the project from the URL', async () => {
    // Without the projectId in the where clause, any video id would resolve
    // through any project the caller happens to be allowed to see.
    dbMock.video.findFirst.mockResolvedValue(VIDEO_ROW);
    authModule.checkVideoAccess.mockResolvedValue(
      projectAccess({ isOwner: true, hasAccess: true })
    );

    await requireVideoProjectAccessOrRedirect({ ...args, userId: USER_ID });

    expect(dbMock.video.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: VIDEO_ID, projectId: PROJECT_ID } })
    );
  });

  it('renders a 404 for a signed-in caller when the video is not in that project', async () => {
    dbMock.video.findFirst.mockResolvedValue(null);

    await expectNotFound(requireVideoProjectAccessOrRedirect({ ...args, userId: USER_ID }));
    expect(authModule.checkVideoAccess).not.toHaveBeenCalled();
  });

  it('sends an anonymous caller to the login page rather than a 404 for a missing video', async () => {
    dbMock.video.findFirst.mockResolvedValue(null);

    await expectRedirect(
      requireVideoProjectAccessOrRedirect({ ...args, allowPublicView: true }),
      LOGIN
    );
  });

  it('sends an anonymous caller to the login page on a public route asking for manage rights', async () => {
    dbMock.video.findFirst.mockResolvedValue(VIDEO_ROW);

    await expectRedirect(
      requireVideoProjectAccessOrRedirect({ ...args, intent: 'manage', allowPublicView: true }),
      LOGIN
    );
    expect(authModule.checkVideoAccess).not.toHaveBeenCalled();
  });

  it('sends a signed-in stranger to the dashboard', async () => {
    dbMock.video.findFirst.mockResolvedValue(VIDEO_ROW);
    authModule.checkVideoAccess.mockResolvedValue(projectAccess({ hasAccess: false }));

    await expectRedirect(
      requireVideoProjectAccessOrRedirect({ ...args, userId: OTHER_USER_ID }),
      FORBIDDEN
    );
  });

  it('sends a read-only member to the dashboard when the page needs manage rights', async () => {
    dbMock.video.findFirst.mockResolvedValue(VIDEO_ROW);
    authModule.checkVideoAccess.mockResolvedValue(
      projectAccess({ isProjectMember: true, hasAccess: true, canEdit: false })
    );

    await expectRedirect(
      requireVideoProjectAccessOrRedirect({ ...args, userId: OTHER_USER_ID, intent: 'manage' }),
      FORBIDDEN
    );
  });

  it('authorizes against the parent project and returns it alongside the video', async () => {
    const access = projectAccess({ isProjectMember: true, hasAccess: true });
    dbMock.video.findFirst.mockResolvedValue(VIDEO_ROW);
    authModule.checkVideoAccess.mockResolvedValue(access);

    await expect(
      requireVideoProjectAccessOrRedirect({ ...args, userId: OTHER_USER_ID })
    ).resolves.toEqual({ video: VIDEO_ROW, project: PROJECT_ROW, access });
    expect(authModule.checkVideoAccess).toHaveBeenCalledWith(VIDEO_ID, OTHER_USER_ID);
  });

  it('lets an anonymous viewer watch a video in a public project when the route opts in', async () => {
    const publicVideo = { id: VIDEO_ID, project: PUBLIC_PROJECT_ROW };
    const access = projectAccess({ hasAccess: true });
    dbMock.video.findFirst.mockResolvedValue(publicVideo);
    authModule.checkVideoAccess.mockResolvedValue(access);

    await expect(
      requireVideoProjectAccessOrRedirect({ ...args, allowPublicView: true })
    ).resolves.toEqual({ video: publicVideo, project: PUBLIC_PROJECT_ROW, access });
    expect(nav.redirect).not.toHaveBeenCalled();
  });
});
