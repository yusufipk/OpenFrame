// Which source the review player opens a Bunny Stream version on, against a real
// <video> element, real hls.js and real Media Source Extensions.
//
// Nothing here talks to Bunny. playwright.config.ts points BUNNY_CDN_URL at a
// hostname nobody serves, and every request to it is answered below from
// tests/fixtures. The master playlist mirrors what Bunny returns for a 1080p
// upload, renditions out of height order included; all of them point at the
// same tiny 160x90 segments, because hls.js picks a level from the playlist's
// BANDWIDTH and RESOLUTION, not from the pixels.
//
// What the assertions read is the request log: which rendition's segments the
// browser fetched first, and whether it fetched /original at all.
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { REPO_ROOT } from '../helpers/env';

const CDN_ORIGIN = 'https://bunny-e2e.b-cdn.net';
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');
const HLS_DIR = path.join(FIXTURES, 'bunny-hls');

/** 2.0 seconds of H.264, the same file player.spec.ts uploads. */
const SHORT_ORIGINAL = fs.readFileSync(path.join(FIXTURES, 'sample.mp4'));
/** 30 seconds: over the 20 second limit for Auto to keep the original. */
const LONG_ORIGINAL = fs.readFileSync(path.join(HLS_DIR, 'long-original.mp4'));
/** A container that opens fine and has no picture, the way a ProRes .mov does in Chrome. */
const AUDIO_ONLY_ORIGINAL = fs.readFileSync(path.join(HLS_DIR, 'audio-only-original.mp4'));
/** Bytes no browser can demux at all. */
const UNDECODABLE_ORIGINAL = Buffer.from('this is not a video file '.repeat(64));

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=190804,RESOLUTION=640x360',
  '360p/video.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=300479,RESOLUTION=854x480',
  '480p/video.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=553633,RESOLUTION=1280x720',
  '720p/video.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=110426,RESOLUTION=426x240',
  '240p/video.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1295817,RESOLUTION=1920x1080',
  '1080p/video.m3u8',
  '',
].join('\n');

type OriginalKind = 'short' | 'long' | 'audio-only' | 'undecodable';

const ORIGINAL_BODIES: Record<OriginalKind, { body: Buffer; contentType: string }> = {
  short: { body: SHORT_ORIGINAL, contentType: 'video/mp4' },
  long: { body: LONG_ORIGINAL, contentType: 'video/mp4' },
  'audio-only': { body: AUDIO_ONLY_ORIGINAL, contentType: 'video/mp4' },
  undecodable: { body: UNDECODABLE_ORIGINAL, contentType: 'video/quicktime' },
};

