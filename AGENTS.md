# AGENTS.md - Agent Coding Guidelines

This document provides guidelines for agents working on the OpenFrame project.

## Project Overview

OpenFrame is a Next.js 16 video sharing platform with:
- Next.js 16 App Router, TypeScript with strict mode, Tailwind CSS v4
- Prisma ORM with PostgreSQL, NextAuth v5 (Auth.js), shadcn/ui components

---

## Build & Development Commands

### Core Commands

```bash
bun run dev              # Start Next.js dev server
bun run build            # Build for production (runs typecheck first)
bun run typecheck        # Run TypeScript type checking only
bun run lint             # Run ESLint
bun run check            # typecheck + lint you should run this one
bun test                 # Run all tests
bun test path/to/test.ts # Run specific test file
```

### Database Commands

```bash
bun run db:generate      # Generate Prisma client
bun run db:push          # Push schema to database
bun run db:migrate       # Run database migrations
bun run db:seed          # Seed database
bun run db:setup         # Full DB setup: generate + push + extras
```

### Important Notes

- **Always use bun** - Never use npm or pnpm.
- Pre-build runs typecheck automatically via `prebuild` script.
- Post-install runs `prisma generate` automatically.
- Do not run dev server. Assume already running.

---

## Code Style Guidelines

### TypeScript

- **Strict mode enabled** - All TypeScript strict checks are on
- Use explicit types for function parameters and return types
- Use `interface` for public APIs, `type` for unions/intersections
- Avoid `any` - use `unknown` when type is truly unknown
- Use optional chaining (`?.`) and nullish coalescing (`??`)

```typescript
// Good
function getUserById(id: string): Promise<User | null>
const name = user?.name ?? 'Anonymous'

// Avoid
function getUser(id) // Missing types
```

### Imports & Path Aliases

- Use `@/` prefix for absolute imports (configured in tsconfig.json)
- Order: React/Next → External libs → Internal modules (@/) → Relative

```typescript
import { useState, useEffect } from 'react'
import { z } from 'zod'
import { db } from '@/lib/db'
import { cn } from '@/lib/utils'
```

### Components

- Use functional components with TypeScript
- Use shadcn/ui components from `components/ui/`
- Use `cva` (class-variance-authority) for component variants
- Use Radix UI primitives for accessible interactive components

```typescript
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva("...", {
  variants: {
    variant: { default: "...", destructive: "..." },
    size: { default: "...", sm: "..." },
  },
  defaultVariants: { variant: "default", size: "default" },
})

function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
```

### Naming Conventions

- **Files**: kebab-case for utilities (`rate-limit.ts`), PascalCase for components (`VideoCard.tsx`)
- **Components**: PascalCase (`Button`, `VideoCard`)
- **Functions**: camelCase (`getUserById`, `validateUrl`)
- **Booleans**: Use `is`, `has`, `can`, `should` prefixes (`isLoading`, `hasAccess`)

### Error Handling

- Use try/catch with async/await
- Return typed error results or use error boundaries
- Log errors with console.error for server-side

```typescript
async function createProject(data: CreateProjectInput) {
  try {
    const project = await db.project.create({ data })
    return { success: true, data: project }
  } catch (error) {
    console.error('Failed to create project:', error)
    return { success: false, error: 'Failed to create project' }
  }
}
```

### Database (Prisma)

- Use Prisma client from `@/lib/db`
- Use transactions for multi-step operations
- Include relations with `include` or `select`

```typescript
const project = await db.project.findUnique({
  where: { id: projectId },
  include: { owner: true, videos: true },
})
```

### Authentication

- Use NextAuth v5 from `@/lib/auth`
- Use `auth()` for getting current session in server components
- Use `checkProjectAccess()` and `checkWorkspaceAccess()` helpers for authorization

### Styling

- Use Tailwind CSS v4
- Use `cn()` utility for conditional class merging
- Components use `rounded-none` as default (per project design)

### Next.js Patterns

- Server components by default, add `'use client'` only when needed
- Use loading.tsx for loading states
- Use error.tsx for error boundaries, not-found.tsx for 404 pages

### File Organization

```
app/              # Next.js App Router pages
components/ui/    # shadcn/ui components
lib/              # Utilities (db.ts, auth.ts, utils.ts, validation.ts)
prisma/           # Database schema
```

---

## Additional Guidelines

1. **Run check before committing** - `bun run check` must pass
2. **Environment variables** - Copy `.env.example` to `.env`
3. **Database changes** - After modifying Prisma schema, run `bun run db:generate`
