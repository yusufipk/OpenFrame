import { db } from '@/lib/db';
import nodemailer from 'nodemailer';
import {
  EMAIL_COLORS,
  brandedEmailTemplate,
  emailButton,
  emailHeading,
  emailHighlight,
  emailRow,
  escapeHtml,
} from '@/lib/email-brand';
import { logError } from '@/lib/logger';

// ============================================
// NOTIFICATION CHANNELS
// ============================================

/**
 * Send a message via Telegram Bot API with optional inline keyboard button.
 */
async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  buttonLabel?: string,
  buttonUrl?: string
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    };

    // Add inline keyboard button for clickable URL (Telegram requires HTTPS)
    if (buttonLabel && buttonUrl && buttonUrl.startsWith('https://')) {
      payload.reply_markup = {
        inline_keyboard: [[{ text: buttonLabel, url: buttonUrl }]],
      };
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram API error:', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    logError('Telegram send failed:', err);
    return false;
  }
}

/**
 * Create a nodemailer SMTP transporter from environment variables.
 * Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
 */
function createSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

/**
 * Send an email notification via SMTP.
 * Requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD environment variables.
 * Falls back to logging if not configured.
 */
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const transporter = createSmtpTransport();
  const fromAddress =
    process.env.SMTP_FROM || process.env.EMAIL_FROM || 'OpenFrame <notifications@openframe.app>';

  if (!transporter) {
    console.warn('SMTP not configured — skipping email notification');
    return false;
  }

  try {
    await transporter.sendMail({ from: fromAddress, to, subject, html });
    return true;
  } catch (err) {
    logError('Email send failed:', err);
    return false;
  }
}

// ============================================
// NOTIFICATION EVENT TYPES
// ============================================

export type NotificationEvent =
  | { type: 'new_video'; projectName: string; videoTitle: string; addedBy: string; url: string }
  | {
      type: 'new_version';
      projectName: string;
      videoTitle: string;
      versionLabel: string;
      addedBy: string;
      url: string;
    }
  | {
      type: 'new_comment';
      projectName: string;
      videoTitle: string;
      commentAuthor: string;
      commentText: string;
      timestamp: string;
      url: string;
    }
  | {
      type: 'new_reply';
      projectName: string;
      videoTitle: string;
      replyAuthor: string;
      replyText: string;
      parentAuthor: string;
      timestamp: string;
      url: string;
    }
  | {
      type: 'approval_requested';
      projectName: string;
      videoTitle: string;
      versionLabel: string;
      requestedBy: string;
      message?: string;
      url: string;
    }
  | {
      type: 'approval_action';
      projectName: string;
      videoTitle: string;
      versionLabel: string;
      actorName: string;
      action: 'approved' | 'rejected';
      note?: string;
      url: string;
    }
  | {
      type: 'approval_completed';
      projectName: string;
      videoTitle: string;
      versionLabel: string;
      approvedByCount: number;
      url: string;
    }
  | {
      type: 'approval_rejected';
      projectName: string;
      videoTitle: string;
      versionLabel: string;
      rejectedBy: string;
      note?: string;
      url: string;
    };

/** Structured Telegram message with text body + button label/URL */
interface TelegramMessage {
  text: string;
  buttonLabel: string;
  buttonUrl: string;
}

/**
 * Format a notification event into a Telegram message with an inline keyboard button.
 * The URL is no longer in the text body — it's attached as a clickable button instead.
 */