/** Serves the fake CDN for one video and records every path the browser asked for. */
async function serveBunnyCdn(page: Page, providerVideoId: string, original: OriginalKind) {
  const requests: string[] = [];
  await page.route(`${CDN_ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const prefix = `/${providerVideoId}/`;
    if (!url.pathname.startsWith(prefix)) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    const rest = url.pathname.slice(prefix.length);
    requests.push(rest);
    const headers = { 'access-control-allow-origin': '*' };

    if (rest === 'playlist.m3u8') {
      await route.fulfill({
        status: 200,
        headers,
        contentType: 'application/vnd.apple.mpegurl',
        body: MASTER_PLAYLIST,
      });
      return;
    }
    if (rest === 'original') {
      const { body, contentType } = ORIGINAL_BODIES[original];
      await route.fulfill({ status: 200, headers, contentType, body });
      return;
    }
    const rendition = rest.match(/^\d+p\/(video\.m3u8|video\d+\.ts)$/);
    if (rendition) {
      const file = rendition[1];
      await route.fulfill({
        status: 200,
        headers,
        contentType: file.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl',
        // Stored as .mpegts so tsc does not read the segments as TypeScript.
        body: fs.readFileSync(path.join(HLS_DIR, file.replace(/\.ts$/, '.mpegts'))),
      });
      return;
    }
    // Thumbnails and anything else the page asks for: absent, like a fresh upload.
    await route.fulfill({ status: 404, headers, body: '' });
  });
  return requests;
}

const firstSegmentRendition = (requests: string[]) =>
  requests.find((request) => request.endsWith('.ts'))?.split('/')[0] ?? null;

function videoSource(page: Page) {
  return page.locator('video').evaluate((el) => (el as HTMLVideoElement).currentSrc);
}

async function openVideo(page: Page, projectId: string, videoId: string) {
  await page.goto(`/projects/${projectId}/videos/${videoId}`);
  await expect(page.locator('video')).toBeVisible();
}

const qualityButton = (page: Page) => page.getByRole('button', { name: /^Quality / });

test.setTimeout(90_000);

test('Auto opens a long cut on the top rendition, not the lowest', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.bunnyVersion(seededUser, { duration: 120 });
  const requests = await serveBunnyCdn(page, seeded.providerVideoId, 'short');

  await openVideo(page, seeded.project.id, seeded.videoId);

  await expect.poll(() => firstSegmentRendition(requests)).toBe('1080p');
  await expect(qualityButton(page)).toHaveText('Quality Auto');
  expect(requests).not.toContain('original');
  expect(await videoSource(page)).toMatch(/^blob:/);
});

test('Auto plays a short clip from the original upload', async ({ page, seed, seededUser }) => {
  const seeded = await seed.bunnyVersion(seededUser, { duration: 2 });
  const requests = await serveBunnyCdn(page, seeded.providerVideoId, 'short');

  await openVideo(page, seeded.project.id, seeded.videoId);

  await expect(qualityButton(page)).toHaveText('Quality Auto (Original)');
  expect(await videoSource(page)).toContain(`${CDN_ORIGIN}/${seeded.providerVideoId}/original`);
  expect(requests.some((request) => request.endsWith('.ts'))).toBe(false);
});

test('an unknown length is settled by the original, and a long one goes to the renditions', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.bunnyVersion(seededUser, { duration: null });
  const requests = await serveBunnyCdn(page, seeded.providerVideoId, 'long');

  await openVideo(page, seeded.project.id, seeded.videoId);

  await expect.poll(() => firstSegmentRendition(requests)).toBe('1080p');
  expect(requests[0]).toBe('original');
  await expect(qualityButton(page)).toHaveText('Quality Auto');
});

for (const original of ['undecodable', 'audio-only'] as const) {
  test(`a short clip whose original is ${original} falls back to the top rendition`, async ({
    page,
    seed,
    seededUser,
  }) => {
    const seeded = await seed.bunnyVersion(seededUser, { duration: 2 });
    const requests = await serveBunnyCdn(page, seeded.providerVideoId, original);

    await openVideo(page, seeded.project.id, seeded.videoId);

    await expect.poll(() => firstSegmentRendition(requests)).toBe('1080p');
    expect(requests[0]).toBe('original');
    await expect(qualityButton(page)).toHaveText('Quality Auto');
    await expect
      .poll(() => page.locator('video').evaluate((el) => (el as HTMLVideoElement).videoWidth))
      .toBeGreaterThan(0);
  });
}

test('a chosen rendition is remembered for the next video, and the hint shows only once', async ({
  page,
  seed,
  seededUser,
}) => {
  const first = await seed.bunnyVersion(seededUser, { duration: 120 });
  const firstRequests = await serveBunnyCdn(page, first.providerVideoId, 'short');

  await openVideo(page, first.project.id, first.videoId);
  await expect.poll(() => firstSegmentRendition(firstRequests)).toBe('1080p');

  const hint = page.getByRole('note').filter({ hasText: 'Playback quality' });
  await expect(hint).toBeVisible();

  // Opening the menu is what the hint points at, so it retires the hint.
  await qualityButton(page).click();
  await expect(hint).toBeHidden();
  await page.getByRole('menuitem', { name: '720p', exact: true }).click();
  await expect(qualityButton(page)).toHaveText('Quality 720p');

  const second = await seed.bunnyVersion(seededUser, { duration: 2 });
  await page.unroute(`${CDN_ORIGIN}/**`);
  const secondRequests = await serveBunnyCdn(page, second.providerVideoId, 'short');

  await openVideo(page, second.project.id, second.videoId);

  // A remembered rendition wins over Auto's short-clip original.
  await expect.poll(() => firstSegmentRendition(secondRequests)).toBe('720p');
  expect(secondRequests).not.toContain('original');
  await expect(qualityButton(page)).toHaveText('Quality 720p');
  await expect(hint).toBeHidden();
});

test('a remembered Original opens the next video on the original', async ({
  page,
  seed,
  seededUser,
}) => {
  const first = await seed.bunnyVersion(seededUser, { duration: 120 });
  await serveBunnyCdn(page, first.providerVideoId, 'short');
  await openVideo(page, first.project.id, first.videoId);

  await qualityButton(page).click();
  await page.getByRole('menuitem', { name: 'Original', exact: true }).click();
  await expect(qualityButton(page)).toHaveText('Quality Original');

  const second = await seed.bunnyVersion(seededUser, { duration: 120 });
  await page.unroute(`${CDN_ORIGIN}/**`);
  const secondRequests = await serveBunnyCdn(page, second.providerVideoId, 'short');
  await openVideo(page, second.project.id, second.videoId);

  await expect(qualityButton(page)).toHaveText('Quality Original');
  // The player appends a cache-busting retry parameter to every original load.
  await expect
    .poll(() => videoSource(page))
    .toContain(`${CDN_ORIGIN}/${second.providerVideoId}/original`);
  expect(secondRequests.some((request) => request.endsWith('.ts'))).toBe(false);
});
