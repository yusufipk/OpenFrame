import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  createVerificationToken,
  isEmailVerificationEnabled,
  sendVerificationEmail,
} from '@/lib/email-verification';
import { logError } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    if (!isEmailVerificationEnabled()) {
      return apiErrors.badRequest('Email verification is not enabled');
    }

    // Rate-limit by IP to prevent abuse
    const clientIp = getClientIp(request);
    const rateLimitResult = await checkRateLimit(
      `resend-verification:${clientIp}`,
      'resend-verification'
    );
    if (!rateLimitResult.allowed) {
      return apiErrors.rateLimited('Too many requests. Please try again later.');
    }

    const body = await request.json();
    const { email } = body;

    if (!email || typeof email !== 'string' || email.length > 254 || !email.includes('@')) {
      return apiErrors.badRequest('Valid email is required');
    }

    const normalizedEmail = email.toLowerCase().trim();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return apiErrors.badRequest('Valid email is required');
    }

    // Look up user — return a generic success regardless of whether the email
    // exists to avoid user enumeration
    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, emailVerified: true },
    });

    if (user && !user.emailVerified) {
      const token = await createVerificationToken(normalizedEmail);
      await sendVerificationEmail(normalizedEmail, token);
    }

    return withCacheControl(
      successResponse({
        message: 'If that email has an unverified account, a new verification link has been sent.',
      }),
      'private, no-store'
    );
  } catch (err) {
    logError('Resend verification error:', err);
    return apiErrors.internalError('Failed to resend verification email');
  }
}
