import { describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import * as projectMembers from '@/app/api/projects/[projectId]/members/route';
import * as workspaceMembers from '@/app/api/workspaces/[workspaceId]/members/route';
import { acceptInvitationTokenForUser } from '@/lib/invitations';
import { createUser, seedProject } from '../factories';
import { signedInAs } from '../helpers/session';
import { apiRequest, callRoute } from '../helpers/request';
import { mailTo, sentMail } from '../helpers/mail';

describe.each(['project', 'workspace'] as const)('%s invitation delivery', (target) => {
  it('resends the same link and exposes it to the manager in the pending list', async () => {
    const f = await seedProject();
    const invited = await createUser();
    signedInAs(f.owner);
    const route = target === 'project' ? projectMembers : workspaceMembers;
    const id = f[target].id;
    const params = { projectId: id, workspaceId: id };
    const url = `/api/${target}s/${id}/members`;
    const body = { email: invited.email, role: 'COMMENTATOR' };
    const first = await callRoute(route.POST, apiRequest(url, { body }), params);
    expect(first.status).toBe(200);
    const initial = (await first.json()).data;
    expect(initial.emailSent).toBe(true);
    const token = new URL(initial.invitationUrl).searchParams.get('token')!;
    const second = await callRoute(route.POST, apiRequest(url, { body }), params);
    expect(second.status).toBe(200);
    expect((await second.json()).data.invitationUrl).toBe(initial.invitationUrl);
    expect(mailTo(invited.email!)).toHaveLength(2);
    expect(mailTo(invited.email!)[1].html).toContain(initial.invitationUrl);
    expect(await db.invitation.count()).toBe(1);
    expect((await db.invitation.findUniqueOrThrow({ where: { token } })).status).toBe('PENDING');
    const list = await callRoute(route.GET, apiRequest(url), params);
    expect((await list.json()).data.pendingInvitations).toEqual([
      expect.objectContaining({ email: invited.email, invitationUrl: initial.invitationUrl }),
    ]);
    expect(
      await acceptInvitationTokenForUser({ token, userId: invited.id, email: invited.email! })
    ).toBe('accepted');
    const membership =
      target === 'project'
        ? await db.projectMember.findUnique({
            where: { projectId_userId: { projectId: id, userId: invited.id } },
          })
        : await db.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId: id, userId: invited.id } },
          });
    expect(membership?.role).toBe('COMMENTATOR');
  });

  it('reports SMTP unavailability while retaining the pending invitation and its link', async () => {
    vi.stubEnv('SMTP_HOST', '');
    const f = await seedProject();
    signedInAs(f.owner);
    const route = target === 'project' ? projectMembers : workspaceMembers;
    const id = f[target].id;
    const params = { projectId: id, workspaceId: id };
    const result = await callRoute(
      route.POST,
      apiRequest(`/api/${target}s/${id}/members`, {
        body: { email: 'guest@example.com', role: 'COMMENTATOR' },
      }),
      params
    );
    expect(result.status).toBe(200);
    const data = (await result.json()).data;
    expect(data.emailSent).toBe(false);
    expect(data.message).toContain('email could not be sent');
    const token = new URL(data.invitationUrl).searchParams.get('token')!;
    expect((await db.invitation.findUniqueOrThrow({ where: { token } })).status).toBe('PENDING');
    expect(sentMail()).toEqual([]);
  });
});
