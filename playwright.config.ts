import { defineConfig, devices } from '@playwright/test';

import {
  developmentEnvKeys,
  forgetAutoloadedDotenv,
  readTestEnvValue,
} from './tests/helpers/dev-env';
import { assertTestDatabase } from './tests/helpers/test-database';

// Undo bun's automatic `.env` load before anything below reads process.env.
// APP_ENV is built while this file is evaluated, so without this the suite
// would build and start the app against whatever deployment `.env` describes,
// with that deployment's R2 credentials, and then write test fixtures into it.
//
// Note this is not `import './tests/helpers/env'`: that would pull all of
// `.env.test` in, DISABLE_RATE_LIMIT included, and the production `next build`
// below refuses to run with that set.
forgetAutoloadedDotenv();

// ---------------------------------------------------------------------------
// End-to-end suite. See TESTING.md section 6.
//
// Report output: ./playwright-report (HTML), ./test-results (traces, videos).
// Both are gitignored and both are what the `e2e` job in ci.yml uploads.
//
// Port 3100, not 3000. The developer's dev server owns 3000 on this machine,
// and reuseExistingServer would happily attach the whole suite to it, pointing
// every test at the development database.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * Where the tests point their browser.
 *
 * Set E2E_BASE_URL to run against an app you started yourself (the `app-test`
 * service in docker-compose.test.yml, for instance). Leaving it unset is the
 * normal path: Playwright builds and starts the app itself, below.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

const MANAGES_OWN_SERVER = !process.env.E2E_BASE_URL;

