import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import { PrismaAdapter } from '@auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';
import { hasBillingAccess, startCardlessTrialOnSignup } from '@/lib/billing';
import { isInviteCodeRequired } from '@/lib/feature-flags';
import { isEmailVerificationEnabled } from '@/lib/email-verification';

// Dummy hash for timing-safe comparison when user doesn't exist
// This prevents user enumeration via timing attacks
const DUMMY_HASH = '$2a$12$000000000000000000000uGG3k3xK2CVTxXrT7VW2sGd1XrY6Ky';

export const { handlers, signIn, signOut, auth } = NextAuth({
  // PrismaAdapter handles OAuth account linking and user creation in DB.
  // JWT strategy is still used for sessions (no DB sessions table needed).
  adapter: PrismaAdapter(db),
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        // Find user by email
        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
        });

        // Always perform bcrypt comparison to prevent timing attacks
        // If user doesn't exist, compare against dummy hash
        const hashToCompare = user?.password || DUMMY_HASH;
        const isValidPassword = await bcrypt.compare(password, hashToCompare);

        // Only return user if they exist AND password is valid
        if (!user || !user.password || !isValidPassword) {
          return null;
        }

        // Block sign-in when email verification is required but not yet completed
        if (isEmailVerificationEnabled() && !user.emailVerified) {
          return null;
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        };
      },
    }),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? [
          {
            ...GitHub({
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            }),
            // GitHub sends iss=https://github.com/login/oauth in callbacks (RFC 9207).
            // Auth.js v5 beta defaults to "https://authjs.dev" for OAuth providers, causing
            // a mismatch. Setting the correct issuer here fixes the CallbackRouteError.
            issuer: 'https://github.com/login/oauth',
          },
        ]
      : []),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: '/login',
    signOut: '/signout',
  },
  callbacks: {
    async signIn({ account, profile }) {
      // Credentials sign-in is handled by the authorize() function above
      if (account?.provider === 'credentials') return true;

      // Reject OAuth sign-ins where the provider email is not verified.
      // Google always sets email_verified: true. GitHub does not guarantee it.
      if (profile && profile.email_verified === false) {
        return '/login?error=OAuthEmailNotVerified';
      }

      // OAuth sign-in: allow existing OAuth accounts regardless of invite setting
      if (account?.providerAccountId && account?.provider) {
        const existingAccount = await db.account.findUnique({
          where: {
            provider_providerAccountId: {
              provider: account.provider,
              providerAccountId: account.providerAccountId,
            },
          },
          select: { id: true },
        });
        if (existingAccount) return true;
      }

      // New OAuth user: block when invite-only mode is active
      if (isInviteCodeRequired()) {
        return '/login?error=RegistrationClosed';
      }

      return true;
    },
    async session({ session, token }) {
      if (token.sub && session.user) {
        session.user.id = token.sub;
        session.user.name = token.name || null;
        session.user.isAdmin = token.isAdmin as boolean;
      }
      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.name = user.name;
        token.email = user.email; // explicitly ensure email is in the token
      }

      // Check if user is admin based on emails list on EVERY request to ensure env changes are picked up
      if (token.email) {
        const adminEmails = process.env.ADMIN_EMAILS
          ? process.env.ADMIN_EMAILS.split(',').map((e: string) => e.trim().toLowerCase())
          : [];
        token.isAdmin = adminEmails.includes((token.email as string).toLowerCase());
      }

      return token;
    },
  },
  events: {
    // The OAuth half of signup. Accounts created by Google or GitHub are written
    // by the Prisma adapter and never reach app/api/auth/register, so recording
    // the event only there would have made every social signup invisible in the
    // funnel while looking like it worked.
    async createUser({ user }) {
      if (!user.id) return;
      const { recordSignupCompleted, readVisitorContextFromHeaders } =
        await import('@/lib/analytics/signup');
      await recordSignupCompleted({
        userId: user.id,
        visitor: await readVisitorContextFromHeaders(),
      });

      // And the trial with it, for the same reason: the two places that grant it
      // are the credentials signup route and the verification link, and a social
      // signup goes through neither. Without this a Google account reaches a
      // locked product and a checkout that no longer offers a trial, which is the
      // opposite of what the signup page promised it. The address is already
      // proven here: the signIn callback above turns away an OAuth profile that
      // reports its email as unverified.
      await startCardlessTrialOnSignup(user.id);
    },
  },
});

