// Global setup for the `api` Vitest project. Runs once per run, in the main
// Vitest process, before any test file is loaded.
//
// Never import from 'vitest' here: globalSetup runs outside the test context.
//
// ---------------------------------------------------------------------------
// Why this uses `prisma db push` and not `prisma migrate deploy`
// ---------------------------------------------------------------------------
// TESTING.md section 5 specifies `prisma migrate deploy`. That does not work in
// this repo, and the reason is worth stating so nobody "fixes" it back:
//
//   prisma/migrations holds fifteen incremental patches on top of a baseline
//   that was never captured as a migration. The schema was originally created
//   with `db push`. So the second migration in the sequence,
//   20260227000000_add_audio_asset_kind_and_provider, opens with
//   `ALTER TYPE "VideoAssetKind" ADD VALUE 'AUDIO'` against a type that nothing
//   in the migration history ever created. Against an empty database
//   `migrate deploy` dies on it with P3018 / 42704
//   (`type "VideoAssetKind" does not exist`).
//
// So the schema comes from `prisma db push`, and the parts of the hand-written
// SQL that schema.prisma cannot express are replayed afterwards in
// POST_PUSH_SQL. Those parts are load-bearing: `cleanup_rate_limits()` is
// called by lib/rate-limit.ts, and the three partial unique indexes are what
// stop an R2 object key being claimed by two video versions.
//
// REVIEWED_MIGRATIONS below is a drift guard. Add a migration and this setup
// fails until someone has looked at whether it contains SQL that `db push`
// cannot derive from schema.prisma, exactly like the route list in
// tests/api/auth-matrix.test.ts.

// MUST stay the first import: it loads .env.test, and everything below reads
// process.env.DATABASE_URL.
import { REPO_ROOT } from '../helpers/env';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';

const execFileAsync = promisify(execFile);

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'prisma', 'migrations');

/**
 * Every migration directory that has been checked against POST_PUSH_SQL.
 *
 * Entries marked "replayed" contain SQL that `prisma db push` cannot produce
 * from schema.prisma, so POST_PUSH_SQL carries an idempotent copy. Everything
 * else is a plain table/column/enum addition that db push derives on its own.
 */
const REVIEWED_MIGRATIONS = [
  '20260226110000_rate_limit_extras', // replayed: cleanup_rate_limits(), UNLOGGED
  '20260227000000_add_audio_asset_kind_and_provider',
  '20260227120000_add_onboarding',
  '20260320110000_add_stripe_billing',
  '20260320123000_add_billing_trials_and_cleanup_dates',
  '20260321003000_add_subscription_cancel_state',
  '20260321094500_add_billing_trial_consumed_at',
  '20260414120000_add_size_bytes_to_video_assets',
  '20260415120000_add_upload_reservations',
  '20260527120000_add_size_bytes_to_video_versions',
  '20260527154000_add_video_upload_sessions',
  '20260527155000_add_r2_video_uniqueness_indexes', // replayed: 3 partial unique indexes
  '20260613120000_add_r2_video_asset_provider',
  '20260614160000_add_project_allow_downloads',
  '20260627140000_add_video_upload_multipart_id',
  '20260801120000_add_acquisition_analytics',
  '20260818120000_add_upload_reservation_purpose',
  '20260820120000_add_comment_images',
  '20260822120000_add_video_subtitles',
  '20260908120000_add_subscription_cancellations',
];

/** Objects POST_PUSH_SQL must have produced. Verified after it runs. */
const REQUIRED_FUNCTIONS = ['cleanup_rate_limits'];
const REQUIRED_INDEXES = [
  'video_versions_r2_videoid_unique',
  'video_versions_r2_originalurl_unique',
  'video_versions_r2_thumbnail_unique',
];

const POST_PUSH_SQL = `
-- Replayed from 20260226110000_rate_limit_extras. lib/rate-limit.ts calls
-- cleanup_rate_limits() on an interval and tests/api/rate-limit.test.ts asserts
-- on what it deletes.
CREATE OR REPLACE FUNCTION cleanup_rate_limits() RETURNS void AS $fn$
BEGIN
    DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 hour';
END;
$fn$ LANGUAGE plpgsql;

DO $do$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_class
        WHERE relname = 'rate_limits'
          AND relkind = 'r'
          AND relpersistence <> 'u'
    ) THEN
        ALTER TABLE rate_limits SET UNLOGGED;
    END IF;
END $do$;

-- Replayed from 20260527155000_add_r2_video_uniqueness_indexes. Partial indexes
-- have no representation in schema.prisma, so db push never creates them, and
-- app/api/projects/[projectId]/videos/r2-complete/route.ts relies on them to
-- reject a second version claiming the same object key.
CREATE UNIQUE INDEX IF NOT EXISTS "video_versions_r2_videoid_unique"
ON "video_versions" ("videoId")
WHERE "providerId" = 'r2';

CREATE UNIQUE INDEX IF NOT EXISTS "video_versions_r2_originalurl_unique"
ON "video_versions" ("originalUrl")
WHERE "providerId" = 'r2' AND "originalUrl" LIKE '/api/upload/video/%';

CREATE UNIQUE INDEX IF NOT EXISTS "video_versions_r2_thumbnail_unique"
ON "video_versions" ("thumbnailUrl")
WHERE "providerId" = 'r2' AND "thumbnailUrl" LIKE '/api/upload/image/%';
`;

