# Security Policy

## Supported Versions

OpenFrame is under active development.
Security fixes are prioritized for the latest code on `master` and recent release tags (if available).

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues.

Include as much detail as possible:

- Affected area (API route, auth flow, upload flow, etc.)
- Reproduction steps
- Proof of concept (if available)
- Potential impact
- Suggested remediation (optional)

## What to Expect

After a private report is submitted:

1. Maintainers acknowledge receipt.
2. Impact and exploitability are triaged.
3. A fix is prepared and validated.
4. Disclosure timing is coordinated.
5. Credits are given when appropriate.

## Scope Highlights

Security-sensitive areas in this repository include:

- Authentication and session handling in [lib/auth.ts](lib/auth.ts)
- Access control checks in [lib/route-access.ts](lib/route-access.ts)
- Share-link and guest access flows in [lib/share-links.ts](lib/share-links.ts) and [app/watch](app/watch)
- Upload validation and storage paths in [app/api/upload](app/api/upload)
- Billing and webhook handling in [app/api/billing](app/api/billing) and [app/api/stripe/webhook/route.ts](app/api/stripe/webhook/route.ts)

