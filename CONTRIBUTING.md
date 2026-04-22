# Contributing to OpenFrame

Thanks for taking the time to contribute.
This guide covers setup, PR expectations, and required conventions.

## Local setup

1. Install dependencies.

```bash
bun install
```

2. Copy environment variables.

```bash
cp .env.example .env
```

3. Generate Prisma client.

```bash
bun run db:generate
```

4. Run validation.

```bash
bun run check
```

## Contribution workflow

1. Fork and create a branch from `master`.
2. Keep changes focused on one logical concern.
3. Follow repository conventions in this file.
4. Run required checks locally.
5. Open a PR with a clear summary and checklist.

## Branch naming

- `feature/<short-topic>`
- `fix/<short-topic>`
- `docs/<short-topic>`
- `refactor/<short-topic>`
- `chore/<short-topic>`

## Commit and PR title standard

Use Conventional Commits with this pattern:

```text
type(scope): short summary
```

## Required checks before opening a PR

- Run `bun run check`.
- If `prisma/schema.prisma` changed, run `bun run db:generate`.
- Ensure no unrelated file changes are included.
- Ensure no secrets or private keys are committed.
- Update docs when behavior changes.

## Project conventions (must follow)

- Use Bun commands only.
- Server-side session reads must use `auth()` from [lib/auth.ts](lib/auth.ts).
- Access control should use `checkProjectAccess()` / `checkWorkspaceAccess()`.
- API responses should use `successResponse` / `apiErrors` from [lib/api-response.ts](lib/api-response.ts).
- In App Router dynamic routes, keep `params` typed as `Promise<...>` and use `await params`.
- For multi-step DB writes, use Prisma transactions.
- Prefer backward-compatible API changes unless a breaking change is explicitly requested.
- Prefer `@/` imports when available.

## Security issues

Do not open public issues for vulnerabilities.
Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Need help?

If you are unsure where to start, open an issue with context and a proposed approach.
