// lib/invitations.ts, exercised directly rather than through the two member
// routes that call it. The routes decide who may invite; this module decides
// what an invitation is worth once it is accepted, which is the part that hands
// out standing access to a workspace or a project.

import { describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { db } from '@/lib/db';
import {
  acceptInvitationTokenForUser,
  acceptPendingInvitationsForUser,
  buildInvitationUrl,
  createOrRefreshInvitation,
  getValidInvitationByToken,
  sendInvitationEmail,
} from '@/lib/invitations';
import { mailTo, sentMail } from '../helpers/mail';
import {
  addProjectMember,
  addWorkspaceMember,
  createInvitation,
  createUser,
  seedProject,
} from '../factories';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

describe('createOrRefreshInvitation', () => {
  it('retries a PostgreSQL driver write conflict and persists the invitation once', async () => {
    const scenario = await seedProject();
    const conflict = Object.assign(new Error('TransactionWriteConflict'), {
      name: 'DriverAdapterError',
      cause: { kind: 'TransactionWriteConflict' },
    });
    const transaction = vi.spyOn(db, '$transaction').mockRejectedValueOnce(conflict);
    try {
      const invitation = await createOrRefreshInvitation({
        email: 'invitee@example.com',
        scope: 'WORKSPACE',
        role: 'COMMENTATOR',
        invitedById: scenario.owner.id,
        workspaceId: scenario.workspace.id,
      });
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(await db.invitation.findMany()).toEqual([invitation]);
      expect(invitation.status).toBe('PENDING');
      expect(invitation.email).toBe('invitee@example.com');
    } finally {
      transaction.mockRestore();
    }
  });

  it('stops retrying a persistent PostgreSQL driver write conflict after three attempts', async () => {
    const scenario = await seedProject();
    const conflict = Object.assign(new Error('TransactionWriteConflict'), {
      name: 'DriverAdapterError',
      cause: { kind: 'TransactionWriteConflict' },
    });
    const transaction = vi.spyOn(db, '$transaction').mockRejectedValue(conflict);
    try {
      await expect(
        createOrRefreshInvitation({
          email: 'invitee@example.com',
          scope: 'WORKSPACE',
          role: 'COMMENTATOR',
          invitedById: scenario.owner.id,
          workspaceId: scenario.workspace.id,
        })
      ).rejects.toBe(conflict);
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(await db.invitation.count()).toBe(0);
    } finally {
      transaction.mockRestore();
    }
  });

  it('creates a pending invitation with a normalized address and a 32-byte token', async () => {
    const scenario = await seedProject();

    const invitation = await createOrRefreshInvitation({
      email: '  Invitee@Example.COM  ',
      scope: 'WORKSPACE',
      role: 'COMMENTATOR',
      invitedById: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });

    expect(invitation.email).toBe('invitee@example.com');
    expect(invitation.status).toBe('PENDING');
    expect(invitation.role).toBe('COMMENTATOR');
    expect(invitation.invitedById).toBe(scenario.owner.id);
    expect(invitation.workspaceId).toBe(scenario.workspace.id);
    expect(invitation.projectId).toBeNull();
    expect(invitation.acceptedAt).toBeNull();
    // randomBytes(32).toString('hex'). A short or non-random token here is the
    // whole security of the accept link.
    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/);
    // The TTL is 7 days; allow a minute for the round trip.
    const ttl = invitation.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(SEVEN_DAYS_MS - MINUTE_MS);
    expect(ttl).toBeLessThanOrEqual(SEVEN_DAYS_MS);
  });

  it('refreshes the live invitation in place and preserves its token', async () => {
    const scenario = await seedProject();
    const args = {
      email: 'invitee@example.com',
      scope: 'PROJECT' as const,
      invitedById: scenario.owner.id,
      projectId: scenario.project.id,
    };

    const first = await createOrRefreshInvitation({ ...args, role: 'COMMENTATOR' });
    const second = await createOrRefreshInvitation({ ...args, role: 'ADMIN' });

    expect(second.id).toBe(first.id);
    expect(await db.invitation.count()).toBe(1);
    expect(second.token).toBe(first.token);
    expect(second.role).toBe('ADMIN');
    expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(first.expiresAt.getTime());
  });

  it('expires a stale pending invitation rather than reviving it', async () => {
    const scenario = await seedProject();
    const stale = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });

    const fresh = await createOrRefreshInvitation({
      email: 'invitee@example.com',
      scope: 'WORKSPACE',
      role: 'COMMENTATOR',
      invitedById: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });

    expect(fresh.id).not.toBe(stale.id);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(
      'EXPIRED'
    );
    expect(fresh.status).toBe('PENDING');
    expect(await db.invitation.count()).toBe(2);
  });

  it('preserves previously shared links when duplicate pending rows already exist', async () => {
    const scenario = await seedProject();
    for (let i = 0; i < 2; i++) {
      await createInvitation({
        invitedById: scenario.owner.id,
        email: 'invitee@example.com',
        scope: 'WORKSPACE',
        workspaceId: scenario.workspace.id,
      });
    }

    const refreshed = await createOrRefreshInvitation({
      email: 'invitee@example.com',
      scope: 'WORKSPACE',
      role: 'ADMIN',
      invitedById: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });

    const pending = await db.invitation.findMany({ where: { status: 'PENDING' } });
    expect(pending.map((row) => row.id)).toContain(refreshed.id);
    expect(pending).toHaveLength(2);
    expect(await db.invitation.count({ where: { status: 'CANCELED' } })).toBe(0);
    expect(await db.invitation.count()).toBe(2);
  });

  it('keeps a workspace invitation and a project invitation for one address apart', async () => {
    const scenario = await seedProject();

    const workspaceInvitation = await createOrRefreshInvitation({
      email: 'invitee@example.com',
      scope: 'WORKSPACE',
      role: 'ADMIN',
      invitedById: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });
    const projectInvitation = await createOrRefreshInvitation({
      email: 'invitee@example.com',
      scope: 'PROJECT',
      role: 'COMMENTATOR',
      invitedById: scenario.owner.id,
      projectId: scenario.project.id,
    });

    expect(projectInvitation.id).not.toBe(workspaceInvitation.id);
    expect(await db.invitation.count({ where: { status: 'PENDING' } })).toBe(2);
  });

  it('applies a role downgrade to all older live links for the same recipient and target', async () => {
    const f = await seedProject();
    const invited = await createUser();
    const older = await createInvitation({
      invitedById: f.owner.id,
      email: invited.email!,
      scope: 'WORKSPACE',
      workspaceId: f.workspace.id,
      role: 'ADMIN',
    });
    const latest = await createInvitation({
      invitedById: f.owner.id,
      email: invited.email!,
      scope: 'WORKSPACE',
      workspaceId: f.workspace.id,
      role: 'COMMENTATOR',
    });
    await createOrRefreshInvitation({
      invitedById: f.owner.id,
      email: invited.email!,
      scope: 'WORKSPACE',
      workspaceId: f.workspace.id,
      role: 'COMMENTATOR',
    });
    const rows = await db.invitation.findMany({ where: { id: { in: [older.id, latest.id] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.role === 'COMMENTATOR' && row.status === 'PENDING')).toBe(true);
    expect(rows.find((row) => row.id === older.id)?.token).toBe(older.token);
    expect(rows.find((row) => row.id === latest.id)?.token).toBe(latest.token);
    expect(
      await acceptInvitationTokenForUser({
        token: older.token,
        userId: invited.id,
        email: invited.email!,
      })
    ).toBe('accepted');
    expect(
      (
        await db.workspaceMember.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: invited.id } },
        })
      ).role
    ).toBe('COMMENTATOR');
  });
});

