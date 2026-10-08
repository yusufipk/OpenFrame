import '../helpers/env';
import type { Locator } from '@playwright/test';
import { db } from '@/lib/db';
import { createComment } from '../factories';
import { test, expect } from './fixtures';

// An @asset mention in a comment opens that file's preview on the spot. The reader
// stays in the comment list, at the same scroll position, the whole time.

const COMMENT_COUNT = 30;

function scrollTopOf(locator: Locator) {
  return locator.evaluate((element) => element.closest('.overflow-y-auto')!.scrollTop);
}

test('an asset mention opens the preview without leaving the comment list', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  const asset = await db.videoAsset.create({
    data: {
      videoId: seeded.videoId,
      kind: 'IMAGE',
      provider: 'R2_IMAGE',
      displayName: 'Reference frame',
      sourceUrl: '/api/upload/image/reference-frame.png',
      billedUserId: seededUser.id,
      uploadedByUserId: seededUser.id,
    },
  });
  for (let index = 1; index <= COMMENT_COUNT; index += 1) {
    await createComment({
      versionId: seeded.versionId,
      authorId: seededUser.id,
      timestamp: index,
      content:
        index === COMMENT_COUNT
          ? `Match the grade to @[Reference frame](asset:${asset.id}) here`
          : `Filler note ${index}`,
    });
  }

  await page.setViewportSize({ width: 1440, height: 700 });
  // The mention renders from the comment text before the asset list arrives, and a
  // click on an asset that is not loaded yet falls back to the Assets pane.
  const assetsLoaded = page.waitForResponse(
    (response) => response.url().includes(`/api/videos/${seeded.videoId}/assets`) && response.ok()
  );
  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  await assetsLoaded;
  const mention = page.getByRole('button', { name: '@Reference frame', exact: true });
  await mention.scrollIntoViewIfNeeded();
  const scrolledTo = await scrollTopOf(mention);
  expect(scrolledTo).toBeGreaterThan(0);

  await mention.click();
  const preview = page.getByRole('dialog');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Reference frame');
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();

  // Still on Comments, still at the mention.
  await expect(mention).toBeInViewport();
  expect(await scrollTopOf(mention)).toBe(scrolledTo);
});

test('switching to Assets and back keeps the comment list scroll position', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  for (let index = 1; index <= COMMENT_COUNT; index += 1) {
    await createComment({
      versionId: seeded.versionId,
      authorId: seededUser.id,
      timestamp: index,
      content: `Note ${index}`,
    });
  }

  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  const lastNote = page.getByText(`Note ${COMMENT_COUNT}`, { exact: true });
  await lastNote.scrollIntoViewIfNeeded();
  const scrolledTo = await scrollTopOf(lastNote);
  expect(scrolledTo).toBeGreaterThan(0);

  await page.getByRole('button', { name: /^Assets/ }).click();
  await expect(page.getByText(`Note ${COMMENT_COUNT}`, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: /^Comments/ }).click();

  await expect(lastNote).toBeInViewport();
  expect(await scrollTopOf(lastNote)).toBe(scrolledTo);
});