function formatTelegramMessage(event: NotificationEvent, timezone: string): TelegramMessage {
  const now = formatNow(timezone);
  switch (event.type) {
    case 'new_video':
      return {
        text:
          `🎬 New Video Added\n\n` +
          `▸ Project: ${event.projectName}\n` +
          `▸ Video: ${event.videoTitle}\n` +
          `▸ Added by: ${event.addedBy}\n` +
          `▸ ${now}`,
        buttonLabel: 'View Video',
        buttonUrl: event.url,
      };
    case 'new_version':
      return {
        text:
          `🎬 New Version Added\n\n` +
          `▸ Project: ${event.projectName}\n` +
          `▸ Video: ${event.videoTitle}\n` +
          `▸ Version: ${event.versionLabel}\n` +
          `▸ Added by: ${event.addedBy}\n` +
          `▸ ${now}`,
        buttonLabel: 'View Version',
        buttonUrl: event.url,
      };
    case 'new_comment':
      return {
        text:
          `💬 New Comment\n\n` +
          `▸ Project: ${event.projectName}\n` +
          `▸ Video: ${event.videoTitle}\n` +
          `▸ By: ${event.commentAuthor} at ${event.timestamp}\n` +
          `▸ ${now}\n\n` +
          `"${truncate(event.commentText, 200)}"`,
        buttonLabel: 'View Comment',
        buttonUrl: event.url,
      };
    case 'new_reply':
      return {
        text:
          `↩️ New Reply\n\n` +
          `▸ Project: ${event.projectName}\n` +
          `▸ Video: ${event.videoTitle}\n` +
          `▸ ${event.replyAuthor} replied to ${event.parentAuthor}\n` +
          `▸ ${now}\n\n` +
          `"${truncate(event.replyText, 200)}"`,
        buttonLabel: 'View Reply',
        buttonUrl: event.url,
      };
    case 'approval_requested':
      return {
        text:
          `✅ Approval Requested\n\n` +
          `▸ Project: ${event.projectName}\n` +
          `▸ Video: ${event.videoTitle}\n` +
          `▸ Version: ${event.versionLabel}\n` +
          `▸ Requested by: ${event.requestedBy}\n` +
          `▸ ${now}` +
          (event.message ? `\n\n"${truncate(event.message, 200)}"` : ''),
        buttonLabel: 'Review Request',
        buttonUrl: event.url,
      };
    case 'approval_action':
      return {
        text:
          `✅ Approval Update\n\n` +
          `▸ Project: ${event.projectName}\n` +
          `▸ Video: ${event.videoTitle}\n` +
          `▸ Version: ${event.versionLabel}\n` +
          `▸ ${event.actorName} ${event.action}\n` +
          `▸ ${now}` +
          (event.note ? `\n\n"${truncate(event.note, 200)}"` : ''),
        buttonLabel: 'Open Request',
        buttonUrl: event.url,
      };
    case 'approval_completed':
      return {
        text:
          `✅ Approval Completed\n\n` +
          `▸ Project: ${event.projectName}\n` +
          `▸ Video: ${event.videoTitle}\n` +
          `▸ Version: ${event.versionLabel}\n` +
          `▸ Approved by: ${event.approvedByCount}\n` +
          `▸ ${now}`,
        buttonLabel: 'Open Version',
        buttonUrl: event.url,
      };
    case 'approval_rejected':
      return {
        text:
          `⛔ Approval Rejected\n\n` +
          `▸ Project: ${event.projectName}\n` +
          `▸ Video: ${event.videoTitle}\n` +
          `▸ Version: ${event.versionLabel}\n` +
          `▸ Rejected by: ${event.rejectedBy}\n` +
          `▸ ${now}` +
          (event.note ? `\n\n"${truncate(event.note, 200)}"` : ''),
        buttonLabel: 'Open Request',
        buttonUrl: event.url,
      };
  }
}

// ============================================
// EMAIL TEMPLATE
// ============================================

function emailTemplate(body: string): string {
  const baseUrl = process.env.NEXTAUTH_URL || '';
  return brandedEmailTemplate(body, {
    footerText: 'You received this because email notifications are enabled.',
    footerLinkText: 'Unsubscribe · Manage notification settings',
    footerLinkUrl: `${baseUrl}/settings`,
  });
}

/**
 * Format a notification event into an email subject + full branded HTML email.
 */
