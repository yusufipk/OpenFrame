# Testing Plan

Status: **all six phases delivered**, and a second round has since closed the coverage gaps
the first one left. What actually landed, and where reality differed from the plan, is in
Section 12; the gap-closing round is Section 13. The sections below are kept as written so
the reasoning behind each decision stays readable.

| Suite            | Command            | Tests    | Runtime |
| ---------------- | ------------------ | -------- | ------- |
| Unit + component | `bun run test`     | 2079     | 12s     |
| API integration  | `bun run test:api` | 1015     | 92s     |
| End to end       | `bun run test:e2e` | 29       | 66s     |
| **Total**        | `bun run test:all` | **3123** |         |

OpenFrame is ~56k lines across 60 API route handlers, ~90 components and ~50 `lib/`
modules. Before this, every change was verified by hand. This document defines the stack,
the layout, the priority order, and the exact commands so that verification becomes
`bun run test`.

---

## 0. Primer

Short glossary, because this repo has no testing history:

- **Unit test**: calls one function directly with fixed inputs and asserts the return
  value. No database, no network, no browser. Runs in milliseconds.
- **Integration test**: exercises several real pieces together. Here that means calling an
  API route handler with a real request object against a real (test) Postgres, with only
  the session faked.
- **E2E test**: drives a real browser against a running app. Verifies what a user sees.
- **Mock / stub**: a fake stand-in for a dependency (`auth()`, Stripe, S3).
- **Factory**: a helper that inserts a realistic row into the test DB
  (`createProject({ visibility: 'PUBLIC' })`).
- **Fixture**: a fixed input file or dataset a test reads from.
- **Flaky test**: passes and fails on the same code. Usually a timing bug in the test.
  Flaky tests are worse than no tests; fix or delete them, never retry them away.
- **AAA**: Arrange, Act, Assert. The shape every test in this repo should have.

The rule of thumb we follow: **many unit tests, a solid layer of API integration tests,
a handful of E2E tests, almost no component tests.** Cost per test rises and stability
falls as you go up that list.

---

## 1. Stack decisions

| Layer                  | Tool                                         | Why                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit + API integration | **Vitest 4**                                 | Native ESM/TS, resolves the `@/*` alias via `vite-tsconfig-paths`, first-class module mocking (`vi.mock`) which we need for `auth()`, and multi-project config so node and jsdom suites live in one runner. |
| Component + hooks      | **@testing-library/react 16** + **jsdom 29** | Standard for React 19. Gives us `renderHook`, which is what we actually want for the big hooks in `components/video-page/hooks/`.                                                                           |
| E2E                    | **Playwright 1.62**                          | Real Chromium/Firefox/WebKit, auto-waiting (kills most flakiness), trace viewer for debugging CI failures, official container image so it runs under podman.                                                |
| Coverage               | **@vitest/coverage-v8**                      | Built in, no extra config.                                                                                                                                                                                  |

### Rejected alternatives, and why

- **`bun test`**: fast and already in the toolchain, but its jsdom/React story and Next.js
  module-mocking story are still thinner than Vitest's. We run Vitest _with_ bun
  (`bun run vitest`), so we keep bun as the only package manager and task runner.
- **Jest**: needs `next/jest`, babel config and ESM workarounds. Strictly more setup for
  strictly less speed.
- **Mocked Prisma (`vitest-mock-extended` / `prismock`)**: rejected for API tests. The
  bugs this repo actually produces are wrong `where` filters and missing `OR` branches
  (see the `buildBillingAccessWhereInput` usage in `app/api/projects/route.ts`). A mocked
  client asserts that we called Prisma, not that the query is correct, and the mock setup
  is more code than the test. A real Postgres in a container costs seconds.
- **MSW**: not needed yet. External calls (Stripe, Bunny, R2) are reached through thin
  wrappers in `lib/`, so `vi.mock('@/lib/stripe')` is simpler than intercepting HTTP.
  Revisit only if we start testing client-side fetch flows in jsdom.
- **Cypress**: Playwright is faster, has better parallelism and better container support.
- **Snapshot tests**: deliberately out of scope. They fail on every intentional markup
  change and assert nothing about behaviour.

### One structural constraint to be aware of

There are no `use server` actions in this repo; all mutations go through
`app/api/**/route.ts`. That is good news: route handlers are plain exported functions, so
they can be imported and called directly in a test without a running server.

Conversely, **async Server Components cannot be unit tested** with Testing Library. Every
`page.tsx` in `app/(dashboard)` is therefore covered by E2E, not by component tests. This
is the single biggest reason the component layer stays thin.

---

## 2. Directory layout

```
tests/
  unit/                      # node env, no DB, no mocks
    lib/
      billing.test.ts
      project-access.test.ts
      validation.test.ts
      ...
  api/                       # node env, real test Postgres, auth() mocked
    auth-matrix.test.ts      # data-driven: no route returns 2xx unauthenticated
    projects.test.ts
    comments.test.ts
    ...
  component/                 # jsdom env
    hooks/
      use-watch-progress.test.ts
      ...
    comment-rich-text.test.tsx
  e2e/                       # Playwright
    auth.spec.ts
    project-lifecycle.spec.ts
    ...
  factories/                 # test-DB row builders
    index.ts
    user.ts
    project.ts
    video.ts
  helpers/
    db.ts                    # truncate + connect
    request.ts               # NextRequest builders, route invocation
    session.ts               # session mock control
  setup/
    api.ts                   # per-file setup for the api project
    component.ts             # jsdom polyfills + jest-dom matchers
    db-global.ts             # global setup: migrate the test DB once
  fixtures/
    sample.mp4               # tiny (<100KB) media for upload paths
    sample.png
```

