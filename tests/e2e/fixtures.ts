// Fixtures for the end-to-end suite.
//
// Two things live here and nothing else: how a test gets its own data, and how a
// test gets a signed-in browser.
//
// `react-hooks/rules-of-hooks` is off for this file, and only for this file:
// Playwright names the second argument of a fixture `use`, and the rule reads
// every call to a function of that name as React's `use` hook, then objects
// that `seed`, `seededUser` and `storageState` are not components. Nothing in
// here renders anything.
/* eslint-disable react-hooks/rules-of-hooks */

// MUST stay the first import: it loads .env.test, and `@/lib/db` reads
// DATABASE_URL once at import time and memoizes the pool.
import '../helpers/env';

import { test as base, expect, type APIRequest, type APIRequestContext } from '@playwright/test';
import { ProjectMemberRole, ProjectVisibility, type Project, type User } from '@prisma/client';
import { db } from '@/lib/db';
import {
  addProjectMember,
  createComment,
  createProject,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createWorkspace,
} from '../factories';

/** The password every seeded user gets. Never anything real. */
export const E2E_PASSWORD = 'e2e-password-123';

/**
 * Unique-value source for the e2e suite.
 *
 * tests/factories/seq.ts restarts its counter per module load, which is enough
 * for the api suite because resetDb() empties the database between tests. This
 * suite deliberately does NOT truncate: several Playwright workers drive one
 * app against one database at the same time, so `user-1@example.com` would
 * collide between workers on the very first test. Every unique column therefore
 * gets a value that is scoped to this process.
 *
 * These values are never asserted on, so the reproducibility argument that
 * rules out randomness in the api factories does not apply.
 */
