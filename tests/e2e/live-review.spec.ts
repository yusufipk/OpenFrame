import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { SharePermission } from '@prisma/client';
import { db } from '@/lib/db';
import { REPO_ROOT } from '../helpers/env';
import { test, expect } from './fixtures';

const SAMPLE_VIDEO = path.join(REPO_ROOT, 'tests', 'fixtures', 'live-review.mp4');
const VIDEO_PATH = '/api/upload/video/00000000-0000-4000-8000-000000000001.mp4';

async function routeMedia(page: Page): Promise<() => number> {
  let requests = 0;
  const media = await readFile(SAMPLE_VIDEO);
  await page.route(`**${VIDEO_PATH}`, async (route) => {
    requests += 1;
    const range = route
      .request()
      .headers()
      .range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
      await route.fulfill({
        status: 206,
        body: media.subarray(start, end + 1),
        contentType: 'video/mp4',
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${media.length}`,
          'Content-Length': String(end - start + 1),
        },
      });
    } else
      await route.fulfill({
        body: media,
        contentType: 'video/mp4',
        headers: { 'Accept-Ranges': 'bytes' },
      });
  });
  return () => requests;
}

async function waitForVideo(page: Page): Promise<void> {
  await expect(page.locator('video')).toBeVisible();
  await expect
    .poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(3);
}

async function videoTime(page: Page): Promise<number> {
  return page.locator('video').evaluate((video) => (video as HTMLVideoElement).currentTime);
}

async function rejectedFollowerPlayback(
  page: Page,
  videoId: string,
  versionId: string
): Promise<string> {
  return page.evaluate(
    async ({ videoId, versionId }) => {
      const response = await fetch(`/api/videos/${videoId}/live-review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'join', versionId, guestName: 'Guest Reviewer' }),
      });
      if (!response.ok) throw new Error(`Extra guest join returned ${response.status}`);
      const { data } = (await response.json()) as {
        data: { ticket: string; websocketUrl: string };
      };
      return new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(data.websocketUrl);
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error('No authority response from room'));
        }, 8_000);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', ticket: data.ticket }));
        socket.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('Room socket failed'));
        };
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            code?: string;
            snapshot?: { controlEpoch: number };
          };
          if (message.type === 'snapshot' && message.snapshot) {
            socket.send(
              JSON.stringify({
                type: 'playback',
                commandId: crypto.randomUUID(),
                controlEpoch: message.snapshot.controlEpoch,
                position: 1.8,
                playing: true,
                rate: 1,
              })
            );
          }
          if (message.type === 'error') {
            window.clearTimeout(timeout);
            socket.close();
            resolve(message.code ?? 'UNKNOWN');
          }
        };
      });
    },
    { videoId, versionId }
  );
}

test.setTimeout(180_000);

