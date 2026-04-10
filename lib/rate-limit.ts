import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { logError } from '@/lib/logger';

const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const globalForRateLimitCleanup = globalThis as unknown as {
    rateLimitCleanupIntervalStarted?: boolean;
};

interface RateLimitConfig {
    windowMs: number;      // Time window in milliseconds
    maxRequests: number;   // Max requests per window
}

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: Date;
}

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isRateLimitDisabled(): boolean {
    const rawValue = process.env.DISABLE_RATE_LIMIT?.trim().toLowerCase();
    return rawValue !== undefined && TRUTHY_ENV_VALUES.has(rawValue);
}

// Industry-standard rate limit defaults per action
export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
    // Auth — strict to prevent brute force / credential stuffing
    register:       { windowMs: 60 * 60 * 1000, maxRequests: 5 },       // 5 per hour
    login:          { windowMs: 15 * 60 * 1000, maxRequests: 10 },      // 10 per 15 min
    'share-unlock': { windowMs: 15 * 60 * 1000, maxRequests: 20 },      // 20 per 15 min per IP
    'share-unlock-token': { windowMs: 15 * 60 * 1000, maxRequests: 8 }, // 8 per 15 min per IP+token

    // Content creation — moderate limits
    comment:        { windowMs: 60 * 1000, maxRequests: 15 },           // 15 per minute
    'image-upload': { windowMs: 60 * 1000, maxRequests: 20 },           // 20 per minute
    'voice-upload': { windowMs: 60 * 1000, maxRequests: 10 },           // 10 per minute
    'feedback-submit': { windowMs: 60 * 1000, maxRequests: 8 },         // 8 per minute
    'feedback-upload': { windowMs: 60 * 1000, maxRequests: 20 },        // 20 per minute
    'create-project':   { windowMs: 60 * 60 * 1000, maxRequests: 20 },  // 20 per hour
    'create-video':     { windowMs: 60 * 1000, maxRequests: 10 },       // 10 per minute
    'create-version':   { windowMs: 60 * 1000, maxRequests: 10 },       // 10 per minute
    'create-workspace': { windowMs: 60 * 60 * 1000, maxRequests: 10 },  // 10 per hour
    'asset-list':       { windowMs: 60 * 1000, maxRequests: 120 },      // 120 per minute
    'asset-create':     { windowMs: 60 * 1000, maxRequests: 20 },       // 20 per minute
    'asset-delete':     { windowMs: 60 * 1000, maxRequests: 20 },       // 20 per minute
    'asset-download':   { windowMs: 60 * 1000, maxRequests: 10 },       // 10 per minute
    'asset-bunny-init': { windowMs: 60 * 1000, maxRequests: 10 },       // 10 per minute

    // Search — debounced on client but protect against scripted callers
    'search':           { windowMs: 60 * 1000, maxRequests: 60 },        // 60 per minute

    // Watch progress — allow frequent updates but prevent abuse
    'watch-progress':   { windowMs: 60 * 1000, maxRequests: 30 },       // 30 per minute (pausing + periodic + visibility changes)

    // Downloads — strict enough to limit upstream probing/cost abuse
    'video-download':         { windowMs: 60 * 1000, maxRequests: 8 },  // 8 per minute
    'video-download-prepare': { windowMs: 60 * 1000, maxRequests: 5 },  // 5 per minute

    // Member management
    'invite-member':  { windowMs: 60 * 60 * 1000, maxRequests: 30 },    // 30 per hour
    'manage-member':  { windowMs: 60 * 1000, maxRequests: 20 },         // 20 per minute

    // Mutations (update/delete) — moderate
    'mutate':         { windowMs: 60 * 1000, maxRequests: 30 },         // 30 per minute

    // General reads — generous
    api:              { windowMs: 60 * 1000, maxRequests: 100 },        // 100 per minute
};

/**
 * Check and update rate limit for a given key and action
 * Uses PostgreSQL UNLOGGED table for performance
 */
export async function checkRateLimit(
    key: string,
    action: string,
    config?: RateLimitConfig
): Promise<RateLimitResult> {
    const { windowMs, maxRequests } = config || RATE_LIMIT_CONFIGS[action] || RATE_LIMIT_CONFIGS.api;

    if (isRateLimitDisabled()) {
        return {
            allowed: true,
            remaining: maxRequests,
            resetAt: new Date(Date.now() + windowMs),
        };
    }

    const windowSeconds = Math.floor(windowMs / 1000);

    // Validate inputs before passing to query — defence in depth.
    // Prisma's tagged template $queryRaw already parameterizes these values,
    // but we enforce sane bounds to reject obviously malicious input.
    if (key.length > 256 || action.length > 64) {
        return { allowed: true, remaining: maxRequests, resetAt: new Date(Date.now() + windowMs) };
    }

    try {
        // Atomic upsert with window check
        // If window expired, reset count; otherwise increment
        const result = await db.$queryRaw<Array<{
            count: number;
            window_start: Date;
            is_new_window: boolean;
        }>>`
            INSERT INTO rate_limits (key, action, count, window_start)
            VALUES (${key}, ${action}, 1, NOW())
            ON CONFLICT (key, action) DO UPDATE SET
                count = CASE 
                    WHEN rate_limits.window_start < NOW() - (${windowSeconds} || ' seconds')::INTERVAL 
                    THEN 1 
                    ELSE rate_limits.count + 1 
                END,
                window_start = CASE 
                    WHEN rate_limits.window_start < NOW() - (${windowSeconds} || ' seconds')::INTERVAL 
                    THEN NOW() 
                    ELSE rate_limits.window_start 
                END
            RETURNING count, window_start, 
                (window_start = NOW()) as is_new_window
        `;

        const record = result[0];
        const resetAt = new Date(record.window_start.getTime() + windowMs);
        const remaining = Math.max(0, maxRequests - record.count);
        const allowed = record.count <= maxRequests;

        return { allowed, remaining, resetAt };
    } catch (error) {
        // If table doesn't exist, allow the request but log warning
        logError('Rate limit check failed (table may not exist):', error);
        return {
            allowed: true,
            remaining: maxRequests,
            resetAt: new Date(Date.now() + windowMs),
        };
    }
}