Rationale for a top-level `tests/` tree rather than colocated `*.test.ts`: it keeps `app/`
free of non-route files, makes the Docker build ignore rules trivial, and lets each layer
have its own environment without per-file pragmas.

**Import style:** no globals. Every test file does
`import { describe, it, expect, vi } from 'vitest';`. This keeps `tsconfig.json`
untouched and keeps `bun run typecheck` covering the test files, so a broken test is a
failed `bun run check`.

**Naming:** `describe('functionName')` / `it('returns X when Y')`. No "should".

---

## 3. Phase 0: Foundation

Goal: `bun run test` runs and reports "no tests found" instead of erroring. Nothing is
tested yet; the wiring is done.

- [x] Add dev dependencies:

  ```
  bun add -d vitest@^4.1.10 @vitest/coverage-v8@^4.1.10 \
             @vitejs/plugin-react@^6.0.4 vite-tsconfig-paths@^6.1.1 \
             jsdom@^29.1.1 @testing-library/react@^16.3.2 \
             @testing-library/jest-dom@^7.0.0 @testing-library/user-event@^14.6.1
  ```

  (Playwright is added in Phase 3 so the browser download does not slow Phase 0.)

- [x] `vitest.config.ts` at the repo root, using Vitest 4 `projects`:

  ```ts
  import { defineConfig } from 'vitest/config';
  import react from '@vitejs/plugin-react';
  import tsconfigPaths from 'vite-tsconfig-paths';

  export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            environment: 'node',
            include: ['tests/unit/**/*.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'api',
            environment: 'node',
            include: ['tests/api/**/*.test.ts'],
            setupFiles: ['tests/setup/api.ts'],
            globalSetup: ['tests/setup/db-global.ts'],
            // One shared test database; parallel files would fight over TRUNCATE.
            fileParallelism: false,
            testTimeout: 20_000,
          },
        },
        {
          extends: true,
          plugins: [tsconfigPaths(), react()],
          test: {
            name: 'component',
            environment: 'jsdom',
            include: ['tests/component/**/*.test.{ts,tsx}'],
            setupFiles: ['tests/setup/component.ts'],
          },
        },
      ],
    },
  });
  ```

- [x] `package.json` scripts:

  ```json
  "test": "vitest run --project unit --project component",
  "test:watch": "vitest --project unit --project component",
  "test:api": "vitest run --project api",
  "test:e2e": "playwright test",
  "test:all": "bun run test && bun run test:api && bun run test:e2e",
  "test:coverage": "vitest run --project unit --coverage",
  "verify": "bun run check && bun run test",
  "test:db:up": "podman compose -f docker-compose.test.yml up -d --wait postgres-test",
  "test:db:down": "podman compose -f docker-compose.test.yml down -v"
  ```

  `test` intentionally excludes the `api` project so the default command needs no
  infrastructure and stays instant. `test:all` is the full sweep.

- [x] `.prettierignore`: add `coverage/`, `playwright-report/`, `test-results/`.
- [x] `.gitignore`: add `/playwright-report`, `/test-results`, `/.playwright`, and the
      exception `!.env.test.example` (the existing `.env*` rule would otherwise hide it).
- [x] `eslint.config.mjs`: append an override for `tests/**` relaxing
      `@typescript-eslint/no-explicit-any` and any `no-restricted-imports` that fight
      test helpers. Keep `--max-warnings=0` intact.
- [x] `.dockerignore`: add `tests/`, `vitest.config.ts`, `playwright.config.ts` so the
      production image does not grow.
- [x] `AGENTS.md`: add "run `bun run verify` before finishing" alongside the existing
      `bun run check` rule, and a line pointing at this file.

**Definition of done:** `bun run test` exits 0.

---

## 4. Phase 1: Pure unit tests

Highest value per hour of work in the whole plan. No DB, no mocks, no async. This is also
where the authorization logic lives, which is where the repo's real bugs have been.

Target: **~200 tests across 20 files**, total runtime under 2 seconds.

Priority order, most valuable first:

- [x] **`tests/unit/lib/project-access.test.ts`**: `computeProjectAccess()` from
      `lib/auth.ts`. This is the heart of every permission decision in the product. Build
      an explicit matrix: anonymous / non-member / project member / project ADMIN /
      workspace member / workspace ADMIN / workspace OWNER / project owner, crossed with
      `visibility` PRIVATE|PUBLIC and workspace-owner billing active|expired. Assert all
      of `hasAccess`, `canEdit`, `canDelete`, `isWorkspaceAdmin`, `ownerBillingActive`.
      Recent history (`fix/public-project-hides-workspace-admin-actions`) says bugs land
      exactly here. ~24 tests.