function formatEmail(
  event: NotificationEvent,
  timezone: string
): { subject: string; html: string } {
  const now = formatNow(timezone);
  switch (event.type) {
    case 'new_video':
      return {
        subject: `[OpenFrame] New video in ${event.projectName}: ${event.videoTitle}`,
        html: emailTemplate(`
                    <tr>${emailHeading('&#9654;', 'New Video Added')}</tr>
                    <tr><td style="padding:20px;">
                      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
                        ${emailRow('Project', escapeHtml(event.projectName), true)}
                        ${emailRow('Video', escapeHtml(event.videoTitle), true)}
                        ${emailRow('Added by', escapeHtml(event.addedBy))}
                        ${emailRow('When', now)}
                      </table>
                      ${emailButton('View Video  &#8594;', event.url)}
                    </td></tr>
                `),
      };
    case 'new_version':
      return {
        subject: `[OpenFrame] New version of ${event.videoTitle} in ${event.projectName}`,
        html: emailTemplate(`
                    <tr>${emailHeading('&#9654;', 'New Version Added')}</tr>
                    <tr><td style="padding:20px;">
                      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
                        ${emailRow('Project', escapeHtml(event.projectName), true)}
                        ${emailRow('Video', escapeHtml(event.videoTitle), true)}
                        ${emailRow('Version', escapeHtml(event.versionLabel))}
                        ${emailRow('Added by', escapeHtml(event.addedBy))}
                        ${emailRow('When', now)}
                      </table>
                      ${emailButton('View Version  &#8594;', event.url)}
                    </td></tr>
                `),
      };
    case 'new_comment':
      return {
        subject: `[OpenFrame] New comment on ${event.videoTitle}`,
        html: emailTemplate(`
                    <tr>${emailHeading('&#9679;', 'New Comment')}</tr>
                    <tr><td style="padding:20px;">
                      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;">
                        ${emailRow('Project', escapeHtml(event.projectName), true)}
                        ${emailRow('Video', escapeHtml(event.videoTitle), true)}
                        ${emailRow('From', escapeHtml(event.commentAuthor))}
                        ${emailRow('At', event.timestamp)}
                        ${emailRow('When', now)}
                      </table>
                      <div style="border-left:2px solid #7aa7ff;padding:10px 14px;margin:0 0 20px;background-color:#2f2f2f;color:#c6c6cc;font-size:13px;line-height:1.6;">
                        ${escapeHtml(truncate(event.commentText, 300))}
                      </div>
                      ${emailButton('View Comment  &#8594;', event.url)}
                    </td></tr>
                `),
      };
    case 'new_reply':
      return {
        subject: `[OpenFrame] ${event.replyAuthor} replied on ${event.videoTitle}`,
        html: emailTemplate(`
                    <tr>${emailHeading('&#8617;', 'New Reply')}</tr>
                    <tr><td style="padding:20px;">
                      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;">
                        ${emailRow('Project', escapeHtml(event.projectName), true)}
                        ${emailRow('Video', escapeHtml(event.videoTitle), true)}
                        ${emailRow('From', `<span style="color:${EMAIL_COLORS.text};font-weight:500;">${escapeHtml(event.replyAuthor)}</span> <span style="color:${EMAIL_COLORS.textDim};">&#8594;</span> ${escapeHtml(event.parentAuthor)}`)}
                        ${emailRow('When', now)}
                      </table>
                      <div style="border-left:2px solid #7aa7ff;padding:10px 14px;margin:0 0 20px;background-color:#2f2f2f;color:#c6c6cc;font-size:13px;line-height:1.6;">
                        ${escapeHtml(truncate(event.replyText, 300))}
                      </div>
                      ${emailButton('View Reply  &#8594;', event.url)}
                    </td></tr>
                `),
      };
    case 'approval_requested':
      return {
        subject: `[OpenFrame] Approval requested for ${event.versionLabel} in ${event.projectName}`,
        html: emailTemplate(`
                    <tr>${emailHeading('&#10003;', 'Approval Requested')}</tr>
                    <tr><td style="padding:20px;">
                      ${emailHighlight(`A new approval request is waiting for your response.`)}
                      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;">
                        ${emailRow('Project', escapeHtml(event.projectName), true)}
                        ${emailRow('Video', escapeHtml(event.videoTitle), true)}
                        ${emailRow('Version', escapeHtml(event.versionLabel))}
                        ${emailRow('Requested by', escapeHtml(event.requestedBy))}
                        ${emailRow('When', now)}
                      </table>
                      ${event.message ? `<div style="border-left:2px solid #7aa7ff;padding:10px 14px;margin:0 0 20px;background-color:#2f2f2f;color:#c6c6cc;font-size:13px;line-height:1.6;">${escapeHtml(truncate(event.message, 300))}</div>` : ''}
                      ${emailButton('Review Request  &#8594;', event.url)}
                    </td></tr>
                `),
      };
    case 'approval_action':
      return {
        subject: `[OpenFrame] Approval ${event.action} by ${event.actorName}`,
        html: emailTemplate(`
                    <tr>${emailHeading('&#10003;', 'Approval Update')}</tr>
                    <tr><td style="padding:20px;">
                      ${emailHighlight(`${escapeHtml(event.actorName)} ${escapeHtml(event.action)} this request.`)}
                      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;">
                        ${emailRow('Project', escapeHtml(event.projectName), true)}
                        ${emailRow('Video', escapeHtml(event.videoTitle), true)}
                        ${emailRow('Version', escapeHtml(event.versionLabel))}
                        ${emailRow('Action', escapeHtml(`${event.actorName} ${event.action}`))}
                        ${emailRow('When', now)}
                      </table>
                      ${event.note ? `<div style="border-left:2px solid #7aa7ff;padding:10px 14px;margin:0 0 20px;background-color:#2f2f2f;color:#c6c6cc;font-size:13px;line-height:1.6;">${escapeHtml(truncate(event.note, 300))}</div>` : ''}
                      ${emailButton('Open Request  &#8594;', event.url)}
                    </td></tr>
                `),
      };
    case 'approval_completed':
      return {
        subject: `[OpenFrame] Approval completed for ${event.versionLabel}`,
        html: emailTemplate(`
                    <tr>${emailHeading('&#10003;', 'Approval Completed')}</tr>
                    <tr><td style="padding:20px;">
                      ${emailHighlight(`All approvers accepted this request.`)}
                      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
                        ${emailRow('Project', escapeHtml(event.projectName), true)}
                        ${emailRow('Video', escapeHtml(event.videoTitle), true)}
                        ${emailRow('Version', escapeHtml(event.versionLabel))}
                        ${emailRow('Approvals', String(event.approvedByCount))}
                        ${emailRow('When', now)}
                      </table>
                      ${emailButton('Open Version  &#8594;', event.url)}
                    </td></tr>
                `),
      };
    case 'approval_rejected':
      return {
        subject: `[OpenFrame] Approval rejected by ${event.rejectedBy}`,
        html: emailTemplate(`
                    <tr>${emailHeading('&#9940;', 'Approval Rejected')}</tr>
                    <tr><td style="padding:20px;">
                      ${emailHighlight(`${escapeHtml(event.rejectedBy)} rejected this request.`)}
                      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;">
                        ${emailRow('Project', escapeHtml(event.projectName), true)}
                        ${emailRow('Video', escapeHtml(event.videoTitle), true)}
                        ${emailRow('Version', escapeHtml(event.versionLabel))}
                        ${emailRow('Rejected by', escapeHtml(event.rejectedBy))}
                        ${emailRow('When', now)}
                      </table>
                      ${event.note ? `<div style="border-left:2px solid #7aa7ff;padding:10px 14px;margin:0 0 20px;background-color:#2f2f2f;color:#c6c6cc;font-size:13px;line-height:1.6;">${escapeHtml(truncate(event.note, 300))}</div>` : ''}
                      ${emailButton('Open Request  &#8594;', event.url)}
                    </td></tr>
                `),
      };
  }
}

/**
 * Generate branded HTML for test emails sent from settings page.
 */
export function testEmailHtml(): string {
  return emailTemplate(`
        <tr>${emailHeading('&#10003;', 'Test Notification')}</tr>
        <tr><td style="padding:20px;">
          <p style="margin:0 0 8px;font-size:14px;color:${EMAIL_COLORS.text};">Email notifications are working.</p>
          <p style="margin:0;font-size:13px;color:${EMAIL_COLORS.textSecondary};">You&rsquo;ll receive emails when there&rsquo;s activity on your projects.</p>
        </td></tr>
    `);
}

// ============================================
// MAIN DISPATCH
// ============================================

/**
 * Notify the project owner about an event.
 * Looks up the owner's notification settings and dispatches to enabled channels.
 * Best-effort — never throws, logs errors.
 */
function isApprovalEvent(event: NotificationEvent): boolean {
  return (
    event.type === 'approval_requested' ||
    event.type === 'approval_action' ||
    event.type === 'approval_completed' ||
    event.type === 'approval_rejected'
  );
}

function shouldSendEvent(
  settings: {
    onNewVideo: boolean;
    onNewVersion: boolean;
    onNewComment: boolean;
    onNewReply: boolean;
    onApprovalEvents: boolean;
  },
  event: NotificationEvent
): boolean {
  if (event.type === 'new_video') return settings.onNewVideo;
  if (event.type === 'new_version') return settings.onNewVersion;
  if (event.type === 'new_comment') return settings.onNewComment;
  if (event.type === 'new_reply') return settings.onNewReply;
  if (isApprovalEvent(event)) return settings.onApprovalEvents;
  return false;
}

export async function notifyUsers(userIds: string[], event: NotificationEvent): Promise<void> {
  try {
    const dedupedUserIds = Array.from(new Set(userIds.filter(Boolean)));
    if (dedupedUserIds.length === 0) return;

    const settingsList = await db.notificationSetting.findMany({
      where: { userId: { in: dedupedUserIds } },
      include: { user: { select: { email: true } } },
    });

    await Promise.allSettled(
      settingsList.map(async (settings) => {
        if (!shouldSendEvent(settings, event)) return;

        const promises: Promise<boolean>[] = [];
        const tz = settings.timezone || 'UTC';

        const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
        if (settings.telegramEnabled && telegramBotToken && settings.telegramChatId) {
          const msg = formatTelegramMessage(event, tz);
          promises.push(
            sendTelegram(
              telegramBotToken,
              settings.telegramChatId,
              msg.text,
              msg.buttonLabel,
              msg.buttonUrl
            )
          );
        }

        if (settings.emailEnabled && settings.user.email) {
          const { subject, html } = formatEmail(event, tz);
          promises.push(sendEmail(settings.user.email, subject, html));
        }

        await Promise.allSettled(promises);
      })
    );
  } catch (err) {
    logError('Notification dispatch failed:', err);
  }
}

export async function notifyProjectOwner(ownerId: string, event: NotificationEvent): Promise<void> {
  try {
    await notifyUsers([ownerId], event);
  } catch (err) {
    logError('Notification dispatch failed:', err);
  }
}

// ============================================
// HELPERS
// ============================================

/**
 * Format current date/time in the user's timezone.
 * Returns e.g. "Jan 15, 2025 at 3:45 PM"
 */
function formatNow(timezone: string): string {
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    // Invalid timezone — fall back to UTC
    return new Date().toLocaleString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
