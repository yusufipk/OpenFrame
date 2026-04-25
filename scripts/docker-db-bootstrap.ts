import 'dotenv/config';
import { Client } from 'pg';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { logError } from '@/lib/logger';

type MigrationRow = {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};

async function runPrisma(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('./node_modules/.bin/prisma', args, {
      stdio: 'inherit',
      env: process.env,
    });

    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Prisma command failed: prisma ${args.join(' ')}`));
    });
  });
}

async function tableExists(client: Client, tableName: string) {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS "exists"
    `,
    [tableName]
  );

  return result.rows[0]?.exists ?? false;
}

async function getMigrationRows(client: Client) {
  const hasMigrationsTable = await tableExists(client, '_prisma_migrations');
  if (!hasMigrationsTable) return [];

  const result = await client.query<MigrationRow>(
    `
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY started_at ASC
    `
  );

  return result.rows;
}

function getMigrationDirectories() {
  return readdirSync(join(process.cwd(), 'prisma', 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function getPublicTables(client: Client) {
  const result = await client.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `
  );

  return result.rows.map((row) => row.table_name);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const [publicTables, migrationRows] = await Promise.all([
      getPublicTables(client),
      getMigrationRows(client),
    ]);

    const appTables = publicTables.filter((table) => table !== '_prisma_migrations');
    const hasUsersTable = appTables.includes('users');
    const hasWorkspacesTable = appTables.includes('workspaces');
    const hasProjectsTable = appTables.includes('projects');
    const hasCoreTables = hasUsersTable || hasWorkspacesTable || hasProjectsTable;
    const failedMigrations = migrationRows.filter((row) => !row.finished_at && !row.rolled_back_at);
    const shouldBootstrapFreshSchema = !hasCoreTables;

    console.log(
      `Detected public tables: ${appTables.length > 0 ? appTables.join(', ') : '(none)'}`
    );

    if (shouldBootstrapFreshSchema) {
      if (failedMigrations.length > 0) {
        console.log(
          'Detected failed migration state on a fresh database. Marking failed migrations as rolled back.'
        );
        for (const migration of failedMigrations) {
          await runPrisma(['migrate', 'resolve', '--rolled-back', migration.migration_name]);
        }
      }

      console.log('Fresh self-hosted database detected. Synchronizing schema baseline.');
      await runPrisma(['db', 'push']);

      const appliedMigrationNames = new Set(
        migrationRows
          .filter((row) => row.finished_at && !row.rolled_back_at)
          .map((row) => row.migration_name)
      );

      for (const migrationName of getMigrationDirectories()) {
        if (appliedMigrationNames.has(migrationName)) continue;
        await runPrisma(['migrate', 'resolve', '--applied', migrationName]);
      }

      console.log('Fresh database bootstrap complete');
      return;
    }

    if (failedMigrations.length > 0) {
      throw new Error(
        `Detected failed Prisma migrations on a non-empty database: ${failedMigrations
          .map((migration) => migration.migration_name)
          .join(', ')}`
      );
    }

    console.log('Running Prisma migrations');
    await runPrisma(['migrate', 'deploy']);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  logError('Docker database bootstrap failed:', error);
  process.exit(1);
});
