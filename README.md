# OpenFrame

OpenFrame is a collaborative video feedback platform built with Next.js, Bun, Prisma, and PostgreSQL.

## Development

Install dependencies and run checks with Bun:

```bash
bun install
bun run check
```

## Self-hosting flags

OpenFrame supports env flags so self-hosted installs can disable hosted-only features without code changes:

```bash
OPENFRAME_ENABLE_STRIPE=true
OPENFRAME_ENABLE_BUNNY_UPLOADS=true
OPENFRAME_REQUIRE_INVITE_CODE=true
```

Recommended self-hosted values for a single-team deployment:

```bash
OPENFRAME_ENABLE_STRIPE=false
OPENFRAME_ENABLE_BUNNY_UPLOADS=false
OPENFRAME_REQUIRE_INVITE_CODE=false
```

Behavior when disabled:

- `OPENFRAME_ENABLE_STRIPE=false`: disables Stripe checkout and portal flows and removes billing-based workspace restrictions.
- `OPENFRAME_ENABLE_BUNNY_UPLOADS=false`: hides direct-upload entry points. URL-based providers such as YouTube continue to work.
- `OPENFRAME_REQUIRE_INVITE_CODE=false`: allows open registration while keeping invitation-link registration intact.

Feature flags are documented in `.env.example`. Hosted defaults remain enabled.