/**
 * Environment for the app under test.
 *
 * `.env.test` is deliberately not loaded here. Two reasons:
 *
 *  1. `next build` runs with NODE_ENV=production and never loads `.env.test`,
 *     and NEXT_PUBLIC_APP_URL is inlined into the client bundle at build time,
 *     so the build needs these values passed in explicitly anyway.
 *  2. The R2_* variables below must NOT leak into the `api` Vitest project.
 *     `hasR2Config()` is derived from them, so putting them in `.env.test`
 *     would flip `isDirectFileUploadEnabled()` to true for 537 API tests that
 *     currently assert the unconfigured branch.
 *
 * DATABASE_URL is the exception, read out of `.env.test` on its own below: the
 * app and the global setup that seeds it must never disagree about which
 * database is under test.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  readTestEnvValue('DATABASE_URL') ??
  'postgresql://openframe:openframe@postgres-test:5432/openframe_test?schema=public';

// The e2e suite registers users, uploads videos and deletes projects. Whatever
// it is pointed at ends up holding test fixtures, so it has to be a test
// database, and this is the last point before `next build` inherits the value.
assertTestDatabase(DATABASE_URL);

const APP_ENV: Record<string, string> = {
  DATABASE_URL,

  NEXTAUTH_URL: BASE_URL,
  NEXT_PUBLIC_APP_URL: BASE_URL,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? 'test-secret-not-used-for-anything-real',
  // Required. NextAuth v5 refuses every /api/auth/* request with
  // `UntrustedHost` in production builds unless the host is trusted, which is
  // why .env.docker.example sets the same variable for real deployments.
  AUTH_TRUST_HOST: 'true',

  // Stripe stays ON, with dummy credentials. With the flag off,
  // hasBillingAccess() short-circuits to `true` and
  // buildBillingAccessWhereInput() returns `{}`, so the billing gate that
  // billing-gate.spec.ts exists to verify would not be armed at all. No spec
  // walks into checkout, so no request ever reaches Stripe.
  OPENFRAME_ENABLE_STRIPE: 'true',
  STRIPE_SECRET_KEY: 'sk_test_openframe_dummy',
  STRIPE_PRICE_ID: 'price_test_openframe_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_openframe_dummy',

  OPENFRAME_REQUIRE_INVITE_CODE: 'true',
  INVITE_CODE: 'test-invite',
  TRUSTED_PROXY_MODE: 'none',

  // Admin is not a database column. lib/auth.ts:143-148 derives `token.isAdmin`
  // on every request by looking the signed-in address up in this list, so
  // without it no account in this suite can be an admin and admin.spec.ts can
  // only assert the refusals. The address is the one that spec signs in as.
  ADMIN_EMAILS: process.env.ADMIN_EMAILS ?? 'e2e-admin@example.com',

  // Direct video uploads through the MinIO service in docker-compose.test.yml.
  // Without these the `Direct Upload` tab does not render at all, because
  // app/(dashboard)/projects/[projectId]/videos/new/page.tsx passes
  // isDirectFileUploadEnabled() into the client.
  //
  // The endpoint is the container hostname on purpose: the browser PUTs the
  // file straight at the presigned URL, so the host the app signs for has to be
  // the host the browser can resolve. Its origin is added to the CSP
  // connect-src automatically by lib/content-security-policy.ts.
  OPENFRAME_ENABLE_S3_VIDEO_UPLOADS: 'true',
  OPENFRAME_ENABLE_BUNNY_UPLOADS: 'false',
  R2_ENDPOINT: process.env.R2_ENDPOINT ?? 'http://minio-test:9000',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? 'openframe',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? 'openframe-test-secret',
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME ?? 'openframe-test',

  // Email verification must stay off, or a user registered through the form in
  // auth.spec.ts cannot sign in until a message that nothing delivers has been
  // clicked. isEmailVerificationEnabled() is derived from SMTP_HOST/USER/
  // PASSWORD, so leaving those unset is what disables it. .env.test sets them
  // for the api suite, which mocks nodemailer; nothing mocks it here.
};

// Blank every variable a development env file defines and this config does not.
//
// forgetAutoloadedDotenv() above cleared them out of process.env, which is not
// enough on its own: `next build` and `next start` run @next/env themselves and
// read `.env` again, filling anything still undefined. So on a developer machine
// the app under test would come up with that machine's configuration. SMTP_HOST
// alone turns email verification on and fails the registration spec, and
// DISABLE_RATE_LIMIT fails the production build outright, from inside
// lib/rate-limit.ts, reported as an unrelated "Failed to collect page data".
//
// An empty value rather than a deletion, because deletion is what @next/env
// undoes. The result is the environment CI already runs with, where these
// variables simply do not exist.
for (const key of developmentEnvKeys()) {
  if (!(key in APP_ENV)) {
    APP_ENV[key] = '';
  }
}

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',

  // Every spec seeds its own rows and deletes them again, so files are safe to
  // interleave. What they share is one app process and one database.
  fullyParallel: true,
  // Capped rather than left to the core count: the limit is the single Next
  // server, and the DB-backed rate limiter is keyed on the client IP, which is
  // the same address for every worker.
  workers: process.env.CI ? 2 : 4,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  // A cold run has to build the app first, and `next build` on this codebase
  // takes minutes; the per-test timeout is unrelated to that but the whole-run
  // one is not.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  // `open: 'never'` matters locally too: the report server would otherwise hold
  // the run open inside a container that has no browser to open it with.
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  globalSetup: './tests/e2e/global-setup.ts',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    // Chromium in a container is slower than on a desktop, and the first
    // navigation after a cold start pays for the route being compiled.
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/dashboard-mobile.spec.ts', '**/live-review*.spec.ts'],
    },
    {
      // One mobile project, for one spec. Section 6 asks for a mobile smoke
      // test, not a second full pass.
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
      testMatch: '**/dashboard-mobile.spec.ts',
    },
    // Safari, for the one thing that genuinely differs there.
    //
    // Opt-in, because it is not free: the browser is a separate download and a
    // second full pass would roughly double a CI run that is already the longest
    // job. Enable it with E2E_WEBKIT=1; the weekly `mutation`-style schedule in
    // ci.yml is the intended home for it rather than every push.
    //
    // Scoped to player.spec.ts on purpose. A video review tool's real Safari
    // risk is playback: codec support, whether `currentTime` commits the way
    // Chromium's does, and hls.js, none of which the other specs touch. Running
    // all fourteen specs under WebKit would mostly re-test React.
    ...(process.env.E2E_WEBKIT
      ? [
          {
            name: 'webkit-player',
            use: { ...devices['Desktop Safari'] },
            testMatch: '**/player.spec.ts',
          },
        ]
      : []),
  ],

  webServer: MANAGES_OWN_SERVER
    ? {
        // `bun run build` would re-run `prebuild` (tsc --noEmit) on every cold
        // start, which `bun run check` already covers. next is invoked through
        // its bin so this works under both bun and node.
        command: `./node_modules/.bin/next build && ./node_modules/.bin/next start -p ${PORT}`,
        url: `${BASE_URL}/login`,
        reuseExistingServer: !process.env.CI,
        // A cold `next build` here measured a little over three minutes.
        timeout: 15 * 60 * 1000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: APP_ENV,
      }
    : undefined,
});
