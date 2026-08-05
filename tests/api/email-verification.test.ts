// lib/email-verification.ts and the two routes that drive it.
//
// The property the whole module rests on is that the database never holds a
// usable verification link: it stores a SHA-256 digest, and the raw token
// exists only in the mail. Everything below is written so that storing the raw
// token, or dropping the expiry check, or letting a spent token be replayed,
// fails a test rather than a security review.

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { db } from '@/lib/db';
import {
  consumeVerificationToken,
  createVerificationToken,
  isEmailVerificationEnabled,
  sendVerificationEmail,
} from '@/lib/email-verification';
import { GET as verifyEmail } from '@/app/api/auth/verify-email/route';
import { POST as resendVerification } from '@/app/api/auth/verify-email/resend/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { mailTo, sentMail } from '../helpers/mail';
import { createUser } from '../factories';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const RESEND_MESSAGE =
  'If that email has an unverified account, a new verification link has been sent.';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Backdates the stored token so the expiry branch is reachable without waiting. */
async function expireToken(tokenHash: string): Promise<void> {
  await db.verificationToken.update({
    where: { token: tokenHash },
    data: { expires: new Date(Date.now() - MINUTE_MS) },
  });
}

describe('createVerificationToken', () => {
  it('hands back a raw token and stores only its digest', async () => {
    const token = await createVerificationToken('ada@example.com');

    const record = await db.verificationToken.findFirstOrThrow();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(record.identifier).toBe('ada@example.com');
    // The load-bearing assertion: a dump of verification_tokens must not be a
    // list of working verification links.
    expect(record.token).not.toBe(token);
    expect(record.token).toBe(sha256(token));
  });

  it('expires the token two hours out', async () => {
    await createVerificationToken('ada@example.com');

    const record = await db.verificationToken.findFirstOrThrow();
    const ttl = record.expires.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(TWO_HOURS_MS - MINUTE_MS);
    expect(ttl).toBeLessThanOrEqual(TWO_HOURS_MS);
  });

  it('replaces the previous token for the address, so the older link stops working', async () => {
    const user = await createUser({ email: 'ada@example.com', emailVerified: null });
    const first = await createVerificationToken('ada@example.com');
    const second = await createVerificationToken('ada@example.com');

    expect(second).not.toBe(first);
    expect(await db.verificationToken.count()).toBe(1);
    expect(await consumeVerificationToken(first)).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBeNull();
    expect(await consumeVerificationToken(second)).toBe('ada@example.com');
  });

  it('leaves tokens for other addresses alone', async () => {
    const ada = await createVerificationToken('ada@example.com');
    await createVerificationToken('grace@example.com');

    expect(await db.verificationToken.count()).toBe(2);
    expect(await db.verificationToken.findUnique({ where: { token: sha256(ada) } })).not.toBeNull();
  });
});

describe('consumeVerificationToken', () => {
  it('verifies the account and clears the token', async () => {
    const user = await createUser({ email: 'ada@example.com', emailVerified: null });
    const token = await createVerificationToken('ada@example.com');

    expect(await consumeVerificationToken(token)).toBe('ada@example.com');

    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified
    ).toBeInstanceOf(Date);
    expect(await db.verificationToken.count()).toBe(0);
  });

  // Verification is where the free trial begins, which is what makes a proven
  // address the price of admission rather than a formality.
  it('starts the seven day trial on the account it verifies', async () => {
    const user = await createUser({
      email: 'ada@example.com',
      emailVerified: null,
      trialEndsAt: null,
      billingTrialConsumedAt: null,
    });
    const token = await createVerificationToken('ada@example.com');

    await consumeVerificationToken(token);

    const verified = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(verified.billingTrialConsumedAt).toBeInstanceOf(Date);
    const days =
      (verified.trialEndsAt!.getTime() - verified.billingTrialConsumedAt!.getTime()) /
      (24 * 60 * 60 * 1000);
    expect(days).toBe(7);
  });

  it('does not hand a second trial to an account that already had one', async () => {
    const consumedAt = new Date('2026-01-01T00:00:00.000Z');
    const trialEndsAt = new Date('2026-01-08T00:00:00.000Z');
    const user = await createUser({
      email: 'ada@example.com',
      emailVerified: null,
      trialEndsAt,
      billingTrialConsumedAt: consumedAt,
    });
    const token = await createVerificationToken('ada@example.com');

    await consumeVerificationToken(token);

    const verified = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(verified.trialEndsAt).toEqual(trialEndsAt);
    expect(verified.billingTrialConsumedAt).toEqual(consumedAt);
  });

  it('refuses a replayed token and keeps the original verification timestamp', async () => {
    const user = await createUser({ email: 'ada@example.com', emailVerified: null });
    const token = await createVerificationToken('ada@example.com');
    await consumeVerificationToken(token);
    const verifiedAt = (await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified;

    expect(await consumeVerificationToken(token)).toBeNull();

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toEqual(
      verifiedAt
    );
  });

  it('refuses an expired token, verifies nobody, and deletes the row', async () => {
    const user = await createUser({ email: 'ada@example.com', emailVerified: null });
    const token = await createVerificationToken('ada@example.com');
    await expireToken(sha256(token));

    expect(await consumeVerificationToken(token)).toBeNull();

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBeNull();
    expect(await db.verificationToken.count()).toBe(0);
  });

  // Whoever reads the database sees the digest. Presenting it back must not
  // verify anything, and must not burn the live token either.
  it('refuses the stored digest offered as if it were the token', async () => {
    await createUser({ email: 'ada@example.com', emailVerified: null });
    const token = await createVerificationToken('ada@example.com');
    const stored = (await db.verificationToken.findFirstOrThrow()).token;

    expect(await consumeVerificationToken(stored)).toBeNull();

    expect(await consumeVerificationToken(token)).toBe('ada@example.com');
  });

  it('refuses a token nobody was ever issued', async () => {
    expect(await consumeVerificationToken('f'.repeat(64))).toBeNull();
  });

  it('refuses a token for an account that is already verified, and clears it', async () => {
    const verifiedAt = new Date(Date.now() - 60 * MINUTE_MS);
    const user = await createUser({ email: 'ada@example.com', emailVerified: verifiedAt });
    const token = await createVerificationToken('ada@example.com');

    expect(await consumeVerificationToken(token)).toBeNull();

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toEqual(
      verifiedAt
    );
    expect(await db.verificationToken.count()).toBe(0);
  });

  it('refuses a token whose account no longer exists', async () => {
    const token = await createVerificationToken('deleted@example.com');

    expect(await consumeVerificationToken(token)).toBeNull();
  });
});

