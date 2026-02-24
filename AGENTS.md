# AGENTS.md

## Must-follow constraints
- Use `bun` only. Do not use `npm` or `pnpm`.
- Do not start the dev server (`bun run dev`); assume it is already running.
- If you change `prisma/schema.prisma`, run `bun run db:generate`.
- In App Router dynamic routes, keep `params` typed as `Promise<...>` and `await params` in handlers/pages.

## Validation before finishing
- Run `bun run check`.
- Run `bun test <path>` for changed behavior; run `bun test` when changes are cross-cutting.

## Repo-specific conventions
- Use `auth()` from `@/lib/auth` for server-side session reads.
- Use `checkProjectAccess()` / `checkWorkspaceAccess()` for authorization instead of ad-hoc role checks.
- For API responses, use `successResponse` / `apiErrors` from `@/lib/api-response`.
- Keep API and UI imports on `@/` aliases when available.

## Important locations
- Custom SQL not managed by Prisma migrations: `prisma/migrations/*.sql` and runner `scripts/db-extras.ts`.
- Shared API response helpers: `lib/api-response.ts`.
- Auth + access-control helpers: `lib/auth.ts`.

## Change safety rules
- Prefer backward-compatible API changes unless explicitly asked to break contracts.
- For multi-step DB writes, use Prisma transactions.