- [x] **`tests/unit/lib/billing.test.ts`**: `hasActiveTrial`, `hasActiveSubscription`,
      `hasRecoverableSubscription`, `hasBillingAccess`, `getBillingAccessEndDate`,
      `getStorageCleanupEligibleAt`, `getDefaultTrialEndsAt`, `mapStripeSubscriptionStatus`
      (every Stripe status string), `selectAuthoritativeSubscription`,
      `getBillingStatusLabel`. All take an injectable `now`, so no fake timers needed.
      Also snapshot-free shape assertions on `buildBillingAccessWhereInput` and
      `buildExpiredBillingWhereInput`. ~32 tests.
- [x] **`tests/unit/lib/validation.test.ts`**: `validateAnnotationStrokes` (limits: 500
      strokes, 2000 points, colour regex, stroke width bounds, prototype-pollution
      payloads, `__proto__` keys, NaN/Infinity coords), `isValidHttpUrl`
      (`javascript:`, `data:`, `file:`), `isSafeAppRelativePath` (traversal, wrong UUID
      shape), `validateOptionalUrlOrAppPath`. Security boundaries that are impossible to
      test by hand. ~24 tests.
- [x] **`tests/unit/lib/feature-flags.test.ts`**: env-driven, so use
      `vi.stubEnv`. Cover `readBooleanEnv` defaults and garbage values, the S3-over-Bunny
      precedence in `isBunnyUploadsEnabled`, `isDirectFileUploadEnabled`,
      `getMaxVideoUploadBytes` fallback on invalid/negative input, and the
      `getR2MultipartPartSizeBytes` 5 MiB clamp. ~20 tests.
- [x] **`tests/unit/lib/rate-limit.test.ts`**: `getClientIp` under each
      `TRUSTED_PROXY_MODE`, spoofed `x-forwarded-for` chains, the `IP_PATTERN` reject
      path, plus `rateLimitHeaders` and a sanity check that every entry in
      `RATE_LIMIT_CONFIGS` has positive window and max. ~14 tests.
- [x] **`tests/unit/lib/api-response.test.ts`**: each `apiErrors.*` helper returns the
      right status and `code`, `successResponse` serialises `meta` and BigInt values,
      `withCacheControl` sets the header. Guards the contract every route depends on.
      ~14 tests.
- [x] **`tests/unit/lib/upload-validation.test.ts`**: `lib/video-upload-validation.ts`
      and `lib/image-upload-validation.ts`: extension/MIME allowlists, size limits,
      filename sanitisation. ~16 tests.
- [x] **`tests/unit/lib/share-links.test.ts`**: token generation shape, expiry logic,
      permission comparison. ~10 tests.
- [x] **`tests/unit/lib/guest-identity.test.ts`**: cookie parse/serialise, name
      sanitisation, invalid payloads. ~8 tests.
- [x] **`tests/unit/lib/content-security-policy.test.ts`**: `buildContentSecurityPolicy`
      includes runtime storage endpoints when set, omits them when not, and never emits
      `unsafe-eval` in production mode. ~8 tests.
- [x] **`tests/unit/lib/video-providers.test.ts`**: provider resolution in
      `lib/video-providers/index.ts`, YouTube ID extraction from every URL form
      (`watch?v=`, `youtu.be`, `shorts/`, with extra params, invalid), `metadata-cache`
      hit/miss/expiry. ~14 tests.
- [x] **`tests/unit/lib/comment-export.test.ts`**: timecode formatting, CSV/text escaping
      of quotes and newlines, ordering. ~10 tests.
- [x] **`tests/unit/lib/approval-workflow.test.ts`**: status transition rules. ~8 tests.
- [x] **`tests/unit/lib/async-pool.test.ts`**: concurrency bound is respected, results
      keep input order, one rejection does not lose the others. ~6 tests.
- [x] **`tests/unit/lib/json-serialize.test.ts`**: `bigIntReplacer` on nested structures,
      `0n`, negative values. ~5 tests.
- [x] **`tests/unit/lib/email-validation.test.ts`**: ~6 tests.
- [x] **`tests/unit/lib/cleanup-warnings.test.ts`**: warning threshold boundaries. ~6 tests.
- [x] **`tests/unit/lib/email-brand.test.ts`**: HTML escaping in email templates. ~5 tests.
- [x] **`tests/unit/lib/seo.test.ts`** + `lib/marketing/metadata.ts`: canonical URLs,
      title/description length bounds. ~6 tests.
- [x] **`tests/unit/lib/comment-tags.test.ts`**: `DEFAULT_COMMENT_TAGS` invariants
      (unique slugs, valid colours). ~4 tests.

**Definition of done:** `bun run test` runs ~200 assertions in under 2 seconds, and
`bun run test:coverage` reports >85% line coverage on the files listed above.

---

## 5. Phase 2: API integration tests

Goal: for each covered route, prove that an unauthorised caller cannot reach it, that
malformed input is rejected with 400, and that the happy path writes the right rows.

### Infrastructure

- [x] `docker-compose.test.yml`: Postgres only (no MinIO for now; storage is mocked at
      the `lib/r2.ts` boundary), on port `55432` so it cannot collide with the dev stack,
      with `tmpfs` for the data directory to keep it fast and disposable:
  ```yaml
  services:
    postgres-test:
      image: postgres:16-alpine
      environment:
        POSTGRES_USER: openframe
        POSTGRES_PASSWORD: openframe
        POSTGRES_DB: openframe_test
      command: ['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off']
      tmpfs:
        - /var/lib/postgresql/data
      healthcheck:
        test: ['CMD-SHELL', 'pg_isready -U openframe -d openframe_test']
        interval: 2s
        timeout: 3s
        retries: 30
      ports:
        - '127.0.0.1:55432:5432'
  ```