describe('getValidInvitationByToken', () => {
  it('returns the pending invitation behind a live token', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      token: 'live-token',
    });

    expect((await getValidInvitationByToken('live-token'))?.id).toBe(invitation.id);
  });

  it('returns null for an expired token', async () => {
    const scenario = await seedProject();
    await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      token: 'stale-token',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });

    expect(await getValidInvitationByToken('stale-token')).toBeNull();
  });

  it.each(['ACCEPTED', 'CANCELED', 'EXPIRED'] as const)(
    'returns null for a %s invitation',
    async (status) => {
      const scenario = await seedProject();
      await createInvitation({
        invitedById: scenario.owner.id,
        scope: 'PROJECT',
        projectId: scenario.project.id,
        token: 'consumed-token',
        status,
      });

      expect(await getValidInvitationByToken('consumed-token')).toBeNull();
    }
  );

  it('returns null for a token nobody was ever given', async () => {
    expect(await getValidInvitationByToken('not-a-real-token')).toBeNull();
  });
});

describe('acceptInvitationTokenForUser', () => {
  // The role carried by the invitation is the only thing that decides the
  // membership role. A COMMENTATOR invite that lands as an ADMIN membership is
  // a silent privilege escalation, so both scopes are pinned in both roles.
  it.each([
    ['COMMENTATOR', 'COMMENTATOR'],
    ['ADMIN', 'ADMIN'],
  ] as const)('a %s workspace invitation grants exactly %s', async (invitedRole, memberRole) => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
      role: invitedRole,
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: invitee.email!,
    });

    expect(result).toBe('accepted');
    const membership = await db.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: scenario.workspace.id, userId: invitee.id } },
    });
    expect(membership.role).toBe(memberRole);
    expect(await db.projectMember.count()).toBe(0);
  });

  it.each([
    ['COMMENTATOR', 'COMMENTATOR'],
    ['ADMIN', 'ADMIN'],
  ] as const)('a %s project invitation grants exactly %s', async (invitedRole, memberRole) => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
      role: invitedRole,
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: invitee.email!,
    });

    expect(result).toBe('accepted');
    const membership = await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: scenario.project.id, userId: invitee.id } },
    });
    expect(membership.role).toBe(memberRole);
    expect(await db.workspaceMember.count()).toBe(0);
  });

  it('consumes the invitation and stamps acceptedAt', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
    });

    await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: invitee.email!,
    });

    const stored = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(stored.status).toBe('ACCEPTED');
    expect(stored.acceptedAt).toBeInstanceOf(Date);
  });

  it('refuses the same token a second time and leaves the membership as it was', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
      role: 'COMMENTATOR',
    });
    const accept = () =>
      acceptInvitationTokenForUser({
        token: invitation.token,
        userId: invitee.id,
        email: invitee.email!,
      });

    expect(await accept()).toBe('accepted');
    // Someone with the link should not be able to undo a later demotion by
    // replaying it, so the second accept must not reapply the invited role.
    await db.projectMember.update({
      where: { projectId_userId: { projectId: scenario.project.id, userId: invitee.id } },
      data: { role: 'ADMIN' },
    });

    expect(await accept()).toBe('not_found');
    expect(await db.projectMember.count()).toBe(1);
    const membership = await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: scenario.project.id, userId: invitee.id } },
    });
    expect(membership.role).toBe('ADMIN');
  });

  // An invitation is bound to an address. A forwarded link must not let the
  // recipient walk into the project on their own account.
  it('refuses a token issued to a different address', async () => {
    const scenario = await seedProject();
    const bystander = await createUser({ email: 'someone.else@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'intended@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: bystander.id,
      email: bystander.email!,
    });

    expect(result).toBe('forbidden');
    expect(await db.projectMember.count()).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'PENDING'
    );
  });

  it('matches the invited address case-insensitively and ignores stray whitespace', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: '  Invitee@Example.COM  ',
    });

    expect(result).toBe('accepted');
    expect(await db.workspaceMember.count()).toBe(1);
  });

  it('reports an expired invitation as expired, flips the row, and grants nothing', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: invitee.email!,
    });

    expect(result).toBe('expired');
    expect(await db.projectMember.count()).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'EXPIRED'
    );
  });

  it.each(['ACCEPTED', 'CANCELED', 'EXPIRED'] as const)(
    'refuses a %s invitation without granting a membership',
    async (status) => {
      const scenario = await seedProject();
      const invitee = await createUser({ email: 'invitee@example.com' });
      const invitation = await createInvitation({
        invitedById: scenario.owner.id,
        email: 'invitee@example.com',
        scope: 'PROJECT',
        projectId: scenario.project.id,
        status,
      });

      const result = await acceptInvitationTokenForUser({
        token: invitation.token,
        userId: invitee.id,
        email: invitee.email!,
      });

      expect(result).toBe('not_found');
      expect(await db.projectMember.count()).toBe(0);
      expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
        status
      );
    }
  );

  it('reports an unknown token as not_found', async () => {
    const user = await createUser();

    const result = await acceptInvitationTokenForUser({
      token: 'not-a-real-token',
      userId: user.id,
      email: user.email!,
    });

    expect(result).toBe('not_found');
  });

  it('promotes an existing COMMENTATOR to ADMIN without duplicating the membership', async () => {
    const scenario = await seedProject();
    const member = await createUser({ email: 'member@example.com' });
    await addProjectMember({
      projectId: scenario.project.id,
      userId: member.id,
      role: 'COMMENTATOR',
    });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'member@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
      role: 'ADMIN',
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: member.id,
      email: member.email!,
    });

    expect(result).toBe('accepted');
    expect(await db.projectMember.count()).toBe(1);
    const membership = await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: scenario.project.id, userId: member.id } },
    });
    expect(membership.role).toBe('ADMIN');
  });

  // An invitation can only ever add access. Applying the invited role over an existing
  // membership made it a privilege-change primitive: re-invite a sitting ADMIN at a lower
  // role, get them to click the link once, and they are demoted.
  it('leaves an existing ADMIN membership alone for a COMMENTATOR invitation', async () => {
    const scenario = await seedProject();
    const member = await createUser({ email: 'member@example.com' });
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: member.id,
      role: 'ADMIN',
    });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'member@example.com',
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
      role: 'COMMENTATOR',
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: member.id,
      email: member.email!,
    });

    expect(result).toBe('accepted');
    const membership = await db.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: scenario.workspace.id, userId: member.id } },
    });
    expect(membership.role).toBe('ADMIN');
  });

  it('leaves an existing project ADMIN alone for a COMMENTATOR invitation', async () => {
    const scenario = await seedProject();
    const member = await createUser({ email: 'member@example.com' });
    await addProjectMember({
      projectId: scenario.project.id,
      userId: member.id,
      role: 'ADMIN',
    });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'member@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
      role: 'COMMENTATOR',
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: member.id,
      email: member.email!,
    });

    expect(result).toBe('accepted');
    const membership = await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: scenario.project.id, userId: member.id } },
    });
    expect(membership.role).toBe('ADMIN');
  });

  // The other direction still has to work: an invitation is allowed to promote.
  it('promotes an existing COMMENTATOR to ADMIN for an ADMIN invitation', async () => {
    const scenario = await seedProject();
    const member = await createUser({ email: 'member@example.com' });
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: member.id,
      role: 'COMMENTATOR',
    });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'member@example.com',
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
      role: 'ADMIN',
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: member.id,
      email: member.email!,
    });

    expect(result).toBe('accepted');
    const membership = await db.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: scenario.workspace.id, userId: member.id } },
    });
    expect(membership.role).toBe('ADMIN');
  });

  // The owner already outranks any membership row. Writing one would put them
  // in their own member list and, for a COMMENTATOR invitation, next to a role
  // that reads as a demotion.
  it('gives the workspace owner no member row yet still consumes the invitation', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: scenario.owner.email!,
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
      role: 'COMMENTATOR',
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: scenario.owner.id,
      email: scenario.owner.email!,
    });

    expect(result).toBe('accepted');
    expect(await db.workspaceMember.count()).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'ACCEPTED'
    );
  });

  it('gives the project owner no member row yet still consumes the invitation', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: scenario.owner.email!,
      scope: 'PROJECT',
      projectId: scenario.project.id,
      role: 'ADMIN',
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: scenario.owner.id,
      email: scenario.owner.email!,
    });

    expect(result).toBe('accepted');
    expect(await db.projectMember.count()).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'ACCEPTED'
    );
  });

  // A malformed row (scope WORKSPACE with no workspaceId) grants nothing. Reporting
  // "accepted" for it showed the user a success screen for a no-op they had no way to
  // detect, while the invitation stayed PENDING for good.
  it('refuses a scoped invitation that points at nothing', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'WORKSPACE',
      workspaceId: null,
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: invitee.email!,
    });

    expect(result).toBe('not_found');
    expect(await db.workspaceMember.count()).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'PENDING'
    );
  });

  it('refuses a project invitation that points at nothing', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'PROJECT',
      projectId: null,
    });

    const result = await acceptInvitationTokenForUser({
      token: invitation.token,
      userId: invitee.id,
      email: invitee.email!,
    });

    expect(result).toBe('not_found');
    expect(await db.projectMember.count()).toBe(0);
  });
});

