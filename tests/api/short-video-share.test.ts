import { describe, expect, it } from 'vitest';
import ShortSharePage from '@/app/s/[token]/page';
import { ShareLinkBootstrap } from '@/components/share-link-bootstrap';
import { db } from '@/lib/db';
import { createExpiredUser, createShareLink, seedVersion } from '../factories';

function openShortLink(token: string) {
  return ShortSharePage({ params: Promise.resolve({ token }) });
}

describe('short video share page', () => {
  it.each(['VIEW', 'COMMENT'] as const)(
    'resolves a %s video token to the existing share bootstrap',
    async (permission) => {
      const scenario = await seedVersion({ visibility: 'PRIVATE' });
      const link = await createShareLink({
        projectId: scenario.project.id,
        videoId: scenario.video.id,
        permission,
        token: 'abcdefghijklmnop',
      });

      const element = await openShortLink(link.token);

      expect(element.type).toBe(ShareLinkBootstrap);
      expect(element.props).toMatchObject({ videoId: scenario.video.id, shareToken: link.token });
    }
  );

  it('passes a password-protected link to the bootstrap for unlocking', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
      password: 'secret',
    });

    const element = await openShortLink(link.token);

    expect(element.type).toBe(ShareLinkBootstrap);
    expect(element.props).toMatchObject({ videoId: scenario.video.id, shareToken: link.token });
  });

  it('returns not found for unknown, expired, revoked and project-scoped tokens', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const expired = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    const revoked = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'COMMENT',
    });
    const projectScoped = await createShareLink({ projectId: scenario.project.id });
    await db.shareLink.delete({ where: { id: revoked.id } });

    for (const token of ['missing-token', expired.token, revoked.token, projectScoped.token]) {
      await expect(openShortLink(token)).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    }
  });

  it('returns not found when the workspace owner lacks billing access', async () => {
    const expiredOwner = await createExpiredUser();
    const scenario = await seedVersion({ visibility: 'PRIVATE', ownerUser: expiredOwner });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });

    await expect(openShortLink(link.token)).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
