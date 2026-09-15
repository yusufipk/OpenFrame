import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { legacyMedia, legacyFilename } from './media-fixture';

test('migrated videos stay in their projects and their original media still plays', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('legacy-owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('legacy-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/dashboard/);
  await Promise.all(
    [11, 12, 21, 22, 31, 32].map(async (id) => {
      const response = await page.request.get(`/api/upload/video/${legacyFilename(id)}`);
      expect(response.status()).toBe(200);
      expect(
        createHash('sha256')
          .update(await response.body())
          .digest('hex')
      ).toBe(createHash('sha256').update(legacyMedia(id)).digest('hex'));
    })
  );
  for (const visibility of ['private', 'invite', 'public']) {
    await page.goto(`/projects/legacy-${visibility}`);
    await page.getByRole('heading', { name: `Legacy cut ${visibility}`, exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/legacy-${visibility}/videos/legacy-video-${visibility}$`)
    );
    const video = page.locator('video').first();
    const prefix = visibility === 'private' ? 10 : visibility === 'invite' ? 20 : 30;
    await expect
      .poll(() =>
        video.evaluate(
          (element) =>
            new URL((element as HTMLVideoElement).currentSrc, window.location.href).pathname
        )
      )
      .toBe(`/api/upload/video/${legacyFilename(prefix + 2)}`);
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((element) => (element as HTMLVideoElement).duration)).toBeCloseTo(
      2,
      1
    );
    await video.evaluate((element) => (element as HTMLVideoElement).play());
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
      .toBeGreaterThan(0.3);
    await expect(page.getByText('Existing review comment', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /v2 Cut 2/ }).click();
    await page.getByRole('menuitem', { name: /v1 Cut 1/ }).click();
    await expect
      .poll(() =>
        video.evaluate(
          (element) =>
            new URL((element as HTMLVideoElement).currentSrc, window.location.href).pathname
        )
      )
      .toBe(`/api/upload/video/${legacyFilename(prefix + 1)}`);
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(1);
    await video.evaluate((element) => (element as HTMLVideoElement).play());
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
      .toBeGreaterThan(0.3);
  }
});

test('a pre-migration share token still opens and plays the same private video', async ({
  page,
}) => {
  await page.goto('/watch/legacy-video-private?shareToken=legacy-token-private');
  await expect(page).toHaveURL(/\/watch\/legacy-video-private$/);
  await page.getByPlaceholder('Your name').fill('Legacy reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const video = page.locator('video').first();
  await expect
    .poll(() =>
      video.evaluate(
        (element) =>
          new URL((element as HTMLVideoElement).currentSrc, window.location.href).pathname
      )
    )
    .toBe(`/api/upload/video/${legacyFilename(12)}`);
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);
  await video.evaluate((element) => (element as HTMLVideoElement).play());
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.3);
  await expect(page.getByPlaceholder('Add a comment...')).toBeVisible();
});