- [x] `.env.test.example` committed, `.env.test` gitignored. Minimum set:
      `DATABASE_URL` (pointing at 55432), `NEXTAUTH_URL`, `NEXTAUTH_SECRET`,
      `NEXT_PUBLIC_APP_URL`, `OPENFRAME_ENABLE_STRIPE=false`,
      `OPENFRAME_REQUIRE_INVITE_CODE=true`, `INVITE_CODE=test-invite`,
      `TRUSTED_PROXY_MODE=none`, `NODE_ENV=test`.
- [x] `tests/setup/db-global.ts`: global setup, runs once. Loads `.env.test`, waits for
      Postgres, runs `prisma migrate deploy` against the test DB. Migrations (not
      `db push`) because `prisma/migrations/*/migration.sql` contains hand-written SQL
      such as `cleanup_rate_limits()` that the routes depend on.
- [x] `tests/setup/api.ts`: per-file setup. Loads `.env.test` **before** any `@/lib/db`
      import, registers `afterEach(resetDb)`, and installs the `auth()` mock.
- [x] `tests/helpers/db.ts`: `resetDb()` truncates every table except
      `_prisma_migrations`, discovered dynamically from `information_schema.tables` so it
      never drifts from the schema:
      `TRUNCATE TABLE <list> RESTART IDENTITY CASCADE`.
- [x] `tests/helpers/session.ts`: controls the mock:
  ```ts
  vi.mock('@/lib/auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/auth')>();
    return { ...actual, auth: vi.fn() };
  });
  ```
      plus `signedInAs(user)` / `signedOut()` wrappers. Partial mock, so the real
      `checkProjectAccess` / `checkWorkspaceAccess` still run against the real DB. That
      is the whole point: the authorization code under test is not the code being faked.
- [x] `tests/helpers/request.ts`: `apiRequest(url, { method, body, headers, cookies })`
      returning a `NextRequest`, and `callRoute(handler, request, params)` that wraps
      params in a resolved promise, matching the `params: Promise<...>` convention from
      `AGENTS.md`.
- [x] `tests/factories/`: `createUser({ trialEndsAt, subscriptionStatus })`,
      `createWorkspace({ ownerId })`, `addWorkspaceMember`, `createProject({ visibility })`,
      `addProjectMember({ role })`, `createVideo`, `createVersion`, `createComment`,
      `createShareLink`, `createApprovalRequest`. Unique values from a module-level
      counter, no faker dependency.
- [x] Module mocks for external services, in `tests/setup/api.ts`:
      `@/lib/r2` (presign returns a fake URL), `@/lib/stripe`,
      `@/lib/bunny-upload-token`, and `nodemailer` (assert on captured mail instead of
      sending).

### The cheap win: auth matrix

- [x] `tests/api/auth-matrix.test.ts`: a table of all 60 route modules with their
      exported methods and a sample params object. For each, assert that an
      unauthenticated call returns 401 or 403, never 2xx. One file, one afternoon,
      coverage across every route in the app. Routes that are legitimately public
      (`/api/watch/[videoId]` with a share token, `/api/stripe/webhook`,
      `/api/auth/*`) go in an explicit allowlist inside the file, so making a route public
      becomes a visible diff.

### Deep coverage, in priority order

Each of these gets unauthorised / forbidden / invalid-input / happy-path cases:

- [x] `tests/api/projects.test.ts`: `app/api/projects/route.ts` GET pagination guards
      (page 0, page 1001, limit 101, offset > 10000), the billing filter (projects of an
      expired-trial workspace owner are invisible), POST validation and default comment
      tags; `[projectId]` GET/PATCH/DELETE against the `canEdit` / `canDelete` matrix.
- [x] `tests/api/project-members.test.ts` covering `members/route.ts` and
      `members/[memberId]`. A project ADMIN cannot promote itself past its scope, a VIEWER
      cannot invite, the owner cannot be removed.
- [x] `tests/api/comments.test.ts` covering `versions/[versionId]/comments` POST.
      Annotation payload validation wired to `validateAnnotationStrokes`, guest identity
      path, timecode bounds. Plus `comments/[commentId]` DELETE/PATCH, where only the
      author or an admin may act.
- [x] `tests/api/approvals.test.ts`: request creation, `decision` route rejecting a
      non-candidate approver, `cancel` restricted to the requester, terminal-status
      transitions rejected.
- [x] `tests/api/share-links.test.ts`: creation permissions, password-protected links,
      expiry, `SharePermission` levels honoured on read.
- [x] `tests/api/watch.test.ts` covering `watch/[videoId]` and `progress`. Share-session
      gate, private video without session, `upload-token` scoping.
- [x] `tests/api/videos.test.ts`: `videos/route.ts`, `bulk-delete` (cross-project ids
      rejected), `move` (target project permission check), `r2-init` / `r2-complete`
      session lifecycle with `lib/r2.ts` mocked.
- [x] `tests/api/stripe-webhook.test.ts`: invalid signature rejected, each handled event
      type maps to the right user state via `syncStripeSubscriptionToUser`, replayed
      events are idempotent. Stripe SDK mocked; event payloads as fixtures.
