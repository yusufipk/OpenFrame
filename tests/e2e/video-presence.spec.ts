import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { test, expect } from './fixtures';
import { db } from '@/lib/db';
import { REPO_ROOT } from '../helpers/env';

const peopleButton = (page: Page, count: number) =>
  page.getByRole('button', { name: `${count} people on this video`, exact: true });
const roster = (page: Page) => page.getByRole('dialog', { name: 'People on this video' });

async function noOverflow(page: Page) {
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  const box = await roster(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const header = await page
    .getByRole('link', { name: 'Back', exact: true })
    .locator('xpath=../..')
    .boundingBox();
  const back = await page.getByRole('link', { name: 'Back', exact: true }).boundingBox();
  const trigger = await page.getByRole('button', { name: /people on this video/ }).boundingBox();
  expect(header).not.toBeNull();
  expect(back).not.toBeNull();
  expect(trigger).not.toBeNull();
  expect(back!.x).toBeGreaterThanOrEqual(header!.x);
  if (trigger!.y < back!.y + back!.height) {
    expect(back!.x + back!.width).toBeLessThanOrEqual(trigger!.x);
  }
  const version = await page.getByRole('button', { name: /^v1/ }).boundingBox();
  expect(version).not.toBeNull();
  if (version!.y < back!.y + back!.height) {
    expect(version!.x).toBeGreaterThanOrEqual(back!.x + back!.width);
  }
  expect(trigger!.x + trigger!.width).toBeLessThanOrEqual(header!.x + header!.width);
}

for (const layout of ['desktop', 'mobile'] as const) {
  test.describe(`video presence on ${layout}`, () => {
    test.use(
      layout === 'mobile'
        ? {
            viewport: { width: 375, height: 812 },
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
            userAgent: devices['Pixel 7'].userAgent,
          }
        : { viewport: { width: 1440, height: 900 } }
    );

    test('named and anonymous viewers appear without a live room, tabs merge and navigation removes viewers', async ({
      page,
      browser,
      seed,
      seededUser,
    }, testInfo) => {
      const seeded = await seed.version(seededUser, {
        title: 'A review cut with a long descriptive title for responsive layout',
      });
      const link = await seed.shareLink({
        projectId: seeded.project.id,
        videoId: seeded.videoId,
        permission: 'COMMENT',
      });
      const contexts = await Promise.all(
        [0, 1].map(() =>
          browser.newContext({
            storageState: undefined,
            ...(layout === 'mobile' ? devices['Pixel 7'] : {}),
            viewport: {
              width: layout === 'mobile' ? 375 : 1440,
              height: layout === 'mobile' ? 812 : 900,
            },
          })
        )
      );
      try {
        await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
        await expect(peopleButton(page, 1)).toBeVisible();
        const guestPages = await Promise.all(
          contexts.map(async (context, index) => {
            const guest = await context.newPage();
            await guest.goto(`/s/${link.token}`);
            await guest.getByPlaceholder('Your name').fill(`Comment name ${index}`);
            await guest.getByRole('button', { name: 'Continue', exact: true }).click();
            await expect(guest.getByPlaceholder('Add a comment...')).toBeVisible();
            return guest;
          })
        );
        await expect(peopleButton(page, 3)).toBeVisible();
        await peopleButton(page, 3).click();
        await expect(roster(page).getByText(`${seededUser.name}`, { exact: false })).toBeVisible();
        await expect(roster(page).getByTestId('presence-person')).toHaveCount(3);
        await expect(roster(page).getByText('· Anonymous', { exact: true })).toHaveCount(2);
        await expect(roster(page).getByText(/Comment name/)).toHaveCount(0);
        const guestNames = await roster(page)
          .getByTestId('presence-person')
          .filter({ hasText: 'Anonymous' })
          .locator('p.font-medium')
          .allTextContents();
        expect(guestNames).toHaveLength(2);
        for (const name of guestNames) expect(name).toMatch(/^[A-Za-z]+ [A-Za-z]+$/);
        await expect(page.getByRole('button', { name: /Room participants/ })).toHaveCount(0);
        await noOverflow(page);
        await page.screenshot({
          path: testInfo.outputPath(`presence-${layout}-owner.png`),
          fullPage: true,
        });
        await page.keyboard.press('Escape');

        await expect(peopleButton(guestPages[0], 3)).toBeVisible();
        await peopleButton(guestPages[0], 3).click();
        await expect(roster(guestPages[0]).getByTestId('presence-person')).toHaveCount(3);
        await expect(roster(guestPages[0]).getByText('(you)', { exact: false })).toBeVisible();
        await noOverflow(guestPages[0]);
        await guestPages[0].screenshot({
          path: testInfo.outputPath(`presence-${layout}-guest.png`),
          fullPage: true,
        });
        await guestPages[0].keyboard.press('Escape');

        const extraTab = await page.context().newPage();
        await extraTab.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
        await expect(peopleButton(extraTab, 3)).toBeVisible();
        expect(await db.videoPresence.count({ where: { videoId: seeded.videoId } })).toBe(4);
        await extraTab.goto('/dashboard');
        await expect
          .poll(() => db.videoPresence.count({ where: { videoId: seeded.videoId } }))
          .toBe(3);
        await extraTab.close();
        await expect(peopleButton(page, 3)).toBeVisible();

        if (layout === 'mobile') {
          await page.setViewportSize({ width: 320, height: 568 });
          await peopleButton(page, 3).click();
          await noOverflow(page);
          await page.screenshot({
            path: testInfo.outputPath('presence-mobile-320.png'),
            fullPage: true,
          });
          await page.keyboard.press('Escape');
          await page.setViewportSize({ width: 812, height: 375 });
          await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
          await peopleButton(page, 3).click();
          await noOverflow(page);
          await page.screenshot({
            path: testInfo.outputPath('presence-mobile-landscape.png'),
            fullPage: true,
          });
          await page.keyboard.press('Escape');
          await guestPages[0].setViewportSize({ width: 812, height: 375 });
          await expect(
            guestPages[0].getByRole('button', { name: 'Download', exact: true })
          ).toBeVisible();
          await peopleButton(guestPages[0], 3).click();
          await noOverflow(guestPages[0]);
          await guestPages[0].keyboard.press('Escape');
        } else {
          await page.setViewportSize({ width: 1024, height: 768 });
          await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
          await peopleButton(page, 3).click();
          await noOverflow(page);
          await page.screenshot({
            path: testInfo.outputPath('presence-desktop-1024.png'),
            fullPage: true,
          });
          await page.keyboard.press('Escape');
        }
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await expect(
          page.getByRole('menuitem', { name: 'New Version', exact: true })
        ).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Approvals', exact: true })).toBeVisible();
        await expect(
          page.getByRole('menuitem', { name: 'Share Video', exact: true })
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await guestPages[1].goto('/login');
        await expect(peopleButton(page, 2)).toBeVisible();
        await peopleButton(page, 2).click();
        await expect(roster(page).getByTestId('presence-person')).toHaveCount(2);
      } finally {
        await Promise.all(contexts.map((context) => context.close()));
      }
    });
  });
}

test('a real player reports play and pause to another viewer', async ({
  page,
  browser,
  seed,
  seededUser,
}) => {
  const seeded = await seed.bunnyVersion(seededUser, { duration: 2 });
  const link = await seed.shareLink({
    projectId: seeded.project.id,
    videoId: seeded.videoId,
    permission: 'COMMENT',
  });
  await db.shareLink.update({ where: { id: link.id }, data: { allowDownloads: true } });
  const guestContext = await browser.newContext({ storageState: undefined });
  let mediaRequests = 0;
  try {
    const guest = await guestContext.newPage();
    await guest.route('**/original*', async (route) => {
      const url = new URL(route.request().url());
      if (
        url.hostname !== 'bunny-e2e.b-cdn.net' ||
        !url.pathname.startsWith(`/${seeded.providerVideoId}/`)
      )
        return route.continue();
      mediaRequests++;
      await route.fulfill({
        status: 200,
        contentType: 'video/mp4',
        body: fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/sample.mp4')),
        headers: { 'access-control-allow-origin': '*' },
      });
    });
    await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
    await guest.goto(`/s/${link.token}`);
    await guest.getByPlaceholder('Your name').fill('Playback Reviewer');
    await guest.getByRole('button', { name: 'Continue', exact: true }).click();
    const video = guest.locator('video');
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
    expect(mediaRequests).toBeGreaterThan(0);
    await expect(peopleButton(page, 2)).toBeVisible();
    await peopleButton(page, 2).click();
    await video.evaluate(async (element) => {
      const media = element as HTMLVideoElement;
      media.loop = true;
      await media.play();
    });
    await expect(
      roster(page)
        .getByTestId('presence-person')
        .filter({ hasText: 'Anonymous' })
        .getByText('Playing video', { exact: true })
    ).toBeVisible();
    await video.evaluate((element) => (element as HTMLVideoElement).pause());
    await expect(
      roster(page)
        .getByTestId('presence-person')
        .filter({ hasText: 'Anonymous' })
        .getByText('On page', { exact: true })
    ).toBeVisible();
    expect(
      await video.evaluate((element) => (element as HTMLVideoElement).currentTime)
    ).toBeGreaterThan(0);
  } finally {
    await guestContext.close();
  }
});

test('a non-editor with one version keeps Approvals reachable in a narrow dashboard header', async ({
  page,
  seed,
  seededUser,
}) => {
  const owner = await seed.user();
  const seeded = await seed.version(owner);
  await seed.member(seeded.project.id, seededUser.id, 'COMMENTATOR');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  await expect(peopleButton(page, 1)).toBeVisible();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Approvals', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'New Version', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Share Video', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Approvals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
});

test('an offline viewer expires and returns with the same anonymous identity', async ({
  page,
  browser,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  const link = await seed.shareLink({
    projectId: seeded.project.id,
    videoId: seeded.videoId,
    permission: 'COMMENT',
  });
  const context = await browser.newContext({ storageState: undefined });
  try {
    const guest = await context.newPage();
    await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
    await guest.goto(`/s/${link.token}`);
    await guest.getByPlaceholder('Your name').fill('Offline Reviewer');
    await guest.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(peopleButton(page, 2)).toBeVisible();
    await peopleButton(page, 2).click();
    const anonymousName = await roster(page)
      .getByTestId('presence-person')
      .filter({ hasText: 'Anonymous' })
      .locator('p.font-medium')
      .textContent();
    await page.keyboard.press('Escape');
    await context.setOffline(true);
    await expect(peopleButton(page, 1)).toBeVisible({ timeout: 40_000 });
    await guest.getByRole('button', { name: 'Video presence unavailable' }).click();
    await expect(roster(guest).getByText('Presence is temporarily unavailable.')).toBeVisible();
    await context.setOffline(false);
    await expect(peopleButton(page, 2)).toBeVisible();
    await peopleButton(page, 2).click();
    await expect(roster(page).getByText(anonymousName!, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
