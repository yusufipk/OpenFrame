import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { POST as register } from '@/app/api/auth/register/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { mailTo, sentMail } from '../helpers/mail';
import { signedOut } from '../helpers/session';
import { createInvitation, createUser, seedProject } from '../factories';

const INVITE_CODE = 'test-invite';
const PASSWORD = 'correct horse battery';

function registerRequest(body: unknown) {
  return apiRequest('/api/auth/register', { body });
}

async function post(body: Record<string, unknown>): Promise<Response> {
  signedOut();
  return callRoute(register, registerRequest({ inviteCode: INVITE_CODE, ...body }));
}

describe('POST /api/auth/register', () => {
  it.each([
    [{ email: 'a@example.com', password: PASSWORD }, 'a missing name'],
    [{ name: 'A', email: 'a@example.com', password: PASSWORD }, 'a one-character name'],
    [{ name: 'x'.repeat(101), email: 'a@example.com', password: PASSWORD }, 'a 101-character name'],
    [{ name: 42, email: 'a@example.com', password: PASSWORD }, 'a non-string name'],
    [{ name: 'Valid Name', password: PASSWORD }, 'a missing email'],
    [{ name: 'Valid Name', email: 'a@example.com', password: 'short' }, 'a 5-character password'],
    [
      { name: 'Valid Name', email: 'a@example.com', password: 'x'.repeat(129) },
      'a 129-character password',
    ],
    [{ name: 'Valid Name', email: 'a@example.com' }, 'a missing password'],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    const response = await post(body);

    expect(response.status, label).toBe(400);
    expect(await db.user.count()).toBe(0);
  });

  it.each([['no-at-sign'], ['nope@nodot'], ['double@@example.com'], ['sp ace@example.com']])(
    'returns 422 for the malformed address %s',
    async (email) => {
      const response = await post({ name: 'Valid Name', email, password: PASSWORD });

      expect(response.status).toBe(422);
      expect(await db.user.count()).toBe(0);
    }
  );

  it('returns 403 when the invite code is missing', async () => {
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({ name: 'Valid Name', email: 'a@example.com', password: PASSWORD })
    );

    expect(response.status).toBe(403);
    expect(await db.user.count()).toBe(0);
  });

  it.each([['wrong-code'], [''], ['test-invit'], ['test-invitee']])(
    'returns 403 for the invite code %s',
    async (inviteCode) => {
      signedOut();

      const response = await callRoute(
        register,
        registerRequest({
          name: 'Valid Name',
          email: 'a@example.com',
          password: PASSWORD,
          inviteCode,
        })
      );

      expect(response.status).toBe(403);
      expect(await db.user.count()).toBe(0);
    }
  );

  it('does not require an invite code when the flag is off', async () => {
    vi.stubEnv('OPENFRAME_REQUIRE_INVITE_CODE', 'false');
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({ name: 'Valid Name', email: 'open@example.com', password: PASSWORD })
    );

    expect(response.status).toBe(201);
    expect(await db.user.count()).toBe(1);
  });

  it('creates the account with a lowercased email and a bcrypt hash', async () => {
    const response = await post({
      name: '  Ada Lovelace  ',
      email: '  Ada.Lovelace@Example.COM  ',
      password: PASSWORD,
    });
    const payload = await readData<{
      message: string;
      user: { id: string; email: string; name: string };
      emailVerificationRequired: boolean;
    }>(response);

    expect(response.status).toBe(201);
    expect(payload.emailVerificationRequired).toBe(true);
    expect(payload.user.email).toBe('ada.lovelace@example.com');
    expect(payload.user.name).toBe('Ada Lovelace');
    // The response envelope must not carry the hash, let alone the password.
    expect(JSON.stringify(payload)).not.toContain(PASSWORD);
    expect(payload.user).not.toHaveProperty('password');

    const stored = await db.user.findUniqueOrThrow({
      where: { email: 'ada.lovelace@example.com' },
    });
    expect(stored.name).toBe('Ada Lovelace');
    expect(stored.password).not.toBe(PASSWORD);
    expect(stored.password).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare(PASSWORD, stored.password!)).toBe(true);
    // SMTP is configured in .env.test, so verification is enforced.
    expect(stored.emailVerified).toBeNull();
  });

  it('stores only the digest of the verification token and mails the raw one', async () => {
    const response = await post({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: PASSWORD,
    });

    expect(response.status).toBe(201);

    const record = await db.verificationToken.findFirstOrThrow();
    expect(record.identifier).toBe('ada@example.com');
    expect(record.token).toMatch(/^[0-9a-f]{64}$/);
    expect(record.expires.getTime()).toBeGreaterThan(Date.now());

    const mails = mailTo('ada@example.com');
    expect(mails).toHaveLength(1);

    const rawToken = mails[0].html?.match(/token=([0-9a-f]{64})/)?.[1];
    expect(rawToken).toBeTruthy();
    // The stored value must be the digest, not the token itself, or a database
    // leak hands out live verification links.
    expect(record.token).not.toBe(rawToken);
    expect(createHash('sha256').update(rawToken!).digest('hex')).toBe(record.token);
  });

  it('returns 409 for a duplicate email regardless of case, and does not touch the existing row', async () => {
    const existing = await createUser({ email: 'taken@example.com', password: 'a-different-one' });

    const response = await post({
      name: 'Impostor',
      email: 'TAKEN@example.com',
      password: PASSWORD,
    });

    expect(response.status).toBe(409);
    expect(await db.user.count()).toBe(1);
    const stored = await db.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stored.password).toBe(existing.password);
    expect(stored.name).toBe(existing.name);
    expect(sentMail()).toEqual([]);
  });

  it('accepts a matching invitation token instead of the invite code, and applies the membership', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      email: 'invited@example.com',
      role: 'ADMIN',
    });
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({
        name: 'Invited Person',
        email: 'invited@example.com',
        password: PASSWORD,
        invitationToken: invitation.token,
      })
    );

    expect(response.status).toBe(201);
    const created = await db.user.findUniqueOrThrow({ where: { email: 'invited@example.com' } });
    const membership = await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: scenario.project.id, userId: created.id } },
    });
    expect(membership.role).toBe('ADMIN');
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'ACCEPTED'
    );
  });

  it('applies a workspace invitation membership', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
      email: 'wsinvite@example.com',
      role: 'ADMIN',
    });
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({
        name: 'Workspace Invitee',
        email: 'wsinvite@example.com',
        password: PASSWORD,
        invitationToken: invitation.token,
      })
    );

    expect(response.status).toBe(201);
    const created = await db.user.findUniqueOrThrow({ where: { email: 'wsinvite@example.com' } });
    expect(
      (
        await db.workspaceMember.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: scenario.workspace.id, userId: created.id } },
        })
      ).role
    ).toBe('ADMIN');
  });

  // The invitation is bound to an address. Registering with a different one must
  // not inherit the membership.
  it('returns 403 when the invitation token was issued to a different email', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      email: 'intended@example.com',
    });
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({
        name: 'Wrong Person',
        email: 'someone.else@example.com',
        password: PASSWORD,
        invitationToken: invitation.token,
      })
    );

    expect(response.status).toBe(403);
    expect(await db.user.count()).toBe(1);
    expect(await db.projectMember.count()).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'PENDING'
    );
  });

  it('returns 403 for an expired invitation token', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      email: 'late@example.com',
      expiresAt: new Date(Date.now() - 60_000),
    });
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({
        name: 'Late Person',
        email: 'late@example.com',
        password: PASSWORD,
        invitationToken: invitation.token,
      })
    );

    expect(response.status).toBe(403);
    expect(await db.user.count()).toBe(1);
    expect(await db.projectMember.count()).toBe(0);
  });

  it('returns 403 for an unknown invitation token', async () => {
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({
        name: 'Nobody',
        email: 'nobody@example.com',
        password: PASSWORD,
        invitationToken: 'not-a-real-token',
      })
    );

    expect(response.status).toBe(403);
    expect(await db.user.count()).toBe(0);
  });

  it('returns 403 for an already accepted invitation token', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      email: 'used@example.com',
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    });
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({
        name: 'Reuser',
        email: 'used@example.com',
        password: PASSWORD,
        invitationToken: invitation.token,
      })
    );

    expect(response.status).toBe(403);
    expect(await db.user.count()).toBe(1);
  });

  it('auto-verifies the email when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASSWORD', '');

    const response = await post({
      name: 'Self Hosted',
      email: 'selfhost@example.com',
      password: PASSWORD,
    });
    const payload = await readData<{ emailVerificationRequired: boolean }>(response);

    expect(response.status).toBe(201);
    expect(payload.emailVerificationRequired).toBe(false);
    const stored = await db.user.findUniqueOrThrow({ where: { email: 'selfhost@example.com' } });
    expect(stored.emailVerified).toBeInstanceOf(Date);
    expect(await db.verificationToken.count()).toBe(0);
    expect(sentMail()).toEqual([]);
  });

  it('refuses a disposable mailbox with 400 and stores nothing', async () => {
    const response = await post({
      name: 'Throwaway Person',
      email: 'burner@mailinator.com',
      password: PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(await db.user.count()).toBe(0);
  });

  // The block exists to stop trial farming, which is a self-signup problem. An
  // invited collaborator was vouched for by a paying customer, so refusing their
  // address would break that customer's review instead.
  it('accepts a disposable mailbox when an invitation vouches for it', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      email: 'guest@mailinator.com',
      role: 'COMMENTATOR',
    });
    signedOut();

    const response = await callRoute(
      register,
      registerRequest({
        name: 'Invited Guest',
        email: 'guest@mailinator.com',
        password: PASSWORD,
        invitationToken: invitation.token,
      })
    );

    expect(response.status).toBe(201);
    expect(await db.user.count()).toBe(2);
  });

  // SMTP is configured in .env.test, so registration alone proves nothing about
  // the address and grants no trial. Verification is what starts the clock.
  it('leaves the trial unstarted until the address has been verified', async () => {
    const response = await post({
      name: 'Unverified Person',
      email: 'unverified@example.com',
      password: PASSWORD,
    });

    expect(response.status).toBe(201);
    const created = await db.user.findUniqueOrThrow({
      where: { email: 'unverified@example.com' },
    });
    expect(created.trialEndsAt).toBeNull();
    expect(created.billingTrialConsumedAt).toBeNull();
  });

  it('reports the rate limit budget on a successful registration', async () => {
    const response = await post({
      name: 'Rate Limited',
      email: 'rate@example.com',
      password: PASSWORD,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('5');
    // The exact value, not just "present": .env.test sets DISABLE_RATE_LIMIT, so
    // checkRateLimit() short-circuits to a full budget. toBeTruthy() held for any
    // non-empty string, including a wrong one, which left the arithmetic behind
    // this header untested from here.
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('5');
  });
});