- [x] `tests/api/register.test.ts`: invite code required/not required, duplicate email,
      password hashing (never stored in clear), email normalisation to lowercase,
      verification-token creation.
- [x] `tests/api/workspaces.test.ts`: creation eligibility via
      `getWorkspaceCreationEligibility`, member add/remove roles.
- [x] `tests/api/storage-quota.test.ts`: `reserveStorageQuota` /
      `releaseStorageReservation` concurrency: two parallel reservations cannot exceed
      `PLAN_STORAGE_LIMIT_BYTES`. This exercises the advisory-lock SQL, which is exactly
      the kind of thing that cannot be verified by clicking.
- [x] `tests/api/rate-limit.test.ts`: the DB-backed `checkRateLimit` actually blocks
      after N requests and the window resets.

**Definition of done:** `bun run test:api` green against a fresh
`bun run test:db:up`, total runtime under 90 seconds.

_Later optimisation, not now:_ give each Vitest worker its own Postgres schema
(`?schema=test_w${VITEST_WORKER_ID}`) and re-enable `fileParallelism`. Only worth it if
the suite passes ~2 minutes.

---

## 6. Phase 3: E2E tests

Goal: the UI is verified by a browser, not by hand. Keep this suite small and ruthlessly
stable. Eight flows, not eighty.

- [x] `bun add -d @playwright/test@^1.62.0`
- [x] `playwright.config.ts`: Chromium as the default project, one Mobile Chrome project
      for the dashboard smoke test, `retries: 2` on CI and `0` locally,
      `trace: 'on-first-retry'`, and a `webServer` running `bun run build && bun run start`
      with `.env.test` and `OPENFRAME_ENABLE_STRIPE=false`.
- [x] `tests/e2e/fixtures.ts`: a seeded-user fixture using Playwright `storageState`, so
      only the auth spec pays the cost of logging in through the form.
- [x] Add the app + MinIO to `docker-compose.test.yml` as a separate profile, since E2E
      needs real storage for the upload flow.

Flows, in priority order:

- [x] `auth.spec.ts`: register with invite code, wrong invite code rejected, login,
      wrong password, logout, protected route redirects to `/login`.
- [x] `onboarding.spec.ts`: a fresh user completes onboarding and lands with a workspace.
- [x] `project-lifecycle.spec.ts`: create, rename, change visibility, delete a project;
      the list reflects each change.
- [x] `video-upload.spec.ts`: upload `tests/fixtures/sample.mp4` through the drag-drop
      uploader, wait for the version to appear, add a second version.
- [x] `comments.spec.ts`: leave a timestamped comment, verify the timecode links back to
      the right frame, draw an annotation and confirm it persists after reload, reply and
      resolve.
- [x] `approvals.spec.ts`: request approval, approve as a second user in a second
      browser context, verify both users' views.
- [x] `share-link.spec.ts`: create a share link, open it in a fresh unauthenticated
      context, verify the guest name gate and the permission level, verify an expired link
      is refused.
- [x] `billing-gate.spec.ts`: a seeded expired-trial user is pushed to `/settings` and
      cannot open a project.
- [x] `dashboard-mobile.spec.ts`: mobile viewport smoke test. Navigation opens, the project
      list renders, no horizontal scroll.

**Rules for this suite** (these are what keep E2E from becoming the thing everyone
disables): locate by role and accessible name or `data-testid`, never by CSS class; never
`waitForTimeout`; every spec creates its own data and cleans up after itself; nothing
depends on execution order.

**Definition of done:** `bun run test:e2e` green twice in a row locally and on CI.

---

## 7. Phase 4: Component and hook tests

Deliberately last and deliberately narrow. Most components here are presentational
wrappers over Radix or are async Server Components (untestable in jsdom, already covered
by E2E). The real logic sits in hooks.

- [x] `tests/setup/component.ts`: `@testing-library/jest-dom/vitest`, plus the jsdom
      polyfills Radix and the video player need: `matchMedia`,
      `Element.prototype.scrollIntoView`, `ResizeObserver`, `PointerEvent` methods,
      `HTMLMediaElement.prototype.play/pause`, `URL.createObjectURL`.

Worth testing (via `renderHook`):

- [x] `components/video-page/hooks/use-watch-progress.ts`: throttling, resume position,
      the boundary where progress counts as "watched".
- [x] `components/video-page/hooks/use-version-duration-sync.ts`: small and pure enough
      to pin exactly.
- [x] `components/video-page/hooks/use-comment-export.ts`: pairs with the
      `lib/comment-export.ts` unit tests.
- [x] `components/video-page/hooks/use-comment-actions.ts`: 39k of logic. Test optimistic
      insert, rollback on failed request, reply threading, resolve toggling. Highest-value
      item in this phase.
- [x] `components/video-page/hooks/use-video-player.ts`: 48k. Do **not** attempt full
      coverage in jsdom. Pull the pure parts (timecode parsing/formatting, frame stepping
      arithmetic, keyboard-shortcut mapping) into a sibling module and unit test those in
      Phase 1 style; leave playback behaviour to E2E.

Worth testing (via `render`):

- [x] `components/video-page/comment-rich-text.tsx`: URL linkification and
      `@[name](asset:id)` mention parsing, including the XSS-shaped inputs
      (`javascript:` hrefs must not render as links).
- [x] `components/linkify.tsx`: same regex, different component.
- [x] `components/error-boundary.tsx`: renders the fallback and does not swallow the
      error.
