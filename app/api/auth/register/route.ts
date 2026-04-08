import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { acceptInvitationTokenForUser, getValidInvitationByToken } from '@/lib/invitations';
import { checkRateLimit, getClientIp, rateLimitHeaders, RATE_LIMIT_CONFIGS } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isInviteCodeRequired } from '@/lib/feature-flags';

export async function POST(request: NextRequest) {
    try {
        // Rate limiting by IP
        const clientIp = getClientIp(request);
        const rateLimitKey = `register:${clientIp}`;
        const rateLimit = await checkRateLimit(rateLimitKey, 'register');

        if (!rateLimit.allowed) {
            return apiErrors.rateLimited('Too many registration attempts. Please try again later.');
        }

        const body = await request.json();
        const { name, email, password, inviteCode, invitationToken } = body;

        // Validate required fields
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return apiErrors.badRequest('Name must be at least 2 characters');
        }

        if (!email || typeof email !== 'string') {
            return apiErrors.badRequest('Email is required');
        }
        const normalizedEmail = email.toLowerCase().trim();

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
            return apiErrors.validationError('Invalid email format');
        }

        // Allow registration via a valid invitation token OR global invite code.
        let invitationIsValid = false;
        let validatedInvitationToken: string | null = null;
        if (typeof invitationToken === 'string' && invitationToken.trim()) {
            const normalizedToken = invitationToken.trim();
            const invitation = await getValidInvitationByToken(normalizedToken);
            if (invitation && invitation.email === normalizedEmail) {
                invitationIsValid = true;
                validatedInvitationToken = normalizedToken;
            } else {
                return apiErrors.forbidden('Invalid or expired invitation token');
            }
        }

        if (!invitationIsValid && isInviteCodeRequired()) {
            // Validate invite code using constant-time comparison to prevent timing attacks
            const validInviteCode = process.env.INVITE_CODE;
            if (!validInviteCode || !inviteCode) {
                return apiErrors.forbidden('Invalid invite code');
            }

            // Constant-time comparison
            const { timingSafeEqual } = await import('crypto');
            const validBuffer = Buffer.from(validInviteCode);
            const providedBuffer = Buffer.from(String(inviteCode));

            // Ensure same length for comparison (prevents length-based timing leak)
            const isValidLength = validBuffer.length === providedBuffer.length;
            const compareBuffer = isValidLength ? providedBuffer : validBuffer;
            const isValidCode = isValidLength && timingSafeEqual(validBuffer, compareBuffer);

            if (!isValidCode) {
                return apiErrors.forbidden('Invalid invite code');
            }
        }

        if (!password || typeof password !== 'string' || password.length < 8) {
            return apiErrors.badRequest('Password must be at least 8 characters');
        }

        // Check if email already exists
        const existingUser = await db.user.findUnique({
            where: { email: normalizedEmail },
        });

        if (existingUser) {
            return apiErrors.conflict('An account with this email already exists');
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Create user
        const user = await db.user.create({
            data: {
                name: name.trim(),
                email: normalizedEmail,
                password: hashedPassword,
            },
            select: {
                id: true,
                name: true,
                email: true,
                createdAt: true,
            },
        });

        if (validatedInvitationToken) {
            const result = await acceptInvitationTokenForUser({
                token: validatedInvitationToken,
                userId: user.id,
                email: normalizedEmail,
            });
            if (result !== 'accepted') {
                await db.user.delete({ where: { id: user.id } });
                return apiErrors.conflict('Invitation could not be accepted. Please request a new invitation.');
            }
        }

        const response = successResponse(
            { message: 'Account created successfully', user },
            201
        );

        // Add rate limit headers to successful response
        const headers = rateLimitHeaders(rateLimit, RATE_LIMIT_CONFIGS.register.maxRequests);
        Object.entries(headers).forEach(([key, value]) => {
            response.headers.set(key, value);
        });

        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        console.error('Registration error:', error);
        return apiErrors.internalError('Failed to create account');
    }
}
