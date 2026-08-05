import { createHash, randomBytes } from 'crypto';
import { db } from '@/lib/db';
import nodemailer from 'nodemailer';
import {
  brandedEmailTemplate,
  emailButton,
  emailHeading,
  emailRow,
  EMAIL_COLORS,
} from '@/lib/email-brand';
import { logError } from '@/lib/logger';
import { eventKey, recordEvent } from '@/lib/analytics/record';
import { isProductAnalyticsEnabled, isStripeFeatureEnabled } from '@/lib/feature-flags';
import { startCardlessTrial } from '@/lib/billing';

// Reduce window to 2 hours — shorter exposure in access logs and backups.
const TOKEN_EXPIRY_HOURS = 2;

/** Hash a raw token before persisting so the DB stores only the digest. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Returns true when SMTP is fully configured and email sending should be enforced.
 * When SMTP is not configured, email verification is bypassed so self-hosted deployments
 * without a mail server continue to function.
 */
export function isEmailVerificationEnabled(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

let warnedAboutUnverifiedTrials = false;

/**
 * Says so, once, when an instance is handing out free trials to addresses nobody
 * has proved.
 *
 * Billing switched on means the trial is worth something, and no SMTP means there
 * is no verification step to hang it on, so every signup form submission mints
 * seven days of storage. That combination is a deployment mistake rather than a
 * choice, and it is invisible until the storage bill arrives.
 */
export function warnIfTrialsSkipVerification(): void {
  if (warnedAboutUnverifiedTrials) return;
  if (isEmailVerificationEnabled() || !isStripeFeatureEnabled()) return;

  warnedAboutUnverifiedTrials = true;
  logError(
    'Free trials are being granted without email verification because SMTP is not configured while billing is enabled. Configure SMTP_HOST, SMTP_USER and SMTP_PASSWORD.',
    new Error('Unverified trial signups')
  );
}

/**
 * Generate a secure random verification token, persist only its SHA-256 digest,
 * and return the raw token (sent to the user via email).
 * Any existing tokens for this email are deleted first (at most one live token).
 */
export async function createVerificationToken(email: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expires = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  // Delete existing tokens for this identifier before creating a new one
  await db.verificationToken.deleteMany({ where: { identifier: email } });

  await db.verificationToken.create({
    data: { identifier: email, token: tokenHash, expires },
  });

  // Return the raw (unhashed) token — only ever sent to the user, never stored.
  return token;
}

/**
 * Consume a verification token: hash the raw token, look it up, mark the user
 * email as verified, and delete the DB record atomically.
 * Returns the user's email on success, or null on any failure (invalid, expired,
 * already verified, or deleted account).
 */
export async function consumeVerificationToken(token: string): Promise<string | null> {
  const tokenHash = hashToken(token);
  const record = await db.verificationToken.findUnique({ where: { token: tokenHash } });

  if (!record) return null;
  if (record.expires < new Date()) {
    await db.verificationToken.delete({ where: { token: tokenHash } }).catch(() => null);
    return null;
  }

  // Atomically mark email as verified and delete the token
  const [user] = await db.$transaction([
    db.user.updateMany({
      where: { email: record.identifier, emailVerified: null },
      data: { emailVerified: new Date() },
    }),
    db.verificationToken.delete({ where: { token: tokenHash } }),
  ]);

  // count === 0 means the user was already verified or has been deleted.
  // Return null so a replayed/stale token never produces a misleading success redirect.
  if (user.count === 0) return null;

  // This is where the free trial begins: a proven address, before any card and
  // before Stripe is involved at all. count > 0 above means this call is the one
  // that flipped the account, so a replayed link cannot reach here, and
  // `startCardlessTrial` refuses a second trial regardless.
  const verified = await db.user.findUnique({
    where: { email: record.identifier },
    select: { id: true },
  });

  if (verified) {
    if (isProductAnalyticsEnabled()) {
      await recordEvent({
        name: 'EMAIL_VERIFIED',
        dedupeKey: eventKey('EMAIL_VERIFIED', verified.id),
        userId: verified.id,
      });
    }

    await startCardlessTrial(verified.id);
  }

  return record.identifier;
}

// ---------------------------------------------------------------------------
// Email sending
// ---------------------------------------------------------------------------

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

export async function sendVerificationEmail(
  email: string,
  token: string,
  options?: { next?: string }
): Promise<void> {
  const transporter = createTransport();
  if (!transporter) return;

  const baseUrl = process.env.NEXTAUTH_URL;
  if (!baseUrl) {
    // A missing NEXTAUTH_URL means the verification link will be malformed and the
    // user will be permanently locked out with no visible failure. Treat as fatal.
    logError(
      'NEXTAUTH_URL is not set — cannot build a valid verification link.',
      new Error('Set NEXTAUTH_URL to your deployment origin (e.g. https://app.example.com).')
    );
    return;
  }

  // `next` survives the round-trip so an invited user lands back on the invitation
  // (and from there on the shared project) instead of a generic login page.
  const nextParam = options?.next ? `&next=${encodeURIComponent(options.next)}` : '';
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}${nextParam}`;
  const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'OpenFrame <info@open-frame.net>';

  const html = brandedEmailTemplate(
    `
        <tr>${emailHeading('✉', 'Verify your email address')}</tr>
        <tr><td style="padding:20px;">
          <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
            ${emailRow('Account', email, true)}
            ${emailRow('Expires in', `${TOKEN_EXPIRY_HOURS} hours`)}
          </table>
          <p style="margin:0 0 20px;font-size:14px;color:${EMAIL_COLORS.textSecondary};line-height:1.6;">
            Click the button below to verify your email address and activate your OpenFrame account.
            If you did not create an account, you can safely ignore this email.
          </p>
          ${emailButton('Verify Email Address  →', verifyUrl)}
        </td></tr>
        `,
    {
      footerText: `This link expires in ${TOKEN_EXPIRY_HOURS} hours.`,
    }
  );

  try {
    await transporter.sendMail({
      from,
      to: email,
      subject: 'Verify your OpenFrame email address',
      html,
    });
  } catch (err) {
    logError('Failed to send verification email:', err);
  }
}
