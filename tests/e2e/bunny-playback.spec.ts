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
import { test, expect, storageStateFor } from './fixtures';
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

type OriginalKind = 'short' | 'long' | 'audio-only' | 'undecodable' | 'huge' | 'forbidden';

const ORIGINAL_BODIES: Record<OriginalKind, { body: Buffer; contentType: string }> = {
  short: { body: SHORT_ORIGINAL, contentType: 'video/mp4' },
  long: { body: LONG_ORIGINAL, contentType: 'video/mp4' },
  'audio-only': { body: AUDIO_ONLY_ORIGINAL, contentType: 'video/mp4' },
  undecodable: { body: UNDECODABLE_ORIGINAL, contentType: 'video/quicktime' },
  // Playable, but its HEAD reports 2 GB: a short 4K ProRes source as Safari would see it.
  huge: { body: SHORT_ORIGINAL, contentType: 'video/mp4' },
  // Answered with 403, like a CDN token the pull zone no longer accepts.
  forbidden: { body: SHORT_ORIGINAL, contentType: 'video/mp4' },
};
const HUGE_ORIGINAL_BYTES = 2 * 1024 * 1024 * 1024;

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
    const method = route.request().method();
    // GETs are logged by path alone; the player's size check on the original is a HEAD.
    requests.push(method === 'GET' ? rest : `${method} ${rest}`);
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
      if (original === 'forbidden') {
        await route.fulfill({ status: 403, headers, body: '' });
        return;
      }
      if (method === 'HEAD') {
        const size = original === 'huge' ? HUGE_ORIGINAL_BYTES : body.length;
        await route.fulfill({
          status: 200,
          headers: { ...headers, 'content-length': String(size) },
          contentType,
        });
        return;
      }
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
  expect(requests).toContain('original');
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
    expect(requests).toContain('original');
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

test('a member who may not download gets the renditions, even with Original remembered', async ({
  browser,
  playwright,
  baseURL,
  seed,
  seededUser,
}) => {
  // The seeded project leaves allowDownloads off, so a commenter cannot download, and
  // the original as the <video> source would be one "Save video as" away from that.
  const seeded = await seed.bunnyVersion(seededUser, { duration: 2 });
  const member = await seed.user({ name: 'Commenting Member' });
  await seed.member(seeded.project.id, member.id, 'COMMENTATOR');

  const memberState = await storageStateFor(playwright.request, baseURL ?? '', member.email ?? '');
  const memberContext = await browser.newContext({ baseURL, storageState: memberState });
  try {
    const memberPage = await memberContext.newPage();
    // Original remembered from a project where this browser could download: it does not
    // carry over to one where it cannot.
    await memberPage.addInitScript(() => {
      window.localStorage.setItem('openframe:playback-quality', '{"mode":"original"}');
    });
    const requests = await serveBunnyCdn(memberPage, seeded.providerVideoId, 'short');

    await openVideo(memberPage, seeded.project.id, seeded.videoId);

    await expect.poll(() => firstSegmentRendition(requests)).toBe('1080p');
    expect(requests).not.toContain('original');
    await expect(qualityButton(memberPage)).toHaveText('Quality Auto');
  } finally {
    await memberContext.close();
  }
});

test('Auto leaves a short clip on the renditions when the original is too big', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.bunnyVersion(seededUser, { duration: 2 });
  const requests = await serveBunnyCdn(page, seeded.providerVideoId, 'huge');

  await openVideo(page, seeded.project.id, seeded.videoId);

  await expect.poll(() => firstSegmentRendition(requests)).toBe('1080p');
  expect(requests).toContain('HEAD original');
  expect(requests).not.toContain('original');
  await expect(qualityButton(page)).toHaveText('Quality Auto');
});

test('while Auto plays the original, the menu lists the renditions and one can be picked', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.bunnyVersion(seededUser, { duration: 2 });
  const requests = await serveBunnyCdn(page, seeded.providerVideoId, 'short');

  await openVideo(page, seeded.project.id, seeded.videoId);
  await expect(qualityButton(page)).toHaveText('Quality Auto (Original)');

  await qualityButton(page).click();
  await expect(page.getByRole('menuitem', { name: '1080p', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '720p', exact: true }).click();

  await expect.poll(() => firstSegmentRendition(requests)).toBe('720p');
  await expect(qualityButton(page)).toHaveText('Quality 720p');
  expect(await videoSource(page)).toMatch(/^blob:/);
});

test('saving the measured length of an unknown-length clip does not reload the player', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.bunnyVersion(seededUser, { duration: null });
  const requests = await serveBunnyCdn(page, seeded.providerVideoId, 'short');
  const durationSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().includes(`/versions/${seeded.versionId}`)
  );

  await openVideo(page, seeded.project.id, seeded.videoId);
  await expect(qualityButton(page)).toHaveText('Quality Auto (Original)');
  await durationSaved;

  // Give a rebuild the time it would need to show up as a second load.
  await page.waitForTimeout(1500);
  expect(requests.filter((request) => request === 'original')).toHaveLength(1);
  await expect(qualityButton(page)).toHaveText('Quality Auto (Original)');
});

test('a remembered Original that will not decode falls back once and says why', async ({
  page,
  seed,
  seededUser,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('openframe:playback-quality', '{"mode":"original"}');
  });
  const seeded = await seed.bunnyVersion(seededUser, { duration: 120 });
  const requests = await serveBunnyCdn(page, seeded.providerVideoId, 'undecodable');

  await openVideo(page, seeded.project.id, seeded.videoId);

  await expect.poll(() => firstSegmentRendition(requests)).toBe('1080p');
  await expect(page.getByText("This browser can't play the original file")).toHaveCount(1);
  // Hls.js renditions are listed again once the original is out of the picture.
  await expect(qualityButton(page)).toHaveText('Quality Auto');
});

test('a refused Original falls back without blaming the browser', async ({
  page,
  seed,
  seededUser,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('openframe:playback-quality', '{"mode":"original"}');
  });
  const seeded = await seed.bunnyVersion(seededUser, { duration: 120 });
  const requests = await serveBunnyCdn(page, seeded.providerVideoId, 'forbidden');

  await openVideo(page, seeded.project.id, seeded.videoId);

  await expect.poll(() => firstSegmentRendition(requests)).toBe('1080p');
  // A 403 before metadata carries the same media error code as an unplayable format;
  // the player asks the CDN, and a refusal is not the browser's fault.
  expect(requests).toContain('HEAD original');
  await expect(page.getByText("This browser can't play the original file")).toHaveCount(0);
});