- [x] `components/share-link-unlock.tsx` and `components/guest-gate.tsx`: small forms
      with real validation branches.

Explicitly **not** tested here: everything in `components/ui/` (upstream shadcn/Radix),
`LandingPage.tsx`, `components/marketing/*`, `assets-pane.tsx`, `comments-pane.tsx`,
`video-page-content.tsx`. Those are covered by E2E where they are covered at all.

---

## 8. Phase 5: One-click and CI

- [x] `.husky/pre-push` (new hook):
  ```sh
  bun run verify
  ```
      `pre-commit` stays as-is (`lint-staged`) so committing stays fast. Push is the right
      gate: it is where work leaves the machine.
- [x] Rewrite `.github/workflows/ci.yml` into three jobs:
  ```yaml
  jobs:
    check: # existing: lint + format + typecheck
    test: # unit + component + api, with a postgres:16-alpine service
    e2e: # playwright, main and live-review suites in parallel, uploads the report on failure
  ```
      `test` runs `bun run test && bun run test:api` with `DATABASE_URL` pointing at the
      service container and `prisma migrate deploy` first. `e2e` uses
      `mcr.microsoft.com/playwright:v1.62.0-noble` as the job container and uploads
      `playwright-report/` via `actions/upload-artifact` when it fails.
- [x] Add a coverage summary comment or a `coverage-summary.json` artifact. No coverage
      _threshold_ gate initially: a hard gate on a suite this young turns into people
      writing tests for getters. Revisit once Phase 2 is complete.
- [x] `README.md` and `CONTRIBUTING.md`: a "Running the tests" section pointing here.

### Local commands, all under podman

Per the project rule, no npm package touches the host filesystem.

```fish
# Unit + component, the everyday loop
podman run -it --rm -v "$PWD":/workspace:z -w /workspace docker.io/oven/bun:alpine \
  sh -c "bun install && bun run test"

# Watch mode while writing code
podman run -it --rm -v "$PWD":/workspace:z -w /workspace docker.io/oven/bun:alpine \
  sh -c "bun install && bun run test:watch"

# API integration: start the test DB on the shared network first
podman network create openframe-test  # once
podman compose -f docker-compose.test.yml up -d --wait postgres-test
podman run -it --rm --network openframe-test -v "$PWD":/workspace:z -w /workspace \
  docker.io/oven/bun:alpine sh -c "bun install && bun run test:api"

# E2E: browsers preinstalled in the Playwright image
podman run -it --rm --network openframe-test -v "$PWD":/workspace:z -w /workspace \
  mcr.microsoft.com/playwright:v1.62.0-noble sh -c "bun run test:e2e"
```

- [x] Wrap these in `scripts/test.sh <unit|api|e2e|all>` so the everyday invocation is one
      short command instead of a memorised podman line.

---

## 9. Risks and spikes

Each of these gets a 15-minute spike **before** the phase that depends on it. If a spike
fails, the fallback is listed.

1. **`vi.mock` partial-mocking `@/lib/auth` (Phase 2).** Importing the real module
   initialises NextAuth v5 beta with `PrismaAdapter(db)` at module load. It should be
   inert without a request, but beta versions surprise.
   _Fallback:_ extract `computeProjectAccess`, `checkProjectAccess`,
   `checkWorkspaceAccess` and `projectAccessInclude` into `lib/access.ts` (a pure
   re-export from `lib/auth.ts` keeps every call site working). Then tests import
   `lib/access.ts` and mock `lib/auth.ts` wholesale. This is a better structure anyway.

2. **`lib/db.ts` env timing (Phase 2).** `db` is a module-level singleton that reads
   `process.env.DATABASE_URL` at import. Setup files must load `.env.test` before the
   first `@/lib/db` import in the module graph.
   _Fallback:_ pass env explicitly on the command line
   (`DATABASE_URL=... vitest run --project api`) instead of relying on a setup file.

3. **`process.on('SIGINT'|'SIGTERM')` in `lib/db.ts` (Phase 2).** Every test file that
   imports `db` adds listeners. With many files this trips Node's
   `MaxListenersExceededWarning` and, with `--max-warnings` style strictness, noise.
   _Fallback:_ guard the registration with `if (process.env.NODE_ENV !== 'test')`, or
   call `process.setMaxListeners(0)` in the api setup file.

4. **Radix + React 19 under jsdom 29 (Phase 4).** Radix uses pointer-capture APIs jsdom
   does not implement.
   _Fallback:_ the polyfill list in `tests/setup/component.ts`; and if a component still
   resists, it moves to E2E instead. No fighting jsdom for hours.

5. **Playwright `webServer` build time (Phase 3).** `next build` on a 56k-line app is not
   fast, so a naive config rebuilds on every local run.
   _Fallback:_ `reuseExistingServer: !process.env.CI` and a cached `.next` between runs;
   note that per this repo's worktree recipe, a cold `.next` in a worktree causes Prisma
   500s, so the E2E setup must seed `.next` or run in the main checkout.

6. **BigInt in assertions (Phases 1-2).** Storage sizes are `bigint`. `expect(x).toBe(1)`
   fails against `1n`. Establish the convention early: always compare
   `BigInt(...)` to `BigInt(...)`.

---

## 10. Effort and sequencing

