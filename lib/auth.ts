import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';

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