// ---------------------------------------------------------------------------
// Fast-path: pre-fetch access data alongside any existing DB query so that
// computeProjectAccess() can resolve the result with zero extra round-trips.
// ---------------------------------------------------------------------------

/** Prisma include fragment to attach to any project fetch. */
export function projectAccessInclude(userId: string | undefined) {
  return {
    workspace: {
      select: {
        id: true,
        ownerId: true,
        owner: {
          select: {
            subscriptionStatus: true,
            trialEndsAt: true,
            stripeCurrentPeriodEnd: true,
            billingAccessEndedAt: true,
          },
        },
        members: userId
          ? {
              where: { userId },
              take: 1,
              orderBy: { createdAt: 'asc' as const },
              select: { role: true },
            }
          : { take: 0, select: { role: true } },
      },
    },
    members: userId
      ? {
          where: { userId },
          take: 1,
          orderBy: { createdAt: 'asc' as const },
          select: { role: true },
        }
      : { take: 0, select: { role: true } },
  };
}

type ProjectAccessIncludes = ReturnType<typeof projectAccessInclude>;
type WorkspaceForAccess = ProjectAccessIncludes['workspace']['select'] extends object
  ? {
      id: string;
      ownerId: string;
      owner: Parameters<typeof hasBillingAccess>[0] | null;
      members: Array<{ role: WorkspaceMemberRole }>;
    }
  : never;

export type EnrichedProjectForAccess = {
  id: string;
  ownerId: string;
  workspaceId: string;
  visibility: string;
  workspace: WorkspaceForAccess;
  members: Array<{ role: ProjectMemberRole }>;
};

/**
 * The project permission formulas, in one place.
 *
 * Two functions resolve the same six inputs by different routes:
 * `computeProjectAccess` reads them off a project that was fetched with
 * `projectAccessInclude()`, and `checkProjectAccess` queries for each relation.
 * They then have to agree on what those inputs mean. Both used to carry a
 * verbatim copy of the three formulas below, which is a silent-divergence
 * hazard rather than a style complaint: change an authorization rule in one
 * copy and not the other and a page renders for somebody the API would refuse.
 */
function resolveProjectPermissions(input: {
  isOwner: boolean;
  isPublic: boolean;
  isProjectMember: boolean;
  isProjectAdmin: boolean;
  workspaceRole: WorkspaceMemberRole | 'OWNER' | null;
  ownerBillingActive: boolean;
}) {
  const { isOwner, isPublic, isProjectMember, isProjectAdmin, workspaceRole, ownerBillingActive } =
    input;

  const isWorkspaceMember = !!workspaceRole;
  const isWorkspaceAdmin = workspaceRole === WorkspaceMemberRole.ADMIN || workspaceRole === 'OWNER';

  return {
    isOwner,
    isProjectMember,
    isProjectAdmin,
    isWorkspaceMember,
    isWorkspaceAdmin,
    hasAccess: ownerBillingActive && (isOwner || isProjectMember || isPublic || isWorkspaceMember),
    canEdit: ownerBillingActive && (isOwner || isProjectAdmin || isWorkspaceAdmin),
    canDelete: ownerBillingActive && (isOwner || workspaceRole === 'OWNER'),
    ownerBillingActive,
  };
}

/**
 * The workspace permission formulas. Only one caller today, but it is kept
 * beside its project twin and exported so it can be tested directly rather
 * than only through whichever route happens to exercise it.
 */
export function resolveWorkspacePermissions(input: {
  isOwner: boolean;
  isMember: boolean;
  isAdmin: boolean;
  ownerBillingActive: boolean;
}) {
  const { isOwner, isMember, isAdmin, ownerBillingActive } = input;

  return {
    isOwner,
    isMember,
    isAdmin,
    hasAccess: ownerBillingActive && (isOwner || isMember),
    canEdit: ownerBillingActive && (isOwner || isAdmin),
    canDelete: ownerBillingActive && isOwner,
    ownerBillingActive,
  };
}

/**
 * Pure access computation, no DB queries.
 * Use after fetching a project with `projectAccessInclude(userId)`.
 */
