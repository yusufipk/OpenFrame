# AGENTS.md

## Must-follow constraints

- Use `bun` only. Do not use `npm` or `pnpm`.
- Do not start the dev server (`bun run dev`); assume it is already running.
- If you change `prisma/schema.prisma`, run `bun run db:generate`.
- In App Router dynamic routes, keep `params` typed as `Promise<...>` and `await params` in handlers/pages.

## Validation before finishing

- Run `bun run check`.

## Repo-specific conventions

- Use `auth()` from `@/lib/auth` for server-side session reads.
- Use `checkProjectAccess()` / `checkWorkspaceAccess()` for authorization instead of ad-hoc role checks.
- For API responses, use `successResponse` / `apiErrors` from `@/lib/api-response`.
- Keep API and UI imports on `@/` aliases when available.
- In Prisma raw SQL, use `$executeRaw` for statements that return no rows (e.g. `pg_advisory_xact_lock`). Using `$queryRaw` on void-returning functions causes a Prisma deserialization error (`Failed to deserialize column of type 'void'`).

## Important locations

- Custom SQL managed by Prisma migrations: `prisma/migrations/*/migration.sql`.
- Shared API response helpers: `lib/api-response.ts`.
- Auth + access-control helpers: `lib/auth.ts`.

## Change safety rules

- Prefer backward-compatible API changes unless explicitly asked to break contracts.
- For multi-step DB writes, use Prisma transactions.