describe('isEmailVerificationEnabled', () => {
  it('is on with the SMTP trio configured, as .env.test has it', () => {
    expect(isEmailVerificationEnabled()).toBe(true);
  });

  // A self-hosted deployment without a mail server has to keep working, so any
  // one of the three going missing turns verification off entirely.
  it.each(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'])('is off without %s', (variable) => {
    vi.stubEnv(variable, '');

    expect(isEmailVerificationEnabled()).toBe(false);
  });
});

describe('sendVerificationEmail', () => {
  it('mails a link carrying the raw token', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.test');
    const token = 'a'.repeat(64);

    await sendVerificationEmail('ada@example.com', token);

    const mails = mailTo('ada@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Verify your OpenFrame email address');
    expect(mails[0].html).toContain(
      `https://app.example.test/api/auth/verify-email?token=${token}`
    );
  });

  it('escapes a token that carries query syntax', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.test');

    await sendVerificationEmail('ada@example.com', 'a b&c');

    expect(mailTo('ada@example.com')[0].html).toContain(
      'https://app.example.test/api/auth/verify-email?token=a%20b%26c'
    );
  });

  // Without an origin the link would be relative and the account unreachable.
  // Sending a broken link is worse than sending nothing.
  it('sends nothing when NEXTAUTH_URL is missing', async () => {
    vi.stubEnv('NEXTAUTH_URL', '');

    await sendVerificationEmail('ada@example.com', 'a'.repeat(64));

    expect(sentMail()).toEqual([]);
  });

  it('sends nothing when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASSWORD', '');

    await sendVerificationEmail('ada@example.com', 'a'.repeat(64));

    expect(sentMail()).toEqual([]);
  });

  // A mail server that is refusing connections must not turn a successful
  // registration into a 500, so the rejection is swallowed here.
  it('swallows a rejecting transport', async () => {
    vi.mocked(nodemailer.createTransport).mockReturnValueOnce({
      sendMail: vi.fn(async () => {
        throw new Error('smtp is down');
      }),
    } as unknown as ReturnType<typeof nodemailer.createTransport>);

    await expect(sendVerificationEmail('ada@example.com', 'a'.repeat(64))).resolves.toBeUndefined();
    expect(sentMail()).toEqual([]);
  });
});

