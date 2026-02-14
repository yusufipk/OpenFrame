import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';

// Dummy hash for timing-safe comparison when user doesn't exist
// This prevents user enumeration via timing attacks
const DUMMY_HASH = '$2a$12$000000000000000000000uGG3k3xK2CVTxXrT7VW2sGd1XrY6Ky';

export const { handlers, signIn, signOut, auth } = NextAuth({
  // Note: We don't use PrismaAdapter with Credentials + JWT strategy
  // The adapter is for OAuth providers that need to store accounts/sessions in DB
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

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        };
      },
    }),
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
    async session({ session, token }) {
      if (token.sub && session.user) {
        session.user.id = token.sub;
      }
      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      return token;
    },
  },
});

// Helper to check project access including workspace membership
export async function checkProjectAccess(
  project: { id: string; ownerId: string; workspaceId: string; visibility: string },
  userId: string | undefined
) {
  const isOwner = userId === project.ownerId;
  const isPublic = project.visibility === 'PUBLIC';

  // Get project membership
  const projectMember = userId
    ? await db.projectMember.findUnique({
        where: { projectId_userId: { projectId: project.id, userId } },
      })
    : null;
  const isProjectMember = !!projectMember;
  const isProjectAdmin = projectMember?.role === ProjectMemberRole.ADMIN;

  // Check workspace membership
  let workspaceRole: string | null = null;
  if (!isOwner && !isProjectMember && userId) {
    const wsMember = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
    });
    const wsOwner = await db.workspace.findUnique({
      where: { id: project.workspaceId },
      select: { ownerId: true },
    });
    if (wsOwner?.ownerId === userId) {
      workspaceRole = 'OWNER';
    } else if (wsMember) {
      workspaceRole = wsMember.role;
    }
  }
  const isWorkspaceMember = !!workspaceRole;
  const isWorkspaceAdmin = workspaceRole === WorkspaceMemberRole.ADMIN || workspaceRole === 'OWNER';

  const hasAccess = isOwner || isProjectMember || isPublic || isWorkspaceMember;
  const canEdit = isOwner || isProjectAdmin || isWorkspaceAdmin;
  const canDelete = isOwner || workspaceRole === 'OWNER';

  return {
    isOwner,
    isProjectMember,
    isProjectAdmin,
    isWorkspaceMember,
    isWorkspaceAdmin,
    hasAccess,
    canEdit,
    canDelete,
  };
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

  const hasAccess = isOwner || isMember;
  const canEdit = isOwner || isAdmin;
  const canDelete = isOwner;

  return {
    isOwner,
    isMember,
    isAdmin,
    hasAccess,
    canEdit,
    canDelete,
  };
}
