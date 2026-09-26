import '../helpers/env';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { db } from '@/lib/db';
import { createComment } from '../factories';
import { REPO_ROOT } from '../helpers/env';
import { test, expect } from './fixtures';

// These tests use real object storage and API writes. Preview discussions must
// survive reloads without becoming comments on the parent video or another file.
test.setTimeout(120_000);

async function uploadedMedia() {
  const client = new S3Client({
    endpoint: process.env.R2_ENDPOINT ?? 'http://minio-test:9000',
    region: 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? 'openframe',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? 'openframe-test-secret',
    },
  });
  const bucket = process.env.R2_BUCKET_NAME ?? 'openframe-test';
  const png = await sharp({
    create: { width: 640, height: 360, channels: 3, background: '#356a82' },
  })
    .png()
    .toBuffer();
  const wav = Buffer.alloc(44 + 16000 * 70);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(16000 * 70, 40);
  const mp4 = await readFile(path.join(REPO_ROOT, 'tests/fixtures/sample.mp4'));
  const entries = [
    { key: `images/${randomUUID()}.png`, body: png, type: 'image/png', route: 'image' },
    {
      key: `images/${randomUUID()}.webp`,
      body: await sharp(png).webp().toBuffer(),
      type: 'image/webp',
      route: 'image',
    },
    { key: `voice/${randomUUID()}.wav`, body: wav, type: 'audio/wav', route: 'audio' },
    { key: `videos/${randomUUID()}.mp4`, body: mp4, type: 'video/mp4', route: 'video' },
    { key: `voice/${randomUUID()}.wav`, body: wav, type: 'audio/wav', route: 'audio' },
    { key: `images/${randomUUID()}.png`, body: png, type: 'image/png', route: 'image' },
  ];
  const cleanup = async () => {
    await Promise.allSettled(
      entries.map(({ key }) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })))
    );
    client.destroy();
  };
  const uploaded = await Promise.allSettled(
    entries.map(({ key, body, type }) =>
      client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: type }))
    )
  );
  if (uploaded.some((result) => result.status === 'rejected')) {
    await cleanup();
    throw new Error('Could not upload attachment preview fixtures');
  }
  return {
    urls: entries.map((entry) => `/api/upload/${entry.route}/${entry.key.split('/')[1]}`),
    videoKey: entries[3].key,
    cleanup,
  };
}

async function postFileComment(page: Page, content: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Comment on this file' }).fill(content);
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/attachment-comments')
  );
  await dialog.getByRole('button', { name: 'Post comment', exact: true }).click();
  expect((await saved).status()).toBe(201);
  await expect(dialog.getByText(content, { exact: true })).toBeVisible();
  expect(await db.attachmentComment.count({ where: { content } })).toBe(1);
}

async function drawImageAnnotation(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Annotate image', exact: true }).click();
  const canvas = dialog.locator('svg[aria-label="Annotation canvas"]');
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.75, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(canvas.locator('path')).toHaveCount(1);
  return (await canvas.locator('path').getAttribute('d'))!;
}

async function viewImageAnnotation(page: Page, expectedPath: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'View annotation', exact: true }).click();
  const canvas = dialog.locator('svg[aria-label="Annotation canvas"]');
  await expect(canvas.locator('path')).toHaveCount(1);
  await expect(canvas.locator('path')).toHaveAttribute('d', expectedPath);
  await expect
    .poll(async () => {
      const bounds = (await dialog.boundingBox())!;
      return bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize()!.width;
    })
    .toBe(true);
  const imageBounds = (await dialog.locator('img').boundingBox())!;
  const canvasBounds = (await canvas.boundingBox())!;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(canvasBounds[key]).toBeCloseTo(imageBounds[key], 0);
  }
}