// The route is anonymous by design: the token in the query string is the only
// credential, so there is no forbidden case to test, only good and bad tokens.
describe('GET /api/auth/verify-email', () => {
  function verifyRequest(token: string) {
    return apiRequest('/api/auth/verify-email', { searchParams: { token } });
  }

  it('verifies the account and sends the visitor to the login page', async () => {
    const user = await createUser({ email: 'ada@example.com', emailVerified: null });
    const token = await createVerificationToken('ada@example.com');

    const response = await callRoute(verifyEmail, verifyRequest(token));

    expect(response.headers.get('location')).toBe('http://localhost:3000/login?verified=true');
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified
    ).toBeInstanceOf(Date);
    expect(await db.verificationToken.count()).toBe(0);
  });

  // A raw token is 64 hex characters. Anything else is rejected before it can
  // reach the database, which is what keeps enumeration cheap for us and not
  // for the attacker.
  it.each([['short'], ['g'.repeat(64)], ['A'.repeat(64)], ['']])(
    'rejects the malformed token %j without touching the stored one',
    async (token) => {
      await createUser({ email: 'ada@example.com', emailVerified: null });
      await createVerificationToken('ada@example.com');

      const response = await callRoute(verifyEmail, verifyRequest(token));

      expect(response.headers.get('location')).toBe(
        'http://localhost:3000/login?error=InvalidVerificationToken'
      );
      expect(await db.verificationToken.count()).toBe(1);
    }
  );

  it('rejects an expired token and leaves the account unverified', async () => {
    const user = await createUser({ email: 'ada@example.com', emailVerified: null });
    const token = await createVerificationToken('ada@example.com');
    await expireToken(sha256(token));

    const response = await callRoute(verifyEmail, verifyRequest(token));

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=InvalidVerificationToken'
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBeNull();
  });

  it('rejects a replayed token', async () => {
    await createUser({ email: 'ada@example.com', emailVerified: null });
    const token = await createVerificationToken('ada@example.com');
    await callRoute(verifyEmail, verifyRequest(token));

    const response = await callRoute(verifyEmail, verifyRequest(token));

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=InvalidVerificationToken'
    );
  });
});

describe('POST /api/auth/verify-email/resend', () => {
  function resendRequest(body: unknown) {
    return apiRequest('/api/auth/verify-email/resend', { body });
  }

  it('issues a fresh token to an unverified account and kills the previous link', async () => {
    await createUser({ email: 'ada@example.com', emailVerified: null });
    const firstToken = await createVerificationToken('ada@example.com');

    const response = await callRoute(
      resendVerification,
      resendRequest({ email: 'ada@example.com' })
    );

    expect(response.status).toBe(200);
    expect(await db.verificationToken.count()).toBe(1);
    const mails = mailTo('ada@example.com');
    expect(mails).toHaveLength(1);
    const mailedToken = mails[0].html?.match(/token=([0-9a-f]{64})/)?.[1];
    expect(mailedToken).toBeTruthy();
    expect(mailedToken).not.toBe(firstToken);
    // The mailed token is the raw one and the row still holds only a digest.
    expect((await db.verificationToken.findFirstOrThrow()).token).toBe(sha256(mailedToken!));
    expect(await consumeVerificationToken(firstToken)).toBeNull();
  });

  it('normalizes the address before looking the account up', async () => {
    await createUser({ email: 'ada@example.com', emailVerified: null });

    const response = await callRoute(
      resendVerification,
      resendRequest({ email: '  Ada@Example.COM  ' })
    );

    expect(response.status).toBe(200);
    expect(mailTo('ada@example.com')).toHaveLength(1);
  });

  // The endpoint is unauthenticated, so a different answer for a known address
  // would turn it into an account-existence oracle.
  it('answers an unknown address exactly as it answers a real one, and mails nothing', async () => {
    await createUser({ email: 'ada@example.com', emailVerified: null });

    const known = await callRoute(resendVerification, resendRequest({ email: 'ada@example.com' }));
    const unknown = await callRoute(
      resendVerification,
      resendRequest({ email: 'nobody@example.com' })
    );

    const knownBody = await readData<{ message: string }>(known);
    const unknownBody = await readData<{ message: string }>(unknown);
    expect(unknown.status).toBe(known.status);
    expect(unknownBody).toEqual(knownBody);
    expect(unknownBody.message).toBe(RESEND_MESSAGE);
    expect(mailTo('nobody@example.com')).toEqual([]);
  });

  it('mails nothing to an account that is already verified', async () => {
    await createUser({ email: 'ada@example.com', emailVerified: new Date() });

    const response = await callRoute(
      resendVerification,
      resendRequest({ email: 'ada@example.com' })
    );

    expect(response.status).toBe(200);
    expect(sentMail()).toEqual([]);
    expect(await db.verificationToken.count()).toBe(0);
  });

  it.each([[{}], [{ email: 42 }], [{ email: 'no-at-sign' }], [{ email: 'sp ace@example.com' }]])(
    'rejects %j with 400',
    async (body) => {
      const response = await callRoute(resendVerification, resendRequest(body));

      expect(response.status).toBe(400);
      expect(await db.verificationToken.count()).toBe(0);
      expect(sentMail()).toEqual([]);
    }
  );

  it('refuses to run at all when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASSWORD', '');
    await createUser({ email: 'ada@example.com', emailVerified: null });

    const response = await callRoute(
      resendVerification,
      resendRequest({ email: 'ada@example.com' })
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('Email verification is not enabled');
    expect(await db.verificationToken.count()).toBe(0);
  });
});