| Phase             | Scope                                | Rough effort   | Value         |
| ----------------- | ------------------------------------ | -------------- | ------------- |
| 0 Foundation      | config, scripts, lint/ignore wiring  | half a session | enabling      |
| 1 Unit            | ~200 tests, 20 files                 | 1-2 sessions   | **very high** |
| 2 API             | infra + auth matrix + 12 deep suites | 3-4 sessions   | **very high** |
| 3 E2E             | 9 specs + compose profile            | 2-3 sessions   | high          |
| 4 Component/hooks | ~10 targets                          | 1-2 sessions   | medium        |
| 5 CI + hooks      | 3 jobs, pre-push, docs               | half a session | high          |

Recommended order of delivery: **0 → 1 → 5 (partial: pre-push + `test` job) → 2 → 3 → 4**.
Wiring CI right after Phase 1 means the tests start protecting `master` while they are
still cheap, instead of waiting for the whole pyramid.

---

## 11. Non-goals

Written down so they do not get relitigated:

- No snapshot tests.
- No tests for `components/ui/*` (upstream shadcn/Radix).
- No mocked Prisma client.
- No 100% coverage target. Coverage is a diagnostic, not a goal.
- No test for a getter, a re-export, or a constant.
- No visual regression testing (Percy/Chromatic) at this stage.
- No load or performance testing at this stage.

---

## 12. Where the plan was wrong

Corrections found while implementing it. Recorded so the sections above are read with them
in mind, and so nobody "fixes" a deliberate deviation back.

**Infrastructure**

- `prisma migrate deploy` **cannot build this database**, which invalidates Section 5's
  instruction. `prisma/migrations` is a stack of patches on top of a baseline that was
  never captured, so the second migration runs `ALTER TYPE "VideoAssetKind" ADD VALUE`
  against a type nothing in the history creates, and dies with P3018 / 42704 on an empty
  database. The test schema therefore comes from `prisma db push` plus a replay of the
  hand-written SQL that `schema.prisma` cannot express (`cleanup_rate_limits()`, the
  `UNLOGGED` rate-limit table, three partial unique indexes on `video_versions`). This is
  the same approach `scripts/docker-db-bootstrap.ts` already takes in production.
  `tests/setup/db-global.ts` documents it in full and carries a drift guard that fails the
  run when a migration is added without review.
- **Coverage does not work under bun.** `@vitest/coverage-v8` needs the V8 inspector API,
  which bun does not implement, so `bun run test:coverage` reports zeros. The suites pass
  under both runtimes, so CI runs the coverage step under node instead. Getting the unit
  project to run under node needed `server.deps.inline: [/next-auth/]`, because
  `next-auth/lib/env.js` imports the extensionless `next/server`, which node's ESM
  resolver cannot resolve and bun can.
- **`@playwright/test` is pinned to 1.61.1, not the newest release.** The container image
  is what fixes the ceiling: `mcr.microsoft.com/playwright:v1.62.0-noble` is not published,
  and Playwright refuses a browser build that does not match the package. Bump the package
  and the image tag together, and check the tag exists first.
- **The Playwright image ships no bun**, and `oven-sh/setup-bun` cannot run inside it
  either, because the image has no `unzip`. Both the CI job and `scripts/test.sh` install
  bun with `npm install --global bun` first.
- **eslint keeps its own ignore list**, so a coverage run used to break `bun run lint` on
  the reporter's vendored JS. `coverage/**`, `playwright-report/**` and `test-results/**`
  are now in `globalIgnores`.
- **`tsconfig.json` targets ES2017, so `1n` is a compile error** (TS2737) even though the
  BigInt type resolves. Always `BigInt(1)`. Section 9 framed this as a runtime assertion
  mismatch and understated it.
- **Testing Library's auto-cleanup never installed.** It only registers its own
  `afterEach(cleanup)` when a global `afterEach` is visible, and Section 2 mandates
  explicit imports. Components stayed mounted for the rest of each file, with their
  intervals and listeners live, which produced real cross-test contamination.
  `tests/setup/component.ts` now calls `cleanup()` itself.
- **Risk #1 did not materialize.** `@/lib/auth` imports cleanly in a node test environment,
  so the `lib/access.ts` extraction was not needed and was not done. Risk #3 was real but
  `process.setMaxListeners(0)` in the api setup was enough, so `lib/db.ts` stays untouched.

**Test environment**

- **`OPENFRAME_ENABLE_STRIPE` must be `true`** in the test environment, not `false` as
  Sections 5 and 6 suggested. With the flag off, `hasBillingAccess()` short-circuits to
  `true` and `buildBillingAccessWhereInput()` returns `{}`, which disarms the entire
  billing gate and makes every access-control assertion meaningless. Dummy Stripe keys are
  used and no test walks into checkout.
- `DISABLE_RATE_LIMIT=true` for the api suite, because every request in it shares one
  client IP and one file exhausting a window would make the next file's 429 look like a
  passing authorization check. `rate-limit.test.ts` re-enables it per test.
- `vi.stubEnv` does **not** auto-restore. `tests/setup/api.ts` calls `vi.unstubAllEnvs()`
  in `afterEach` centrally, after four tests were caught passing for the wrong reason.
- The E2E suite deliberately does not truncate between tests: several Playwright workers
  drive one app against one database, so each test seeds uniquely tagged rows and deletes
  its own users, letting the schema cascade do the rest.