describe('acceptPendingInvitationsForUser', () => {
  it('applies every live invitation for the address with the role each one carries', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const workspaceInvitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
      role: 'COMMENTATOR',
    });
    const projectInvitation = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
      role: 'ADMIN',
    });

    await acceptPendingInvitationsForUser(invitee.id, '  Invitee@Example.COM  ');

    const workspaceMembership = await db.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: scenario.workspace.id, userId: invitee.id } },
    });
    const projectMembership = await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: scenario.project.id, userId: invitee.id } },
    });
    expect(workspaceMembership.role).toBe('COMMENTATOR');
    expect(projectMembership.role).toBe('ADMIN');
    for (const id of [workspaceInvitation.id, projectInvitation.id]) {
      expect((await db.invitation.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED');
    }
  });

  it('expires the stale invitations instead of granting them', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const stale = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'invitee@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });

    await acceptPendingInvitationsForUser(invitee.id, invitee.email!);

    expect(await db.projectMember.count()).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(
      'EXPIRED'
    );
  });

  it('ignores invitations addressed to somebody else', async () => {
    const scenario = await seedProject();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const other = await createInvitation({
      invitedById: scenario.owner.id,
      email: 'stranger@example.com',
      scope: 'PROJECT',
      projectId: scenario.project.id,
      role: 'ADMIN',
    });

    await acceptPendingInvitationsForUser(invitee.id, invitee.email!);

    expect(await db.projectMember.count()).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      'PENDING'
    );
  });
});

