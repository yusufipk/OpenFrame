import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import nodemailer from 'nodemailer';
import { testEmailHtml } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

// GET /api/settings/notifications — Fetch current notification preferences
export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const settings = await db.notificationSetting.findUnique({
            where: { userId: session.user.id },
        });

        // Return defaults if no settings exist yet
        const response = successResponse(
            settings ?? {
                telegramChatId: null,
                telegramEnabled: false,
                emailEnabled: false,
                onNewVideo: true,
                onNewVersion: true,
                onNewComment: true,
                onNewReply: true,
                onApprovalEvents: true,
                timezone: 'UTC',
            }
        );

        return withCacheControl(response, 'private, max-age=30, stale-while-revalidate=60');
    } catch (error) {
        logError('Error fetching notification settings:', error);
        return apiErrors.internalError('Failed to fetch settings');
    }
}

// PUT /api/settings/notifications — Update notification preferences
export async function PUT(request: NextRequest) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const body = await request.json();
        const {
            telegramChatId,
            telegramEnabled,
            emailEnabled,
            onNewVideo,
            onNewVersion,
            onNewComment,
            onNewReply,
            onApprovalEvents,
            timezone,
        } = body;

        // Validate: if enabling Telegram, chatId is required and must be a valid Telegram ID
        if (telegramChatId && !/^-?\d{1,20}$/.test(telegramChatId)) {
            return apiErrors.badRequest('Invalid Chat ID format');
        }
        if (telegramEnabled && !telegramChatId) {
            return apiErrors.badRequest('Chat ID is required to enable Telegram notifications');
        }

        const settings = await db.notificationSetting.upsert({
            where: { userId: session.user.id },
            create: {
                userId: session.user.id,
                telegramChatId: telegramChatId || null,
                telegramEnabled: !!telegramEnabled,
                emailEnabled: !!emailEnabled,
                onNewVideo: onNewVideo ?? true,
                onNewVersion: onNewVersion ?? true,
                onNewComment: onNewComment ?? true,
                onNewReply: onNewReply ?? true,
                onApprovalEvents: onApprovalEvents ?? true,
                timezone: timezone || 'UTC',
            },
            update: {
                telegramChatId: telegramChatId || null,
                telegramEnabled: !!telegramEnabled,
                emailEnabled: !!emailEnabled,
                onNewVideo: onNewVideo ?? true,
                onNewVersion: onNewVersion ?? true,
                onNewComment: onNewComment ?? true,
                onNewReply: onNewReply ?? true,
                onApprovalEvents: onApprovalEvents ?? true,
                timezone: timezone || 'UTC',
            },
        });

        const response = successResponse(settings);
        return withCacheControl(response, 'private, no-store');
    } catch (error) {
        logError('Error updating notification settings:', error);
        return apiErrors.internalError('Failed to update settings');
    }
}

// POST /api/settings/notifications — Test a notification channel
export async function POST(request: NextRequest) {
    try {
        const limited = await rateLimit(request, 'mutate');
        if (limited) return limited;

        const session = await auth();
        if (!session?.user?.id) {
            return apiErrors.unauthorized();
        }

        const body = await request.json();
        const { channel, telegramChatId } = body;

        if (channel === 'telegram') {
            const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
            if (!telegramBotToken) {
                return apiErrors.internalError('Telegram bot not configured (TELEGRAM_BOT_TOKEN missing)');
            }
            if (!telegramChatId) {
                return apiErrors.badRequest('Chat ID is required');
            }
            if (!/^-?\d{1,20}$/.test(telegramChatId)) {
                return apiErrors.badRequest('Invalid Chat ID format');
            }

            const settingsUrl = `${process.env.NEXTAUTH_URL || ''}/settings`;
            const telegramPayload: Record<string, unknown> = {
                chat_id: telegramChatId,
                text: '✅ OpenFrame notifications connected successfully!\n\nYou will receive notifications here when activity happens on your projects.',
                link_preview_options: { is_disabled: true },
            };
            // Telegram inline keyboard buttons require HTTPS URLs
            if (settingsUrl.startsWith('https://')) {
                telegramPayload.reply_markup = {
                    inline_keyboard: [[{ text: 'Open Settings', url: settingsUrl }]],
                };
            }
            const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(telegramPayload),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                logError('Telegram test failed:', (data as { description?: string }).description);
                return apiErrors.badRequest('Telegram test failed: check that the Chat ID is correct and the bot has been started');
            }

            const response = successResponse({ message: 'Test message sent to Telegram' });
            return withCacheControl(response, 'private, no-store');
        }

        if (channel === 'email') {
            const user = await db.user.findUnique({
                where: { id: session.user.id },
                select: { email: true },
            });

            if (!user?.email) {
                return apiErrors.badRequest('No email address on your account');
            }

            const smtpHost = process.env.SMTP_HOST;
            const smtpPort = Number(process.env.SMTP_PORT || '587');
            const smtpUser = process.env.SMTP_USER;
            const smtpPass = process.env.SMTP_PASSWORD;

            if (!smtpHost || !smtpUser || !smtpPass) {
                return apiErrors.internalError('Email service not configured (SMTP settings missing)');
            }

            const transporter = nodemailer.createTransport({
                host: smtpHost,
                port: smtpPort,
                secure: smtpPort === 465,
                auth: { user: smtpUser, pass: smtpPass },
            });

            const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'OpenFrame <notifications@openframe.app>';

            try {
                await transporter.sendMail({
                    from: fromAddress,
                    to: user.email,
                    subject: '[OpenFrame] Test notification',
                    html: testEmailHtml(),
                });
            } catch (emailErr) {
                logError('SMTP test email failed:', emailErr);
                return apiErrors.internalError('Failed to send test email — check SMTP settings');
            }

            const response = successResponse({ message: `Test email sent to ${user.email}` });
            return withCacheControl(response, 'private, no-store');
        }

        return apiErrors.badRequest('Unknown channel');
    } catch (error) {
        logError('Error testing notification:', error);
        return apiErrors.internalError('Failed to test notification');
    }
}