async function seekPreviewMedia(page: Page, kind: 'audio' | 'video', time: number) {
  const media = page.getByRole('dialog').locator(kind);
  await expect
    .poll(() => media.evaluate((element: HTMLMediaElement) => element.readyState))
    .toBeGreaterThan(0);
  await media.evaluate((element: HTMLMediaElement, timestamp) => {
    element.pause();
    element.currentTime = timestamp;
  }, time);
  await expect
    .poll(() => media.evaluate((element: HTMLMediaElement) => element.currentTime))
    .toBeCloseTo(time, 2);
}

async function expectTimestamp(
  page: Page,
  content: string,
  kind: 'audio' | 'video',
  time: number,
  label: string
) {
  const row = await db.attachmentComment.findFirstOrThrow({ where: { content } });
  expect(row.timestamp).toBeCloseTo(time, 2);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: `Jump to ${label}`, exact: true }).click();
  await expect
    .poll(() => dialog.locator(kind).evaluate((element: HTMLMediaElement) => element.currentTime))
    .toBeCloseTo(time, 2);
}

async function closePreview(page: Page) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close preview', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('asset image, audio and video previews have independent persistent comments and counts', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  const media = await uploadedMedia();
  try {
    await db.videoVersion.update({
      where: { id: seeded.versionId },
      data: { providerId: 'r2', videoId: media.videoKey, originalUrl: media.urls[3], duration: 2 },
    });
    await db.videoAsset.createMany({
      data: [
        {
          videoId: seeded.videoId,
          kind: 'IMAGE',
          provider: 'R2_IMAGE',
          displayName: 'Screenshot proof',
          sourceUrl: media.urls[0],
          billedUserId: seededUser.id,
          uploadedByUserId: seededUser.id,
        },
        {
          videoId: seeded.videoId,
          kind: 'AUDIO',
          provider: 'R2_AUDIO',
          displayName: 'Audio proof',
          sourceUrl: media.urls[2],
          billedUserId: seededUser.id,
          uploadedByUserId: seededUser.id,
        },
        {
          videoId: seeded.videoId,
          kind: 'VIDEO',
          provider: 'R2_VIDEO',
          displayName: 'Video proof',
          sourceUrl: media.urls[3],
          billedUserId: seededUser.id,
          uploadedByUserId: seededUser.id,
        },
      ],
    });
    let liveDiscoveryRequests = 0;
    await page.route(`**/api/videos/${seeded.videoId}/live-review`, async (route) => {
      liveDiscoveryRequests += 1;
      await route.fulfill({
        json: { data: { enabled: true, available: true, canStart: true, session: null } },
      });
    });
    await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
    for (const width of [320, 402, 768, 1440]) {
      await page.setViewportSize({ width, height: 874 });
      for (const control of [
        page.getByRole('link', { name: 'Back', exact: true }),
        page.getByRole('button', { name: 'Start Live Review', exact: true }),
        page.getByTitle('Toggle frame step mode', { exact: true }),
        page.getByTitle('Fullscreen (F)', { exact: true }),
      ]) {
        await expect(control).toBeVisible();
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      const videoBounds = await page.locator('video').boundingBox();
      expect(videoBounds).not.toBeNull();
      expect(videoBounds!.width).toBeGreaterThan(0);
      expect(videoBounds!.x).toBeGreaterThanOrEqual(0);
      expect(videoBounds!.x + videoBounds!.width).toBeLessThanOrEqual(width);
    }
    expect(liveDiscoveryRequests).toBeGreaterThan(0);
    await page.getByRole('button', { name: /^Assets/ }).click();
    await page.getByRole('button', { name: 'View image', exact: true }).click();
    await expect(page.getByRole('dialog').locator('img')).toHaveJSProperty('naturalWidth', 640);
    const imageComment = `Crop the screenshot ${seeded.videoId}`;
    const imageDrawing = await drawImageAnnotation(page);
    await postFileComment(page, imageComment);
    const savedDrawing = await db.attachmentComment.findFirstOrThrow({
      where: { content: imageComment },
    });
    expect(JSON.parse(savedDrawing.annotationData!)).toHaveLength(1);
    await viewImageAnnotation(page, imageDrawing);
    await page.setViewportSize({ width: 402, height: 874 });
    await viewImageAnnotation(page, imageDrawing);
    await page.setViewportSize({ width: 1440, height: 874 });
    await closePreview(page);
    await expect(
      page.getByRole('button', { name: '1 comments on Screenshot proof', exact: true })
    ).toBeVisible();
    const imageCard = page.locator('[id^="asset-card-"]').filter({ hasText: 'Screenshot proof' });
    // Stress the same thumbnail/actions layout used by narrow review sidebars.
    await imageCard.evaluate((element) => {
      element.style.width = '280px';
    });
    await expect(imageCard.getByRole('button')).toHaveCount(5);
    expect(
      await imageCard.evaluate((element) => {
        const card = element.getBoundingClientRect();
        return [...element.querySelectorAll('button')].every((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.left >= card.left && bounds.right <= card.right;
        });
      })
    ).toBe(true);
    await imageCard.evaluate((element) => {
      element.style.removeProperty('width');
    });
    await page.getByRole('button', { name: 'Play recording', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(imageComment, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog').locator('audio')).toBeVisible();
    const audioComment = `Reduce the background noise ${seeded.videoId}`;
    await seekPreviewMedia(page, 'audio', 65.25);
    await page
      .getByRole('dialog')
      .getByRole('textbox', { name: 'Comment on this file' })
      .fill(audioComment);
    await seekPreviewMedia(page, 'audio', 10);
    await postFileComment(page, audioComment);
    await expectTimestamp(page, audioComment, 'audio', 65.25, '1:05');
    await closePreview(page);
    await page.getByRole('button', { name: 'Play video', exact: true }).click();
    await expect(page.getByRole('dialog').locator('video')).toBeVisible();
    await expect(page.getByRole('dialog').getByText(audioComment, { exact: true })).toHaveCount(0);
    await seekPreviewMedia(page, 'video', 1.25);
    await postFileComment(page, `Shorten this asset ${seeded.videoId}`);
    await seekPreviewMedia(page, 'video', 0);
    await expectTimestamp(page, `Shorten this asset ${seeded.videoId}`, 'video', 1.25, '0:01');
    await closePreview(page);
    expect(await db.comment.count({ where: { versionId: seeded.versionId } })).toBe(0);
    await page.reload();
    await page.getByRole('button', { name: /^Assets/ }).click();
    for (const [name, content] of [
      ['Audio proof', audioComment],
      ['Video proof', `Shorten this asset ${seeded.videoId}`],
    ]) {
      await page.getByRole('button', { name: `1 comments on ${name}`, exact: true }).click();
      await expect(page.getByRole('dialog').getByText(content, { exact: true })).toBeVisible();
      const kind = name === 'Audio proof' ? 'audio' : 'video';
      await seekPreviewMedia(page, kind, 0);
      await expectTimestamp(
        page,
        content,
        kind,
        name === 'Audio proof' ? 65.25 : 1.25,
        name === 'Audio proof' ? '1:05' : '0:01'
      );
      await expect(page.getByRole('dialog').getByText(imageComment, { exact: true })).toHaveCount(
        0
      );
      await closePreview(page);
    }
    await page.getByRole('button', { name: '1 comments on Screenshot proof', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(imageComment, { exact: true })).toBeVisible();
    const deleted = page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && r.url().includes('/attachment-comments/')
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete comment', exact: true })
      .click();
    expect((await deleted).ok()).toBe(true);
    expect(await db.attachmentComment.count({ where: { content: imageComment } })).toBe(0);
    await closePreview(page);
    await expect(
      page.getByRole('button', { name: '1 comments on Screenshot proof', exact: true })
    ).toHaveCount(0);
  } finally {
    await media.cleanup();
  }
});

test('comment images and voice previews isolate discussions and allow guest feedback through a share link', async ({
  page,
  browser,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  const media = await uploadedMedia();
  try {
    await db.videoVersion.update({
      where: { id: seeded.versionId },
      data: { providerId: 'r2', videoId: media.videoKey, originalUrl: media.urls[3], duration: 2 },
    });
    // Uploaded images are registered as assets before being attached to comments.
    await db.videoAsset.createMany({
      data: [0, 1, 5].map((index) => ({
        videoId: seeded.videoId,
        kind: 'IMAGE' as const,
        provider: 'R2_IMAGE' as const,
        displayName: `Reference ${index}`,
        sourceUrl: media.urls[index],
        billedUserId: seededUser.id,
        uploadedByUserId: seededUser.id,
      })),
    });
    const parent = await createComment({
      versionId: seeded.versionId,
      authorId: seededUser.id,
      content: 'Compare these references',
      imageUrls: media.urls.slice(0, 2),
      voiceUrl: media.urls[2],
      timestamp: 0,
    });
    await createComment({
      versionId: seeded.versionId,
      authorId: seededUser.id,
      parentId: parent.id,
      content: 'Reply references',
      imageUrls: [media.urls[5]],
      voiceUrl: media.urls[4],
      timestamp: 0,
    });
    await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
    const images = page.getByRole('button', { name: /^Open image preview(?: \d+)?$/ });
    await expect(images).toHaveCount(3);
    await images.nth(0).click();
    const first = `First reference only ${seeded.videoId}`;
    const referenceDrawing = await drawImageAnnotation(page);
    await postFileComment(page, first);
    await closePreview(page);
    await images.nth(1).click();
    await expect(page.getByRole('dialog').getByText(first, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog').locator('img')).toHaveJSProperty('naturalWidth', 640);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe(media.urls[1].split('/').pop());
    await closePreview(page);
    await page.getByRole('button', { name: 'Open voice preview', exact: true }).nth(0).click();
    await seekPreviewMedia(page, 'audio', 12.5);
    await postFileComment(page, `Voice reference ${seeded.videoId}`);
    await expectTimestamp(page, `Voice reference ${seeded.videoId}`, 'audio', 12.5, '0:12');
    await closePreview(page);
    await images.nth(2).click();
    await expect(page.getByRole('dialog').getByText(first, { exact: true })).toHaveCount(0);
    await postFileComment(page, `Reply image reference ${seeded.videoId}`);
    await closePreview(page);
    await page.getByRole('button', { name: 'Open voice preview', exact: true }).nth(1).click();
    await expect(
      page.getByRole('dialog').getByText(`Voice reference ${seeded.videoId}`, { exact: true })
    ).toHaveCount(0);
    await seekPreviewMedia(page, 'audio', 3.25);
    await postFileComment(page, `Reply voice reference ${seeded.videoId}`);
    await closePreview(page);
    await page.reload();
    await images.nth(0).click();
    await expect(page.getByRole('dialog').getByText(first, { exact: true })).toBeVisible();
    await viewImageAnnotation(page, referenceDrawing);
    await closePreview(page);
    await images.nth(2).click();
    await expect(
      page.getByRole('dialog').getByText(`Reply image reference ${seeded.videoId}`, { exact: true })
    ).toBeVisible();
    await expect(page.getByRole('dialog').getByText(first, { exact: true })).toHaveCount(0);
    await closePreview(page);
    await page.getByRole('button', { name: 'Open voice preview', exact: true }).nth(1).click();
    await expect(
      page.getByRole('dialog').getByText(`Reply voice reference ${seeded.videoId}`, { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('dialog').getByText(`Voice reference ${seeded.videoId}`, { exact: true })
    ).toHaveCount(0);
    await closePreview(page);
    const link = await seed.shareLink({ projectId: seeded.project.id, videoId: seeded.videoId });
    await db.shareLink.update({
      where: { id: link.id },
      data: { permission: 'COMMENT', allowGuests: true },
    });
    const guestContext = await browser.newContext({ storageState: undefined });
    try {
      const guest = await guestContext.newPage();
      await guest.goto(new URL(`/s/${link.token}`, page.url()).toString());
      await guest.getByPlaceholder('Your name').fill('Attachment guest');
      await guest.getByRole('button', { name: 'Continue', exact: true }).click();
      await guest
        .getByRole('button', { name: /^Open image preview(?: \d+)?$/ })
        .nth(1)
        .click();
      const guestContent = `Guest on second reference ${seeded.videoId}`;
      const guestDrawing = await drawImageAnnotation(guest);
      await postFileComment(guest, guestContent);
      const guestRow = await db.attachmentComment.findFirstOrThrow({
        where: { content: guestContent },
      });
      expect(guestRow.authorId).toBeNull();
      expect(guestRow.guestName).toBe('Attachment guest');
      await closePreview(guest);
      await guest.reload();
      await guest
        .getByRole('button', { name: /^Open image preview(?: \d+)?$/ })
        .nth(1)
        .click();
      await expect(
        guest.getByRole('dialog').getByText(guestContent, { exact: true })
      ).toBeVisible();
      await viewImageAnnotation(guest, guestDrawing);
      await expect(guest.getByRole('dialog').getByText(first, { exact: true })).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
    expect(await db.comment.count({ where: { versionId: seeded.versionId } })).toBe(2);
  } finally {
    await media.cleanup();
  }
});

test('YouTube asset comments use trusted iframe time and seek on replay', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  await db.videoAsset.create({
    data: {
      videoId: seeded.videoId,
      kind: 'VIDEO',
      provider: 'YOUTUBE',
      displayName: 'YouTube time proof',
      sourceUrl: 'https://www.youtube.com/watch?v=timestamp01',
      providerVideoId: 'timestamp01',
      billedUserId: seededUser.id,
      uploadedByUserId: seededUser.id,
    },
  });
  let frames = 0;
  await page.route('https://www.youtube.com/embed/timestamp01?*', async (route) => {
    frames += 1;
    // Exercise the real cross-origin message boundary without a remote video dependency.
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body data-time="42.5"><script>
      let currentTime = 42.5;
      window.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.event === 'command' && message.func === 'seekTo') {
          currentTime = message.args[0];
          document.body.dataset.time = String(currentTime);
        }
        if (message.event === 'listening' || message.event === 'command') {
          parent.postMessage(JSON.stringify({ event:'infoDelivery', info:{ currentTime } }), event.origin);
        }
      });
    </script></body>`,
    });
  });
  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  await page.getByRole('button', { name: /^Assets/ }).click();
  await page.getByRole('button', { name: 'Play video', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Remove timestamp' })).toHaveText('At 0:42');
  expect(frames).toBe(1);
  await dialog.locator('iframe').evaluate((iframe: HTMLIFrameElement) => {
    const data = JSON.stringify({ event: 'infoDelivery', info: { currentTime: 99 } });
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: 'https://evil.example',
        source: iframe.contentWindow,
      })
    );
    window.dispatchEvent(
      new MessageEvent('message', { data, origin: 'https://www.youtube.com', source: window })
    );
  });
  const content = `YouTube timing ${seeded.videoId}`;
  await postFileComment(page, content);
  expect((await db.attachmentComment.findFirstOrThrow({ where: { content } })).timestamp).toBe(
    42.5
  );
  await closePreview(page);
  await page.reload();
  await page.getByRole('button', { name: /^Assets/ }).click();
  await page.getByRole('button', { name: 'Play video', exact: true }).click();
  const frame = page.frameLocator('[role="dialog"] iframe');
  await frame.locator('body').evaluate((body) => {
    body.dataset.time = '0';
  });
  await page.getByRole('button', { name: 'Jump to 0:42', exact: true }).click();
  await expect(frame.locator('body')).toHaveAttribute('data-time', '42.5');
  expect(frames).toBe(2);
});