describe('buildInvitationUrl', () => {
  it('points at /invitations/accept on the configured origin', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.test');

    expect(buildInvitationUrl('abc123')).toBe(
      'https://app.example.test/invitations/accept?token=abc123'
    );
  });

  it('escapes a token that carries query syntax', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.test');

    expect(buildInvitationUrl('a b&c=d')).toBe(
      'https://app.example.test/invitations/accept?token=a+b%26c%3Dd'
    );
  });
});

describe('sendInvitationEmail', () => {
  const invite = {
    to: 'invitee@example.com',
    inviterName: 'Ada Lovelace',
    role: 'COMMENTATOR' as const,
    scope: 'WORKSPACE' as const,
    targetName: 'Acme',
    invitationUrl: 'https://app.example.test/invitations/accept?token=abc123',
  };

  it('mails the invited address a message carrying the accept link', async () => {
    vi.stubEnv('SMTP_FROM', 'OpenFrame <invites@example.test>');

    expect(await sendInvitationEmail(invite)).toBe(true);

    const mails = mailTo('invitee@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0].from).toBe('OpenFrame <invites@example.test>');
    expect(mails[0].subject).toBe('[OpenFrame] You were invited to a workspace: Acme');
    expect(mails[0].html).toContain('https://app.example.test/invitations/accept?token=abc123');
    expect(mails[0].html).toContain('Ada Lovelace');
    expect(mails[0].html).toContain('Commentator');
  });

  it('names the project scope and the Admin role in a project admin invitation', async () => {
    expect(
      await sendInvitationEmail({
        ...invite,
        scope: 'PROJECT',
        role: 'ADMIN',
        targetName: 'Launch Film',
      })
    ).toBe(true);

    const mails = mailTo('invitee@example.com');
    expect(mails[0].subject).toBe('[OpenFrame] You were invited to a project: Launch Film');
    expect(mails[0].html).toContain('Admin');
    expect(mails[0].html).not.toContain('Commentator');
  });

  // The inviter's display name and the target name are user-supplied and land
  // in an HTML mail body.
  it('escapes markup in the inviter and target names', async () => {
    await sendInvitationEmail({
      ...invite,
      inviterName: '<script>alert(1)</script>',
      targetName: '<img src=x onerror=alert(2)>',
    });

    const html = mailTo('invitee@example.com')[0].html!;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('reports failure instead of throwing when the transport rejects', async () => {
    vi.mocked(nodemailer.createTransport).mockReturnValueOnce({
      sendMail: vi.fn(async () => {
        throw new Error('smtp is down');
      }),
    } as unknown as ReturnType<typeof nodemailer.createTransport>);

    expect(await sendInvitationEmail(invite)).toBe(false);
    expect(sentMail()).toEqual([]);
  });

  it('sends nothing and reports failure when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASSWORD', '');

    expect(await sendInvitationEmail(invite)).toBe(false);
    expect(sentMail()).toEqual([]);
  });
});
