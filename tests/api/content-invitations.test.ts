import { describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { db } from '@/lib/db';
import { POST } from '@/app/api/projects/[projectId]/folders/route';
import { acceptInvitationTokenForUser } from '@/lib/invitations';
import { createUser, seedProject, addProjectMember } from '../factories';
import { signedInAs, signedOut } from '../helpers/session';
import { apiRequest, callRoute } from '../helpers/request';
import { mailTo, sentMail } from '../helpers/mail';

async function fixture() {
  const scenario = await seedProject();
  const folder = await db.projectFolder.create({
    data: { projectId: scenario.project.id, name: 'Review folder', accessMode: 'RESTRICTED' },
  });
  const video = await db.video.create({
    data: { projectId: scenario.project.id, title: 'Review video', accessMode: 'RESTRICTED' },
  });
  return { ...scenario, folder, video };
}

function request(projectId: string, body: object) {
  return callRoute(POST, apiRequest(`/api/projects/${projectId}/folders`, { body }), { projectId });
}

describe('content invitations', () => {
  it.each(['folder', 'video'] as const)(
    'sends a %s invitation and resends the original link',
    async (target) => {
      const f = await fixture();
      const invited = await createUser();
      signedInAs(f.owner);
      const body = {
        action: 'invite',
        ...(target === 'folder' ? { folderId: f.folder.id } : { videoId: f.video.id }),
        email: invited.email,
        role: 'COMMENTATOR',
      };
      const first = await request(f.project.id, body);
      expect(first.status).toBe(200);
      const initial = (await first.json()).data;
      expect(initial.emailSent).toBe(true);
      const token = new URL(initial.invitationUrl).searchParams.get('token')!;
      const row = await db.invitation.findUniqueOrThrow({ where: { token } });
      expect(row.scope).toBe(target.toUpperCase());
      expect(mailTo(invited.email!)[0].subject).toContain(`a ${target}: Review ${target}`);
      expect(mailTo(invited.email!)[0].html).toContain(initial.invitationUrl);
      await db.invitation.update({
        where: { id: row.id },
        data: { expiresAt: new Date(Date.now() + 60000) },
      });

      const second = await request(f.project.id, body);
      expect(second.status).toBe(200);
      expect((await second.json()).data.invitationUrl).toBe(initial.invitationUrl);
      const refreshed = await db.invitation.findUniqueOrThrow({ where: { token } });
      expect(refreshed.status).toBe('PENDING');
      expect(refreshed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
      expect(await db.invitation.count()).toBe(1);
      expect(mailTo(invited.email!)).toHaveLength(2);
      expect(mailTo(invited.email!)[1].html).toContain(initial.invitationUrl);

      const listing = await request(f.project.id, { ...body, action: 'members' });
      expect((await listing.json()).data.invitations).toEqual([
        expect.objectContaining({
          id: row.id,
          email: invited.email,
          invitationUrl: initial.invitationUrl,
        }),
      ]);
      expect(
        await acceptInvitationTokenForUser({ token, userId: invited.id, email: invited.email! })
      ).toBe('accepted');
      const membership =
        target === 'folder'
          ? await db.projectFolderMember.findUnique({
              where: { folderId_userId: { folderId: f.folder.id, userId: invited.id } },
            })
          : await db.videoMember.findUnique({
              where: { videoId_userId: { videoId: f.video.id, userId: invited.id } },
            });
      expect(membership?.role).toBe('COMMENTATOR');
    }
  );

  it.each(['anonymous', 'commentator'] as const)(
    'refuses an %s caller without writing or emailing',
    async (caller) => {
      const f = await fixture();
      if (caller === 'anonymous') signedOut();
      else {
        const commentator = await createUser();
        await addProjectMember({
          projectId: f.project.id,
          userId: commentator.id,
          role: 'COMMENTATOR',
        });
        signedInAs(commentator);
      }
      const result = await request(f.project.id, {
        action: 'invite',
        folderId: f.folder.id,
        email: 'guest@example.com',
        role: 'COMMENTATOR',
      });
      expect(result.status).toBe(caller === 'anonymous' ? 401 : 403);
      expect(await db.invitation.count()).toBe(0);
      expect(sentMail()).toEqual([]);
    }
  );

  it('keeps the pending invitation and fallback link when SMTP fails', async () => {
    const f = await fixture();
    signedInAs(f.owner);
    vi.mocked(nodemailer.createTransport).mockReturnValueOnce({
      sendMail: vi.fn().mockRejectedValue(new Error('SMTP unavailable')),
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const result = await request(f.project.id, {
      action: 'invite',
      folderId: f.folder.id,
      email: 'guest@example.com',
      role: 'COMMENTATOR',
    });
    expect(result.status).toBe(200);
    const data = (await result.json()).data;
    expect(data.emailSent).toBe(false);
    const token = new URL(data.invitationUrl).searchParams.get('token')!;
    expect((await db.invitation.findUniqueOrThrow({ where: { token } })).status).toBe('PENDING');
    expect(sentMail()).toEqual([]);
  });

  it('keeps invitations for other recipients and targets independently usable', async () => {
    const f = await fixture();
    signedInAs(f.owner);
    const body = {
      action: 'invite',
      folderId: f.folder.id,
      email: 'one@example.com',
      role: 'COMMENTATOR',
    };
    const initial = (await (await request(f.project.id, body)).json()).data.invitationUrl;
    await request(f.project.id, { ...body, email: 'two@example.com' });
    await request(f.project.id, {
      action: 'invite',
      videoId: f.video.id,
      email: body.email,
      role: body.role,
    });
    await request(f.project.id, body);
    const listing = (
      await (await request(f.project.id, { action: 'members', folderId: f.folder.id })).json()
    ).data.invitations;
    expect(listing).toHaveLength(2);
    expect(listing.find((row: { email: string }) => row.email === body.email).invitationUrl).toBe(
      initial
    );
    expect(await db.invitation.count({ where: { status: 'PENDING' } })).toBe(3);
  });
});
