// Player interaction against a real <video> element.
//
// The pure arithmetic behind these controls lives in
// components/video-page/hooks/video-player-utils.ts and is unit tested there.
// This spec deliberately covers only what a unit test cannot: that the numbers
// the hook computes are actually written to a media element, and that a
// keystroke on the document reaches that element. Every assertion below reads
// `HTMLVideoElement.currentTime` out of the browser, so a control that renders
// but is wired to nothing fails here.
//
// A real file has to be uploaded first. `<video>` is rendered only for the
// `bunny` and `r2` providers (components/video-page/player-core.tsx), and the
// seeded `youtube` versions every other spec uses render an iframe instead, so
// there is no media element to interrogate. The upload goes through the same
// form video-upload.spec.ts drives, against the MinIO service in
// docker-compose.test.yml.
//
// tests/fixtures/sample.mp4 is 2.0 seconds at 10 fps. Those two numbers are
// hardcoded in the expectations below on purpose: deriving them from the file
// at runtime would let a broken seek agree with a broken measurement.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { REPO_ROOT } from '../helpers/env';

const SAMPLE_VIDEO = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample.mp4');
const SAMPLE_DURATION_SECONDS = 2;

// One upload, three network round trips and a MinIO PUT before the first
// assertion.
test.setTimeout(120_000);

/** `video.currentTime` as the browser currently reports it. */
function currentTime(page: Page): Promise<number> {
  return page.locator('video').evaluate((el) => (el as HTMLVideoElement).currentTime);
}

/**
 * Uploads sample.mp4 into a fresh project and opens the video page.
 *
 * Returns nothing: everything the assertions need is read off the page.
 */
async function uploadAndOpen(page: Page, projectId: string, title: string): Promise<void> {
  await page.goto(`/projects/${projectId}/videos/new`);

  const directUploadTab = page.getByRole('tab', { name: 'Direct Upload' });
  await expect(directUploadTab).toBeVisible();
  await directUploadTab.click();

  await page.getByLabel('Files').setInputFiles(SAMPLE_VIDEO);
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Add Video', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`), { timeout: 90_000 });
  await page.getByRole('heading', { name: title, level: 3 }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/videos/[^/]+$`));
}

/** Waits until the media element has read its metadata, then checks it is ours. */
async function waitForMetadata(page: Page): Promise<void> {
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);

  const duration = await video.evaluate((el) => (el as HTMLVideoElement).duration);
  expect(duration).toBeGreaterThan(1.9);
  expect(duration).toBeLessThan(2.2);
}

test('the timeline, the arrow keys and frame mode all move the video element', async ({
  page,
  seed,
  seededUser,
}) => {
  const { project } = await seed.project(seededUser);
  await uploadAndOpen(page, project.id, `Player Video ${Date.now()}`);
  await waitForMetadata(page);

  expect(await currentTime(page)).toEqual(0);
  await expect(page.getByText(`0:00 / 0:0${SAMPLE_DURATION_SECONDS}`)).toBeVisible();

  // --- scrubbing ------------------------------------------------------------
  // The scrub bar carries no role, no label and no id, so it is located by the
  // class list it is built with in player-core.tsx. Reported rather than worked
  // around: a keyboard user cannot reach this control at all.
  const timeline = page.locator('div.h-8.bg-muted.cursor-pointer');
  await expect(timeline).toBeVisible();
  const box = await timeline.boundingBox();
  if (!box) throw new Error('The scrub bar has no layout box.');

  // Three quarters along a two second video is 1.5s. mousedown alone commits
  // the seek (handleTimelineMouseDown), so a plain click is enough.
  await timeline.click({ position: { x: box.width * 0.75, y: box.height / 2 } });
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1.2);
  await expect(page.getByText(`0:01 / 0:0${SAMPLE_DURATION_SECONDS}`)).toBeVisible();

  // --- keyboard -------------------------------------------------------------
  // ArrowLeft is 'skip-back' by five seconds, clamped at zero. Starting from
  // 1.5s means the clamp is the only thing that can produce this value, and it
  // cannot be the initial state because the scrub above moved off it.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => currentTime(page)).toEqual(0);

  // ArrowRight is 'skip-forward' by five, clamped at the duration.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1.9);

  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => currentTime(page)).toEqual(0);

  // --- frame mode -----------------------------------------------------------
  // No frame rate has been measured yet (that only happens during playback), so
  // one step is one second, and the button labels say so. The point of the
  // assertion is the *difference* from the 10s and 5s jumps above: a step that
  // lands on 1.0 could not have come from either.
  await expect(page.getByRole('button', { name: 'Forward 10s' })).toBeVisible();
  await page.getByRole('button', { name: /^Frame / }).click();
  const forwardOneStep = page.getByRole('button', { name: 'Forward 1s' });
  await expect(forwardOneStep).toBeVisible();

  await forwardOneStep.click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.9);
  expect(await currentTime(page)).toBeLessThan(1.2);

  await page.getByRole('button', { name: 'Back 1s' }).click();
  await expect.poll(() => currentTime(page)).toEqual(0);
});

test('the arrow keys are not hijacked while a comment is being typed', async ({
  page,
  seed,
  seededUser,
}) => {
  const { project } = await seed.project(seededUser);
  await uploadAndOpen(page, project.id, `Player Typing ${Date.now()}`);
  await waitForMetadata(page);

  const composer = page.getByPlaceholder('Add a comment...');
  await composer.fill('cursor keys belong to this box');
  await composer.click();
  // Put the caret in the middle so ArrowLeft has somewhere to go inside the
  // field; if the player claimed the key, the video would seek instead.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');

  expect(await currentTime(page)).toEqual(0);
  await expect(composer).toHaveValue('cursor keys belong to this box');
});
