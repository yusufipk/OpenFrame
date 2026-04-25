## Summary

<!-- Explain what changed in this PR. -->

## Why

<!-- Explain the problem this PR solves. -->

## Scope

What areas are affected?

- [ ] API routes
- [ ] Auth / access control
- [ ] Database schema / migration
- [ ] UI / UX
- [ ] Documentation
- [ ] Other

## Before opening PR

- [ ] I have read [CONTRIBUTING.md](CONTRIBUTING.md) and followed repository conventions.
- [ ] I ran `bun run check`.
- [ ] I ran `bun run db:generate` if `prisma/schema.prisma` changed.
- [ ] I manually tested affected flows.
- [ ] PR title follows Conventional Commits (`type(scope): summary`).
- [ ] I used `successResponse` / `apiErrors` for API response changes.
- [ ] I used `auth()` and shared access checks (`checkProjectAccess` / `checkWorkspaceAccess`) where relevant.
- [ ] I updated docs when behavior changed.
- [ ] No secrets or unrelated file changes are included.

Validation notes:

```text
Paste command output or manual test notes here.
```

## Breaking changes

- [ ] No breaking changes
- [ ] This PR introduces a breaking change (describe below)

<!-- If breaking, explain migration path. -->

## Database / migration notes

<!-- If schema changed, summarize migration impact. -->

## Screenshots / examples (if relevant)

<!-- Add screenshots or API request/response examples. -->