// Basic IP format validation — IPv4 or IPv6 (loose check, rejects obvious garbage)
const IP_PATTERN = /^[\da-fA-F.:]+$/;

function isPlausibleIp(value: string): boolean {
    return value.length <= 45 && IP_PATTERN.test(value);
}

/**
 * Get client IP from request headers.
 *
 * Trusting proxy-injected headers is only safe when a known trusted proxy sits in front
 * of this server and strips or overwrites those headers before forwarding requests.
 * Set TRUSTED_PROXY_MODE to opt in:
 *
 *   TRUSTED_PROXY_MODE=cloudflare  — trust cf-connecting-ip (Cloudflare edge)
 *   TRUSTED_PROXY_MODE=nginx       — trust x-real-ip / x-forwarded-for (Nginx real_ip_header)
 *
 * Without TRUSTED_PROXY_MODE set, no proxy headers are trusted: all requests appear
 * as 127.0.0.1, which means rate limits apply per-process rather than per-client IP.
 * In that configuration, prefer session/user-keyed rate limits for authenticated endpoints.
 *
 * WARNING: Do not set TRUSTED_PROXY_MODE unless you have confirmed that your proxy
 * strips or overwrites the corresponding headers on every inbound request. Failing to
 * do so allows clients to spoof their IP and bypass rate limits.
 */
export function getClientIp(request: Request): string {
    const mode = process.env.TRUSTED_PROXY_MODE?.trim().toLowerCase();

    if (mode === 'cloudflare') {
        // cf-connecting-ip is injected by Cloudflare and cannot be set by clients
        // when origin access is restricted to Cloudflare's IP ranges.
        const cfIp = request.headers.get('cf-connecting-ip');
        if (cfIp && isPlausibleIp(cfIp)) {
            return cfIp;
        }
    }

    if (mode === 'nginx') {
        // x-real-ip is set by Nginx's real_ip_header directive (connection-level, not spoofable
        // by clients when set_real_ip_from is configured for the upstream proxy).
        const realIp = request.headers.get('x-real-ip');
        if (realIp && isPlausibleIp(realIp)) return realIp;

        // x-forwarded-for last entry added by Nginx when proxy_add_x_forwarded_for is used.
        const forwardedFor = request.headers.get('x-forwarded-for');
        if (forwardedFor) {
            const entries = forwardedFor.split(',');
            const last = entries[entries.length - 1].trim();
            if (isPlausibleIp(last)) return last;
        }
    }

    // No trusted proxy configured — fall back to a constant value.
    // Rate limiting will apply per-process; use userId-keyed limits for authenticated endpoints.
    return '127.0.0.1';
}

/**
 * Create rate limit headers for response
 */
export function rateLimitHeaders(result: RateLimitResult, maxRequests: number): HeadersInit {
    return {
        'X-RateLimit-Limit': maxRequests.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': Math.floor(result.resetAt.getTime() / 1000).toString(),
    };
}

/**
 * Cleanup old rate limit entries (call periodically)
 */
export async function cleanupRateLimits(): Promise<void> {
    try {
        await db.$executeRaw`SELECT cleanup_rate_limits()`;
    } catch (error) {
        logError('Rate limit cleanup failed:', error);
    }
}

// Start cleanup interval once per process to avoid duplicate scheduling on module reload.
if (!globalForRateLimitCleanup.rateLimitCleanupIntervalStarted && typeof setInterval !== 'undefined') {
    const interval = setInterval(() => {
        cleanupRateLimits().catch((err) => logError('Unexpected error:', err));
    }, RATE_LIMIT_CLEANUP_INTERVAL_MS);

    // Avoid keeping Node.js process alive because of housekeeping timers.
    interval.unref?.();
    globalForRateLimitCleanup.rateLimitCleanupIntervalStarted = true;
}

/**
 * One-call rate limit check that returns a 429 NextResponse if blocked, or null if allowed.
 * Use at the top of any API handler:
 *   const limited = await rateLimit(request, 'comment');
 *   if (limited) return limited;
 */
export async function rateLimit(
    request: Request,
    action: string,
    config?: RateLimitConfig
): Promise<NextResponse | null> {
    const ip = getClientIp(request);
    const cfg = config || RATE_LIMIT_CONFIGS[action] || RATE_LIMIT_CONFIGS.api;
    const result = await checkRateLimit(ip, action, cfg);

    if (!result.allowed) {
        return NextResponse.json(
            { error: 'Too many requests. Please try again later.' },
            {
                status: 429,
                headers: rateLimitHeaders(result, cfg.maxRequests),
            }
        );
    }

    return null;
}