export function computeProjectAccess(
  project: EnrichedProjectForAccess,
  userId: string | undefined
) {
  const isOwner = userId === project.ownerId;
  const isPublic = project.visibility === 'PUBLIC';

  const projectMember = project.members[0] ?? null;
  const isProjectMember = !!projectMember;
  const isProjectAdmin = projectMember?.role === ProjectMemberRole.ADMIN;

  const workspaceOwnerBillingAccess = project.workspace.owner
    ? hasBillingAccess(project.workspace.owner)
    : false;

  let workspaceRole: WorkspaceMemberRole | 'OWNER' | null = null;
  if (userId === project.workspace.ownerId) {
    workspaceRole = 'OWNER';
  } else {
    const wsMember = project.workspace.members[0] ?? null;
    if (wsMember) workspaceRole = wsMember.role;
  }

  return resolveProjectPermissions({
    isOwner,
    isPublic,
    isProjectMember,
    isProjectAdmin,
    workspaceRole,
    ownerBillingActive: workspaceOwnerBillingAccess,
  });
}

/**
 * Helper to check project access including workspace membership.
 *
 * This used to take an `intent`, which skipped both workspace queries for an owner at
 * `view` intent. That made it report `isWorkspaceMember: false, isWorkspaceAdmin: false`
 * for the actor computeProjectAccess reports `true, true` for: the project owner who also
 * owns the workspace, which is the shape every real signup produces. The two are meant to
 * answer the same question, so they resolve their inputs the same way now and the option
 * is gone rather than kept as a parameter that changes nothing.
 */
export async function checkProjectAccess(
  project: { id: string; ownerId: string; workspaceId: string; visibility: string },
  userId: string | undefined,
  client: import('@prisma/client').Prisma.TransactionClient = db
) {
  const isOwner = userId === project.ownerId;
  const isPublic = project.visibility === 'PUBLIC';

  // Get project membership
  const projectMember = userId
    ? await client.projectMember.findUnique({
        where: { projectId_userId: { projectId: project.id, userId } },
      })
    : null;
  const isProjectMember = !!projectMember;
  const isProjectAdmin = projectMember?.role === ProjectMemberRole.ADMIN;

  // The workspace role decides `canEdit`/`isWorkspaceMember`, not just whether the viewer
  // gets in at all, so it is resolved for every signed-in caller, owners included. The two
  // queries run together, so this costs one extra indexed lookup and no extra latency.
  const [wsMember, wsOwner] = await Promise.all([
    userId
      ? client.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
        })
      : null,
    client.workspace.findUnique({
      where: { id: project.workspaceId },
      select: {
        ownerId: true,
        owner: {
          select: {
            subscriptionStatus: true,
            trialEndsAt: true,
            stripeCurrentPeriodEnd: true,
            billingAccessEndedAt: true,
          },
        },
      },
    }),
  ]);

  let workspaceRole: WorkspaceMemberRole | 'OWNER' | null = null;
  if (userId && wsOwner?.ownerId === userId) {
    workspaceRole = 'OWNER';
  } else if (wsMember) {
    workspaceRole = wsMember.role;
  }

  const workspaceOwnerBillingAccess = wsOwner?.owner ? hasBillingAccess(wsOwner.owner) : false;

  return resolveProjectPermissions({
    isOwner,
    isPublic,
    isProjectMember,
    isProjectAdmin,
    workspaceRole,
    ownerBillingActive: workspaceOwnerBillingAccess,
  });
}

// Helper to check workspace access
export async function checkWorkspaceAccess(
  workspace: { id: string; ownerId: string },
  userId: string | undefined
) {
  const isOwner = userId === workspace.ownerId;

  // Get workspace membership
  const workspaceMember = userId
    ? await db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
      })
    : null;
  const isMember = !!workspaceMember;
  const isAdmin = workspaceMember?.role === WorkspaceMemberRole.ADMIN;

  const owner = await db.user.findUnique({
    where: { id: workspace.ownerId },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      stripeCurrentPeriodEnd: true,
      billingAccessEndedAt: true,
    },
  });
  const ownerBillingActive = owner ? hasBillingAccess(owner) : false;

  return resolveWorkspacePermissions({ isOwner, isMember, isAdmin, ownerBillingActive });
}