const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`;
let localSeq = 0;
function uniqueTag(): string {
  localSeq += 1;
  return `${RUN_TAG}-${localSeq}`;
}

export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeededProject {
  owner: User;
  project: Project;
  workspaceId: string;
}

export interface SeededVersion extends SeededProject {
  videoId: string;
  versionId: string;
}

/**
 * Row builders scoped to one test, plus the cleanup that goes with them.
 *
 * Every user this hands out is remembered, and `cleanup()` deletes them. The
 * schema cascades from User to Workspace, Project, Video, VideoVersion, Comment
 * and ShareLink, so deleting the users a test created removes everything the
 * test created, including guest comments (which hang off the version, not off a
 * user).
 */
export class Seed {
  private readonly userIds: string[] = [];

  /** A user with billing access (trial ends in seven days) who can sign in. */
  async user(
    overrides: { name?: string; onboardingCompletedAt?: Date | null } = {}
  ): Promise<User> {
    const tag = uniqueTag();
    const user = await createUser({
      name: overrides.name ?? `E2E User ${tag}`,
      email: `e2e-${tag}@example.com`,
      password: E2E_PASSWORD,
      onboardingCompletedAt:
        overrides.onboardingCompletedAt === undefined
          ? new Date()
          : overrides.onboardingCompletedAt,
    });
    this.userIds.push(user.id);
    return user;
  }

  /**
   * A user whose trial ran out and who has no subscription, so
   * hasBillingAccess() is false and /settings offers `Upgrade with Stripe`.
   * `billingTrialConsumedAt` is set because the trial is once per account and
   * this one has had it.
   */
  async expiredUser(): Promise<User> {
    const tag = uniqueTag();
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const user = await createUser({
      name: `E2E Expired ${tag}`,
      email: `e2e-expired-${tag}@example.com`,
      password: E2E_PASSWORD,
      trialEndsAt: past,
      billingTrialConsumedAt: past,
      billingAccessEndedAt: past,
    });
    this.userIds.push(user.id);
    return user;
  }

  /** A workspace owned by `owner`, with no projects in it yet. */
  workspace(owner: User) {
    const tag = uniqueTag();
    return createWorkspace({
      ownerId: owner.id,
      name: `E2E Workspace ${tag}`,
      slug: `e2e-workspace-${tag}`,
    });
  }

  /** A workspace and a project inside it, owned by `owner`. */
  async project(
    owner: User,
    overrides: { name?: string; visibility?: ProjectVisibility } = {}
  ): Promise<SeededProject> {
    const tag = uniqueTag();
    const workspace = await createWorkspace({
      ownerId: owner.id,
      name: `E2E Workspace ${tag}`,
      slug: `e2e-workspace-${tag}`,
    });
    const project = await createProject({
      ownerId: owner.id,
      workspaceId: workspace.id,
      name: overrides.name ?? `E2E Project ${tag}`,
      slug: `e2e-project-${tag}`,
      visibility: overrides.visibility ?? ProjectVisibility.PRIVATE,
    });
    return { owner, project, workspaceId: workspace.id };
  }

  /**
   * A project with one video and one active version.
   *
   * The version is a `youtube` provider on purpose: it needs no object storage
   * and no seeded media file. The player itself will not initialise without
   * network access to youtube.com (see comments.spec.ts), but every page around
   * it renders, which is what the comment and approval flows exercise.
   */
  async version(
    owner: User,
    overrides: { name?: string; title?: string } = {}
  ): Promise<SeededVersion> {
    const seeded = await this.project(owner, { name: overrides.name });
    const tag = uniqueTag();
    const video = await createVideo({
      projectId: seeded.project.id,
      title: overrides.title ?? `E2E Video ${tag}`,
    });
    const version = await createVersion({
      videoParentId: video.id,
      providerId: 'youtube',
      providerVideoId: `dQw4w9WgXcQ`,
      title: `E2E Version ${tag}`,
      duration: 120,
    });
    return { ...seeded, videoId: video.id, versionId: version.id };
  }

  /** Adds `user` to `project` with the given role. */
  member(projectId: string, userId: string, role: ProjectMemberRole) {
    return addProjectMember({ projectId, userId, role });
  }

  /** A share link row, for the cases the UI cannot produce (expiry, for one). */
  shareLink(input: {
    projectId: string;
    videoId?: string | null;
    expiresAt?: Date | null;
    password?: string;
  }) {
    return createShareLink({
      projectId: input.projectId,
      videoId: input.videoId ?? null,
      token: `e2e-share-${uniqueTag()}`,
      expiresAt: input.expiresAt ?? null,
      ...(input.password === undefined ? {} : { password: input.password }),
    });
  }

  comment(input: { versionId: string; authorId: string; content: string; timestamp?: number }) {
    return createComment(input);
  }

  /**
   * Removes a user this Seed did not create, for the one case that exists: the
   * account auth.spec.ts registers through the form.
   */
  async deleteUserByEmail(email: string): Promise<void> {
    await db.user.deleteMany({ where: { email } });
  }

  async cleanup(): Promise<void> {
    if (this.userIds.length === 0) return;
    await db.user.deleteMany({ where: { id: { in: this.userIds } } });
  }
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/**
 * Signs a seeded user in over HTTP and leaves the session cookie in `context`.
 *
 * This is the NextAuth credentials callback, the same endpoint the login form
 * posts to, driven without rendering the form. Only auth.spec.ts types into the
 * form; every other spec pays two requests instead of a page load.
 */
export async function signInViaApi(
  context: APIRequestContext,
  email: string,
  password: string = E2E_PASSWORD
): Promise<void> {
  // Not optional. Every POST to /api/auth/* counts against a ten-per-fifteen-
  // minutes budget shared by the whole run; see clearRateLimits().
  await clearRateLimits();

  const csrfResponse = await context.get('/api/auth/csrf');
  if (!csrfResponse.ok()) {
    throw new Error(
      `GET /api/auth/csrf returned ${csrfResponse.status()}. ` +
        'AUTH_TRUST_HOST must be set for the app under test, or NextAuth answers ' +
        'every /api/auth/* request with UntrustedHost.'
    );
  }
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken?: string };
  if (!csrfToken) {
    throw new Error('GET /api/auth/csrf returned no csrfToken.');
  }

  const loginResponse = await context.post('/api/auth/callback/credentials', {
    form: { csrfToken, email, password, callbackUrl: '/dashboard' },
    maxRedirects: 0,
  });

  // NextAuth answers a successful credentials sign-in with a redirect to the
  // callback URL and a failed one with a redirect back to /login?error=...
  // Anything that is not a redirect at all is the rate limiter or a server
  // error, and must fail here rather than as a mysterious /login later.
  const status = loginResponse.status();
  const location = loginResponse.headers()['location'] ?? '';

  if (status !== 302 && status !== 303) {
    throw new Error(
      `POST /api/auth/callback/credentials returned ${status} for ${email} ` +
        `(expected a redirect). Body: ${(await loginResponse.text()).slice(0, 200)}`
    );
  }
  if (location.includes('/login')) {
    throw new Error(`Credentials sign-in for ${email} was rejected (redirect to ${location}).`);
  }
}

/**
 * A `storageState` object holding a signed-in session for `email`.
 *
 * Built from an API request context rather than a browser context: no browser is
 * launched, and `storageState` can therefore be an option fixture without
 * depending on the `browser` fixture that consumes it.
 *
 * Pass the `playwright.request` fixture as `apiRequest`.
 */
export async function storageStateFor(
  apiRequest: APIRequest,
  baseURL: string,
  email: string
): Promise<StorageState> {
  const context = await apiRequest.newContext({ baseURL });
  try {
    await signInViaApi(context, email);
    return await context.storageState();
  } finally {
    await context.dispose();
  }
}

// ---------------------------------------------------------------------------
// The test object
// ---------------------------------------------------------------------------

/**
 * Empties the DB-backed rate-limit table.
 *
 * This is not a convenience, it is the difference between a suite that works and
 * one that does not. `app/api/auth/[...nextauth]/route.ts` wraps every POST to
 * /api/auth/* in `rateLimit(request, 'login')`, which allows **ten requests per
 * fifteen minutes per client IP** - and every worker, every context and every
 * run share one IP here, because they are all loopback. The eleventh sign-in of
 * the run gets a 429 instead of a session cookie, and the symptom is a test that
 * quietly lands on /login. Registration (five per hour) has the same problem
 * across retries.
 *
 * Switching the limiter off is not available: lib/rate-limit.ts throws on import
 * when DISABLE_RATE_LIMIT is set and NODE_ENV is production, and the app under
 * test is a production build. So the counters are cleared instead. The limiter
 * itself is covered by tests/api/rate-limit.test.ts; no e2e spec asserts on it.
 */
export async function clearRateLimits(): Promise<void> {
  await db.rateLimit.deleteMany({});
}

interface SeedFixtures {
  /** Row builders for this test. Everything they create is deleted afterwards. */
  seed: Seed;
  /** Clears the rate-limit counters before the test runs. Always on. */
  freshRateLimits: void;
}

interface SeedWorkerFixtures {
  /** Closes the Prisma pool so the worker process can exit. */
  dbConnection: void;
}

/**
 * A test with database seeding but an **anonymous** browser.
 *
 * Use this for anything that has to start signed out: the login and
 * registration forms, guest gates, share links opened by a stranger.
 */
export const anonTest = base.extend<SeedFixtures, SeedWorkerFixtures>({
  dbConnection: [
    async ({}, use) => {
      await use();
      await db.$disconnect();
    },
    { scope: 'worker', auto: true },
  ],

  freshRateLimits: [
    async ({}, use) => {
      await clearRateLimits();
      await use();
    },
    { auto: true },
  ],

  seed: async ({}, use) => {
    const seed = new Seed();
    await use(seed);
    await seed.cleanup();
  },
});

/**
 * The default: `page` already carries `seededUser`'s session, because the
 * built-in `storageState` option is overridden below. No spec other than
 * auth.spec.ts pays for rendering the login form.
 *
 * One trap comes with that override, and it is silent: Playwright Test passes
 * the test's own context options into `browser.newContext()` as well, so a
 * second context opened inside a test written against this `test` object is
 * signed in as `seededUser` unless it says otherwise. Any test that needs a
 * stranger must ask for one explicitly, with
 * `browser.newContext({ storageState: undefined })`. A guest gate opened by an
 * accidentally-authenticated context simply does not appear, and the spec looks
 * like a product bug rather than a fixture mistake.
 */
export const test = anonTest.extend<{ seededUser: User }>({
  seededUser: async ({ seed }, use) => {
    await use(await seed.user());
  },

  storageState: async ({ playwright, baseURL, seededUser }, use) => {
    await use(await storageStateFor(playwright.request, baseURL ?? '', seededUser.email ?? ''));
  },
});

/**
 * Signs `page`'s context in as `email`, for the rare test that needs a second
 * identity in the same browser context. The API request context shares the
 * cookie jar with the page, so the session applies from the next navigation on.
 */
export async function signInPage(
  page: { context(): { request: APIRequestContext } },
  email: string
): Promise<void> {
  await signInViaApi(page.context().request, email);
}

export { expect };