function assertMigrationsReviewed(): void {
  const found = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const unreviewed = found.filter((name) => !REVIEWED_MIGRATIONS.includes(name));
  const vanished = REVIEWED_MIGRATIONS.filter((name) => !found.includes(name));

  if (unreviewed.length === 0 && vanished.length === 0) return;

  throw new Error(
    [
      'prisma/migrations no longer matches REVIEWED_MIGRATIONS in tests/setup/db-global.ts.',
      unreviewed.length > 0 ? `  new, unreviewed: ${unreviewed.join(', ')}` : null,
      vanished.length > 0 ? `  listed but missing: ${vanished.join(', ')}` : null,
      '',
      'The api suite builds its schema with `prisma db push`, not `migrate deploy`',
      '(see the comment at the top of this file). Open the new migration.sql and',
      'decide: if it is a plain table/column/enum change that schema.prisma also',
      'describes, just add its directory name to REVIEWED_MIGRATIONS. If it holds',
      'SQL that db push cannot derive (a function, a trigger, a partial or',
      'expression index, an UNLOGGED table), add an idempotent copy to',
      'POST_PUSH_SQL as well, or the routes that depend on it will be tested',
      'against a database that does not have it.',
    ]
      .filter((line) => line !== null)
      .join('\n')
  );
}

async function waitForPostgres(pool: Pool): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(
    `Test Postgres was not reachable within 60s at the DATABASE_URL from .env.test. ` +
      `Start it with \`podman compose -f docker-compose.test.yml up -d\` and make sure the ` +
      `test runner is attached to the openframe-test network. Last error: ${String(lastError)}`
  );
}

async function pushSchema(): Promise<void> {
  const prismaBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'prisma');
  if (!fs.existsSync(prismaBin)) {
    throw new Error(`Prisma CLI not found at ${prismaBin}. Run \`bun install\` first.`);
  }

  try {
    // Run through the current runtime (bun locally, node on CI) rather than the
    // shebang, so this does not depend on `node` being on PATH.
    await execFileAsync(process.execPath, [prismaBin, 'db', 'push', '--accept-data-loss'], {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `\`prisma db push\` failed against the test database.\n` +
        `${detail.stdout ?? ''}\n${detail.stderr ?? detail.message ?? ''}`
    );
  }
}

async function assertPostPushObjects(pool: Pool): Promise<void> {
  const functions = await pool.query<{ proname: string }>(
    `SELECT proname FROM pg_proc WHERE proname = ANY($1::text[])`,
    [REQUIRED_FUNCTIONS]
  );
  const missingFunctions = REQUIRED_FUNCTIONS.filter(
    (name) => !functions.rows.some((row) => row.proname === name)
  );

  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [REQUIRED_INDEXES]
  );
  const missingIndexes = REQUIRED_INDEXES.filter(
    (name) => !indexes.rows.some((row) => row.indexname === name)
  );

  if (missingFunctions.length > 0 || missingIndexes.length > 0) {
    throw new Error(
      'POST_PUSH_SQL did not produce everything the routes depend on. Missing ' +
        `functions: [${missingFunctions.join(', ')}], indexes: [${missingIndexes.join(', ')}].`
    );
  }
}

export async function setup(): Promise<void> {
  assertMigrationsReviewed();

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 3_000,
  });
  // An idle client dropped by a restarting Postgres emits on the pool, not on a
  // query promise, and an unhandled 'error' would take the whole run down.
  pool.on('error', () => {});

  try {
    await waitForPostgres(pool);
    await pushSchema();
    await pool.query(POST_PUSH_SQL);
    await assertPostPushObjects(pool);
  } finally {
    await pool.end();
  }
}

export async function teardown(): Promise<void> {
  // Nothing to do. The database is left up on purpose so the next run skips the
  // push, and its data directory is a tmpfs that dies with the container.
}