test('owner and guest review one native video through the real room service', async ({
  page,
  browser,
  seed,
  seededUser,
}, testInfo) => {
  const seeded = await seed.version(seededUser, { title: 'Live review test video' });
  await db.videoVersion.update({
    where: { id: seeded.versionId },
    data: {
      providerId: 'r2',
      videoId: `videos/${VIDEO_PATH.split('/').pop()}`,
      originalUrl: VIDEO_PATH,
      duration: 12,
      versionLabel: 'A long revision label that must never push the room button offscreen',
    },
  });
  const link = await seed.shareLink({ projectId: seeded.project.id, videoId: seeded.videoId });
  await db.shareLink.update({
    where: { id: link.id },
    data: { permission: SharePermission.COMMENT },
  });

  const ownerMediaRequests = await routeMedia(page);
  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  await waitForVideo(page);
  const room = page.getByRole('region', { name: 'Live review' });
  await expect(room).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start Live Review' })).toBeVisible();
  const startButton = page.getByRole('button', { name: 'Start Live Review' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .getByRole('button', { name: 'Close comments panel' })
        .evaluate(
          (element) => element.closest('.transition-transform')!.getBoundingClientRect().left
        )
    )
    .toBeGreaterThanOrEqual(389);
  await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
  await expect(startButton).toBeInViewport();
  const startBounds = await startButton.boundingBox();
  expect(startBounds!.x).toBeGreaterThanOrEqual(0);
  expect(startBounds!.x + startBounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/live-review-mobile-idle.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(startBounds!.height).toBeLessThanOrEqual(40);

  const guestContext = await browser.newContext({ storageState: undefined });
  await guestContext.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    Object.assign(window, { liveReviewTestSockets: sockets });
  });
  try {
    const guestPage = await guestContext.newPage();
    const guestMediaRequests = await routeMedia(guestPage);
    await guestPage.goto(`/watch/${seeded.videoId}?shareToken=${link.token}`);
    await expect(guestPage).toHaveURL(new RegExp(`/watch/${seeded.videoId}$`));
    await guestPage.getByPlaceholder('Your name').fill('Guest Reviewer');
    await guestPage.getByRole('button', { name: 'Continue' }).click();
    await waitForVideo(guestPage);
    const guestRoom = guestPage.getByRole('region', { name: 'Live review' });
    await expect(guestPage.getByRole('button', { name: 'Join Live Review' })).toHaveCount(0);
    await startButton.click();
    await expect(room.getByText('Connected', { exact: true })).toBeVisible();
    expect((await room.boundingBox())!.height).toBeLessThanOrEqual(48);
    await expect(guestPage.getByRole('button', { name: 'Join Live Review' })).toBeVisible({
      timeout: 5000,
    });
    await guestPage.getByRole('button', { name: 'Join Live Review' }).click();
    await expect(guestRoom.getByText('Connected', { exact: true })).toBeVisible();
    await expect(
      room.getByRole('button', { name: 'Room participants, 2', exact: true })
    ).toBeVisible();
    expect(ownerMediaRequests()).toBeGreaterThan(0);
    expect(guestMediaRequests()).toBeGreaterThan(0);

    const guestParticipants = guestRoom.getByRole('button', { name: /Room participants/ });
    await guestParticipants.focus();
    await guestPage.keyboard.press('ArrowDown');
    await expect(guestPage.getByRole('menuitem').first()).toBeFocused();
    await guestPage.keyboard.press('ArrowDown');
    await expect(guestPage.getByRole('menuitem').nth(1)).toBeFocused();
    await guestPage.keyboard.press('Escape');

    // A committed presenter seek reaches the follower. A follower timeline click
    // must not change the shared position.
    const ownerTimeline = page.locator('div.h-8.bg-muted.cursor-pointer');
    const timelineBox = await ownerTimeline.boundingBox();
    if (!timelineBox) throw new Error('Presenter timeline has no layout box.');
    await ownerTimeline.click({
      position: { x: timelineBox.width * 0.05, y: timelineBox.height / 2 },
    });
    await expect.poll(() => videoTime(guestPage)).toBeGreaterThan(0.35);
    await expect.poll(() => videoTime(guestPage)).toBeLessThan(1.1);
    const followedTime = await videoTime(page);
    await guestPage.keyboard.press('ArrowRight');
    await expect.poll(() => videoTime(page)).toBeLessThan(followedTime + 0.25);
    const stableRoom = await db.liveReviewSession.findFirstOrThrow({
      where: { videoId: seeded.videoId, status: 'active' },
    });
    expect(await rejectedFollowerPlayback(guestPage, seeded.videoId, seeded.versionId)).toBe(
      'NOT_PRESENTER'
    );
    const afterRejectedCommand = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: stableRoom.id },
    });
    expect(afterRejectedCommand.position).toBeCloseTo(stableRoom.position, 2);
    expect(afterRejectedCommand.playing).toBe(stableRoom.playing);

    await page.keyboard.press('Space');
    await expect
      .poll(() =>
        guestPage.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)
      )
      .toBe(false);
    const driftSamples: number[] = [];
    const initialPlaybackTimes = await Promise.all([videoTime(page), videoTime(guestPage)]);
    await expect
      .poll(
        async () => {
          const [ownerTime, followerTime] = await Promise.all([
            videoTime(page),
            videoTime(guestPage),
          ]);
          driftSamples.push(Math.abs(ownerTime - followerTime));
          return driftSamples.length;
        },
        { intervals: [250], timeout: 8000 }
      )
      .toBeGreaterThanOrEqual(20);
    const finalPlaybackTimes = await Promise.all([videoTime(page), videoTime(guestPage)]);
    expect(finalPlaybackTimes[0] - initialPlaybackTimes[0]).toBeGreaterThan(4);
    expect(finalPlaybackTimes[1] - initialPlaybackTimes[1]).toBeGreaterThan(4);
    const p95 = [...driftSamples].sort((a, b) => a - b)[Math.ceil(driftSamples.length * 0.95) - 1];
    expect(p95).toBeLessThanOrEqual(0.25);
    await testInfo.attach('playback-drift', {
      body: JSON.stringify({ p95Seconds: p95, samples: driftSamples }),
      contentType: 'application/json',
    });
    await expect
      .poll(async () => {
        const checkpoint = await db.liveReviewSession.findFirstOrThrow({
          where: { videoId: seeded.videoId, status: 'active' },
        });
        return checkpoint.playing && checkpoint.position > followedTime + 0.25;
      })
      .toBe(true);
    await page.keyboard.press('Space');
    await expect
      .poll(() =>
        guestPage.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)
      )
      .toBe(true);

    const strokeModeBounds = await page.getByRole('button', { name: 'Stroke Mode' }).boundingBox();
    const setInBounds = await page
      .getByRole('button', { name: 'Set In', exact: true })
      .boundingBox();
    expect(Math.abs(strokeModeBounds!.y - setInBounds!.y)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Stroke Mode' }).click();
    await page.getByRole('button', { name: /^Assets/ }).click();
    await expect(page.getByLabel('Shared drawing canvas')).toHaveClass(/pointer-events-none/);
    await page.getByRole('button', { name: /^Comments/ }).click();
    await expect(page.getByRole('button', { name: 'Stroke Mode' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await page.getByRole('button', { name: 'Stroke Mode' }).click();
    await expect(page.getByLabel('Live review drawing').getByRole('button')).toHaveCount(0);
    // The shared canvas is live while the pointer is still down.
    const ownerCanvas = page.getByLabel('Shared drawing canvas');
    const guestCanvas = guestPage.getByLabel('Shared drawing canvas');
    await expect(ownerCanvas).toBeVisible();
    const canvasBox = await ownerCanvas.boundingBox();
    if (!canvasBox) throw new Error('Drawing canvas has no layout box.');
    await page.mouse.move(
      canvasBox.x + canvasBox.width * 0.2,
      canvasBox.y + canvasBox.height * 0.2
    );
    await page.mouse.down();
    await page.mouse.move(
      canvasBox.x + canvasBox.width * 0.4,
      canvasBox.y + canvasBox.height * 0.4,
      { steps: 4 }
    );
    await expect.poll(() => guestCanvas.locator('path').count()).toBeGreaterThan(0);
    await page.mouse.up();
    await page.screenshot({ path: 'test-results/live-review-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: 'Close comments panel' })
          .evaluate(
            (element) => element.closest('.transition-transform')!.getBoundingClientRect().left
          )
      )
      .toBeGreaterThanOrEqual(389);
    await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
    await page.screenshot({ path: 'test-results/live-review-mobile.png' });
    await page.getByTitle('Show comments', { exact: true }).click();
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: 'Close comments panel' })
          .evaluate(
            (element) => element.closest('.transition-transform')!.getBoundingClientRect().right
          )
      )
      .toBeLessThanOrEqual(391);
    const mobileComposer = page.getByPlaceholder('Add a comment...');
    await expect(mobileComposer).toBeInViewport();
    await expect
      .poll(() =>
        mobileComposer.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element
          );
        })
      )
      .toBe(true);
    await page.screenshot({ path: 'test-results/live-review-mobile-comments.png' });
    await page.getByRole('button', { name: 'Close comments panel' }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'Save drawing as comment' }).click();
    await expect
      .poll(() =>
        db.comment.count({
          where: { versionId: seeded.versionId, annotationData: { not: null } },
        })
      )
      .toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByText('Annotated').first()).toBeVisible();
    // Rejoin beyond the former 15-second presenter disconnect timeout.
    await page.waitForTimeout(16000);
    await page.getByRole('button', { name: 'Join Live Review' }).click();
    await expect(room.getByText('Connected', { exact: true })).toBeVisible();

    const resumedRoom = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: stableRoom.id },
    });
    expect(resumedRoom.presenterId).toBe(stableRoom.presenterId);
    const resumedTime = await videoTime(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => videoTime(guestPage)).toBeGreaterThan(resumedTime + 0.5);

    // Control transfer changes who can issue commands. The former presenter
    // remains in the room as a follower.
    await room.getByRole('button', { name: /Room participants/ }).click();
    await page.getByRole('menuitem').filter({ hasText: 'Guest Reviewer' }).click();
    await expect(guestRoom.getByText('Presenter: Guest Reviewer', { exact: true })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    const beforeGuestSeek = await videoTime(guestPage);
    await expect.poll(() => videoTime(guestPage)).toBeLessThan(beforeGuestSeek + 0.25);
    // Close the real presenter connection and verify automatic reauthentication.
    const presenterBeforeReconnect = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: stableRoom.id },
    });
    const rejoinResponse = guestPage.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/videos/${seeded.videoId}/live-review`) &&
        response.request().method() === 'POST'
    );
    await guestPage.evaluate(() => {
      const sockets = (window as unknown as Window & { liveReviewTestSockets: WebSocket[] })
        .liveReviewTestSockets;
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
    });
    expect((await rejoinResponse).ok()).toBe(true);
    await expect(guestRoom.getByText('Connected', { exact: true })).toBeVisible();
    const reconnectedRoom = await db.liveReviewSession.findUniqueOrThrow({
      where: { id: stableRoom.id },
    });
    expect(reconnectedRoom.presenterId).toBe(presenterBeforeReconnect.presenterId);
    expect(reconnectedRoom.playing).toBe(false);
    await guestPage.keyboard.press('ArrowLeft');
    await expect.poll(() => videoTime(page)).toBeLessThan(beforeGuestSeek - 0.5);
    await room.getByRole('button', { name: 'End room' }).click();
    await expect(guestPage.getByRole('button', { name: 'Join Live Review' })).toHaveCount(0);
  } finally {
    await guestContext.close();
  }
});
