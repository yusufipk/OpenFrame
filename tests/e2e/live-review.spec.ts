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
  let observePlainSelection = false;
  let plainSelectionCommand: { commentId: string; playing: boolean } | null = null;
  let acceptedPlainSelection = false;
  page.on('websocket', (socket) => {
    socket.on('framesent', (event) => {
      if (!observePlainSelection) return;
      const message = JSON.parse(String(event.payload));
      if (message.type === 'playback' && message.commentId) {
        plainSelectionCommand = { commentId: message.commentId, playing: message.playing };
      }
    });
    socket.on('framereceived', (event) => {
      if (!observePlainSelection || !plainSelectionCommand) return;
      const message = JSON.parse(String(event.payload));
      if (
        message.type === 'snapshot' &&
        message.snapshot.playback.position === 4 &&
        message.snapshot.playback.playing
      ) {
        acceptedPlainSelection = true;
      }
    });
  });
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
    await page.getByRole('button', { name: 'Drawing options' }).click();
    await page.getByRole('button', { name: 'Blue', exact: true }).click();
    await page.getByRole('button', { name: 'Increase stroke width' }).click();
    await page.getByRole('button', { name: 'Increase stroke width' }).click();
    await expect(page.getByLabel('Stroke width 5', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/live-review-drawing-options.png' });
    await page.keyboard.press('Escape');
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
    await expect(guestCanvas.locator('path').first()).toHaveAttribute('stroke', '#007AFF');
    await guestPage.getByRole('button', { name: 'Stroke Mode' }).click();
    const guestCanvasBox = await guestCanvas.boundingBox();
    if (!guestCanvasBox) throw new Error('Guest drawing canvas has no layout box.');
    await guestPage.mouse.move(
      guestCanvasBox.x + guestCanvasBox.width * 0.6,
      guestCanvasBox.y + guestCanvasBox.height * 0.2
    );
    await guestPage.mouse.down();
    await guestPage.mouse.move(
      guestCanvasBox.x + guestCanvasBox.width * 0.8,
      guestCanvasBox.y + guestCanvasBox.height * 0.4,
      { steps: 4 }
    );
    await guestPage.mouse.up();
    await expect(ownerCanvas.locator('path')).toHaveCount(2);
    await expect(ownerCanvas.locator('path').nth(1)).toHaveAttribute('stroke', '#FF3B30');
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
    const commentBody = 'Please adjust the blue marked area';
    await mobileComposer.fill(commentBody);
    await mobileComposer.press('Control+Enter');
    await expect
      .poll(() =>
        db.comment.findFirst({
          where: { versionId: seeded.versionId, content: commentBody },
          select: { annotationData: true },
        })
      )
      .toEqual({
        annotationData: expect.any(String),
      });
    const annotatedComment = await db.comment.findFirstOrThrow({
      where: { versionId: seeded.versionId, content: commentBody },
    });
    expect(JSON.parse(annotatedComment.annotationData!)).toEqual([
      expect.objectContaining({ color: '#007AFF', width: 5 }),
    ]);
    await page.getByRole('button', { name: 'Close comments panel' }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    const ownerStrokeMode = page.getByRole('button', { name: 'Stroke Mode' });
    if ((await ownerStrokeMode.getAttribute('aria-pressed')) !== 'true') {
      await ownerStrokeMode.click();
    }
    await expect(ownerCanvas).toHaveClass(/pointer-events-auto/);
    await expect
      .poll(() =>
        ownerCanvas.evaluate((canvas) => {
          const video = document.querySelector('video')!;
          const videoBox = video.getBoundingClientRect();
          const canvasBox = canvas.getBoundingClientRect();
          const scale = Math.min(
            videoBox.width / video.videoWidth,
            videoBox.height / video.videoHeight
          );
          const expectedWidth = video.videoWidth * scale;
          const expectedHeight = video.videoHeight * scale;
          return Math.max(
            Math.abs(canvasBox.width - expectedWidth),
            Math.abs(canvasBox.height - expectedHeight),
            Math.abs(canvasBox.left - (videoBox.left + (videoBox.width - expectedWidth) / 2)),
            Math.abs(canvasBox.top - (videoBox.top + (videoBox.height - expectedHeight) / 2))
          );
        })
      )
      .toBeLessThan(1);
    const nextCanvasBox = await ownerCanvas.boundingBox();
    if (!nextCanvasBox) throw new Error('Drawing canvas has no layout box after commenting.');
    await page.mouse.move(
      nextCanvasBox.x + nextCanvasBox.width * 0.2,
      nextCanvasBox.y + nextCanvasBox.height * 0.6
    );
    await page.mouse.down();
    await page.mouse.move(
      nextCanvasBox.x + nextCanvasBox.width * 0.4,
      nextCanvasBox.y + nextCanvasBox.height * 0.8,
      { steps: 4 }
    );
    await page.mouse.up();
    await expect(guestCanvas.locator('path')).toHaveCount(3);
    await page.getByRole('button', { name: 'Undo my stroke' }).click();
    await expect(guestCanvas.locator('path')).toHaveCount(2);
    await page.getByRole('button', { name: 'Save drawing as comment' }).click();
    await expect
      .poll(() =>
        db.comment.count({
          where: { versionId: seeded.versionId, content: null, annotationData: { not: null } },
        })
      )
      .toBe(1);
    const savedDrawing = await db.comment.findFirstOrThrow({
      where: { versionId: seeded.versionId, content: null, annotationData: { not: null } },
    });
    expect(JSON.parse(savedDrawing.annotationData!)).toEqual([
      expect.objectContaining({ color: '#007AFF', width: 5 }),
    ]);
    await db.comment.update({
      where: { id: annotatedComment.id },
      data: { timestamp: 0 },
    });
    const zeroTimestampComment = await db.comment.findUniqueOrThrow({
      where: { id: annotatedComment.id },
    });
    expect(zeroTimestampComment.timestamp).toBe(0);
    const plainMarker = await db.comment.create({
      data: {
        versionId: seeded.versionId,
        authorId: seededUser.id,
        timestamp: 4,
        content: 'Plain playback marker',
      },
    });
    await page.reload();
    await expect(page.getByText(commentBody)).toBeVisible();
    await expect(
      page
        .getByText(commentBody)
        .locator('xpath=ancestor::div[contains(@class, "group")][1]')
        .getByText('Annotated')
    ).toBeVisible();
    // Rejoin beyond the former 15-second presenter disconnect timeout.
    await page.waitForTimeout(16000);
    await page.getByRole('button', { name: 'Join Live Review' }).click();
    await expect(room.getByText('Connected', { exact: true })).toBeVisible();

    const savedComment = page
      .getByText(commentBody)
      .locator('xpath=ancestor::div[contains(@class, "group")][1]');
    const savedTimestamp = savedComment.getByTitle('Jump to this timestamp');
    await expect(savedTimestamp).toContainText('0:00');
    const ownerPreview = page.getByLabel('Shared annotation preview');
    const guestPreview = guestPage.getByLabel('Shared annotation preview');
    const savedStrokes = JSON.parse(zeroTimestampComment.annotationData!) as Array<{
      points: Array<{ x: number; y: number }>;
      color: string;
      width: number;
    }>;
    const expectedPaths = savedStrokes.map((stroke) => ({
      d: stroke.points
        .map((point, index) => `${index ? 'L' : 'M'} ${point.x * 1000} ${point.y * 1000}`)
        .join(' '),
      color: stroke.color,
      width: stroke.width,
    }));
    const previewPaths = (preview: typeof ownerPreview) =>
      preview.evaluate((svg) => {
        const width = svg.getBoundingClientRect().width;
        return [...svg.querySelectorAll('path')].map((path) => ({
          d: path.getAttribute('d'),
          color: path.getAttribute('stroke'),
          width:
            Math.round(Number(path.getAttribute('stroke-width')) * (1000 / width) * 1000) / 1000,
        }));
      });
    const expectSharedPreview = async () => {
      await expect(ownerPreview).toBeVisible();
      await expect(guestPreview).toBeVisible();
      await expect.poll(() => previewPaths(ownerPreview)).toEqual(expectedPaths);
      await expect.poll(() => previewPaths(guestPreview)).toEqual(expectedPaths);
    };
    const expectClearedPreview = async () => {
      await expect(ownerPreview).toHaveCount(0);
      await expect(guestPreview).toHaveCount(0);
    };
    const openSavedAnnotation = async () => {
      await savedTimestamp.click();
      await expect.poll(() => videoTime(page)).toBeLessThan(0.25);
      await expect.poll(() => videoTime(guestPage)).toBeLessThan(0.25);
      await expect
        .poll(() =>
          page.locator('video').evaluate((video) => ({
            paused: (video as HTMLVideoElement).paused,
            seeking: (video as HTMLVideoElement).seeking,
          }))
        )
        .toEqual({ paused: true, seeking: false });
      await expect
        .poll(() =>
          guestPage.locator('video').evaluate((video) => ({
            paused: (video as HTMLVideoElement).paused,
            seeking: (video as HTMLVideoElement).seeking,
          }))
        )
        .toEqual({ paused: true, seeking: false });
      await expectSharedPreview();
    };

    await openSavedAnnotation();
    await page.keyboard.press('Space');
    await expect
      .poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused))
      .toBe(false);
    await expectClearedPreview();
    await expect
      .poll(() =>
        guestPage.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)
      )
      .toBe(false);
    observePlainSelection = true;
    await page.getByTitle('0:04 - Plain playback marker...', { exact: true }).click();
    await expect
      .poll(() => plainSelectionCommand)
      .toEqual({ commentId: plainMarker.id, playing: true });
    await expect.poll(() => acceptedPlainSelection).toBe(true);
    await expect.poll(() => videoTime(guestPage)).toBeGreaterThanOrEqual(4);
    observePlainSelection = false;
    // A native waiting event may pause the room after the accepted playing seek.
    // Selecting the next annotation must pause and align both peers in either case.

    await openSavedAnnotation();
    const previewTime = await videoTime(page);
    await page.keyboard.press('ArrowRight');
    await expectClearedPreview();
    await expect.poll(() => videoTime(guestPage)).toBeGreaterThan(previewTime + 0.5);

    await openSavedAnnotation();
    await page.getByTitle('Back 10s').locator('xpath=preceding-sibling::button[1]').click();
    await expect
      .poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused))
      .toBe(false);
    await expectClearedPreview();
    await expect
      .poll(() =>
        guestPage.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)
      )
      .toBe(false);
    await page.keyboard.press('Space');
    await expect
      .poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).paused))
      .toBe(true);
    await expect
      .poll(() =>
        guestPage.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)
      )
      .toBe(true);

    await openSavedAnnotation();
    const resumedTimeline = page.locator('div.h-8.bg-muted.cursor-pointer');
    const resumedTimelineBox = await resumedTimeline.boundingBox();
    if (!resumedTimelineBox) throw new Error('Presenter timeline has no layout box after rejoin.');
    await resumedTimeline.click({
      position: { x: resumedTimelineBox.width * 0.1, y: resumedTimelineBox.height / 2 },
    });
    await expectClearedPreview();

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
