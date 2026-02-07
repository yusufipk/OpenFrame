import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { checkRateLimit, getClientIp, rateLimitHeaders, RATE_LIMIT_CONFIGS } from '@/lib/rate-limit';
import { apiErrors, successResponse, ErrorCode, withCacheControl } from '@/lib/api-response';

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
        const { name, email, password, inviteCode } = body;

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

        // Validate required fields
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return apiErrors.badRequest('Name must be at least 2 characters');
        }

        if (!email || typeof email !== 'string') {
            return apiErrors.badRequest('Email is required');
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return apiErrors.validationError('Invalid email format');
        }

        if (!password || typeof password !== 'string' || password.length < 8) {
            return apiErrors.badRequest('Password must be at least 8 characters');
        }

        // Check if email already exists
        const existingUser = await db.user.findUnique({
            where: { email: email.toLowerCase() },
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
                email: email.toLowerCase(),
                password: hashedPassword,
            },
            select: {
                id: true,
                name: true,
                email: true,
                createdAt: true,
            },
        });

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
