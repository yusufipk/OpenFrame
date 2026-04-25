import { NextRequest, NextResponse } from 'next/server';
import { consumeVerificationToken } from '@/lib/email-verification';
import { rateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/logger';

// A raw 32-byte hex token is exactly 64 characters.
const TOKEN_REGEX = /^[0-9a-f]{64}$/;

export async function GET(request: NextRequest) {
  try {
    // Rate-limit by IP to prevent token enumeration attacks.
    const limited = await rateLimit(request, 'verify-email');
    if (limited) return limited;

    const token = request.nextUrl.searchParams.get('token');

    if (!token || !TOKEN_REGEX.test(token.trim())) {
      return NextResponse.redirect(new URL('/login?error=InvalidVerificationToken', request.url));
    }

    const email = await consumeVerificationToken(token.trim());

    if (!email) {
      return NextResponse.redirect(new URL('/login?error=InvalidVerificationToken', request.url));
    }

    return NextResponse.redirect(new URL('/login?verified=true', request.url));
  } catch (err) {
    logError('Email verification error:', err);
    return NextResponse.redirect(new URL('/login?error=VerificationFailed', request.url));
  }
}