**Assignments in the plan that did not match the code**

- `lib/share-links.ts` generates no tokens; it exports `validateShareLinkAccess`.
- `lib/approval-workflow.ts` has no status transition rules; it exports
  `getApprovalCandidatesForProject`.
- `runWithConcurrency` returns `Promise<void>`, so "results keep input order" is not a
  property it can have.
- `lib/rate-limit.ts`'s real off-by-one lives in `checkRateLimit`, which Section 4 omitted.
- `use-video-player.ts` contains no timecode parser or formatter. `formatTime` is injected
  as a parameter and is duplicated in four components; hoisting it into `lib/` is a
  separate change. The extraction covered frame and playhead arithmetic instead.
- Section 5 lists `/api/watch/[videoId]` as public. It is not: it 403s anonymously on a
  private project and needs a share-session cookie.
- Section 8's `.dockerignore` item does not achieve its stated goal. Image size comes from
  a non-production `bun install` whose `node_modules` is copied wholesale into the runner
  stage, not from source files.
- A coverage PR comment needs `pull-requests: write`, which conflicts with keeping
  `permissions: contents: read`, so CI uploads an artifact instead.

---

## 13. Closing the gaps

The first round left an inventory of what it had not covered. This section records what
the second round did about it, so the inventory is not read as still-current.

Where it ended up:

| Suite            | Before | After |
| ---------------- | ------ | ----- |
| Unit             | 1191   | 1702  |
| Component + hook | 167    | 377   |
| API integration  | 647    | 1015  |
| End to end       | 18     | 29    |

**The page-level authorization layer.** `lib/route-access.ts` had zero coverage, which
meant the API routes were guarded by tests and the pages were not. It now has 47, with
`next/navigation` mocked so that `redirect()` and `notFound()` throw the way they really
do. Every redirect target was verified against a second source rather than read off the
function under test, and one of the three the plan assumed turned out to be wrong: the
project paths have no billing branch at all and reach `/settings` in two hops through
`/dashboard`.

**The media proxies.** Five routes served user media with only anonymous coverage, and the
reason they had stayed that way was the positive control: no 2xx is reachable without R2
configured, and a 403 with nothing green beside it can pass for the wrong reason. The way
in was to stub `r2Client.send()` and leave `lib/r2-media-proxy.ts` itself real, so the
object keys, content types and range handling are production code paths. Every one of the
five now has a genuine 2xx in the same file as its 403.

**Tests that could not fail.** The auth matrix used to assert only "not 2xx" for an
anonymous caller. Two entries satisfied that without their guard existing at all, because
the route refused a malformed body one line further down, and Section 12's predecessor
recorded them as unfixable. They were fixable: requiring an authorization status (401, 403
or 404) rather than merely a non-2xx one makes both load-bearing, and all 60 routes pass
the stricter form, so `NON_AUTHORIZATION_REFUSALS` is empty and exists only as a drift
guard.

**A stub with the wrong shape is worse than no stub.** `tests/setup/api.ts` declared
`readVideoObjectBytes` as returning an object wrapping a `Uint8Array` when it really
returns the array. The object was truthy but had no `.length`, so `hasKnownVideoMagicBytes()`
saw zero bytes and every route reaching `finalizeR2VideoUpload` took the "not a valid
video" branch, cancelled the session and deleted both objects. Nothing failed. No test
drove that path to success until this round, and the whole api suite had been green over
it for weeks.

**Parallel suites need parallel databases.** Eight agents wrote suites at once, and the
api project empties every table between tests, so they cannot share one database. Each run
got its own, created by hand in the same container and named `openframe_test_<suffix>`.
`tests/api/infrastructure.test.ts` now accepts that shape instead of the exact name; the
guard that matters, that the dev database is called `openframe` and does not match, is
untouched.

**Mutation testing.** `bun run test:mutation` runs StrykerJS over the authorization and
input-validation modules listed in `stryker.config.json`, against
`vitest.mutation.config.ts`, which is the `unit` project alone. Not a merge gate, for the
same reason there is no coverage threshold, and CI runs it weekly and on demand rather
than on a push, because a full run is minutes. The module list is explicit rather than a
`lib/**` glob: a file whose only coverage is an API integration test would report every
mutant as survived and bury the real findings.

**Safari.** `playwright.config.ts` gains a `webkit-player` project behind `E2E_WEBKIT=1`,
scoped to `player.spec.ts`. Playback is where a video review tool's Safari risk actually
lives; running all fourteen specs under WebKit would mostly re-test React.

**Reviewed by somebody else.** Every suite in this round was read by a separate agent whose
only question was whether the tests deliver what they claim. That is now a standing rule in
`AGENTS.md` rather than a one-off.

What was deliberately left, and why:

- **OAuth sign-in, Stripe checkout, and email verification end to end.** All three leave
  the app or need a provider stub. The gate each one guards is covered at the API layer.
- **Version comparison end to end.** Two real uploads per test against 51 KB of its own
  client logic. Three solid specs beat five thin ones.
- **`components/ui/*`, the marketing pages, and the three large panes.** Unchanged from
  Section 11. The panes' real logic is reachable by extraction, which is what
  `video-player-utils.ts` and `upload-chunking.ts` demonstrate.
- **A coverage threshold gate.** Still a non-goal. Mutation testing answers the question a
  threshold was a proxy for.
