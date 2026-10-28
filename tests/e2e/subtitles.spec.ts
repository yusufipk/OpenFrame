// Subtitle layout against a real <video> and a real WebVTT track.
//
// How a cue is split into lines is unit tested in
// tests/unit/lib/subtitle-line-breaks.test.ts. This spec covers what a unit
// test cannot: that an uploaded file reaches the browser's own track, that the
// cue the browser holds is the one rewritten into short lines, and that the
// default size is the small one. Like player.spec.ts it uploads sample.mp4,
// because only the `bunny` and `r2` providers render a <video>.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { REPO_ROOT } from '../helpers/env';

const SAMPLE_VIDEO = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample.mp4');

const BALANCED_CUE =
  'test. A test is a small program\nthat automatically checks whether\nthe code works correctly.';
const LONG_CUE =
  'test. A test is a small program that automatically checks whether the code works correctly.';
const SUBTITLE_FILE = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${LONG_CUE}\n`;

// One video upload and one subtitle upload before the first assertion.
test.setTimeout(120_000);

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

/** The text of every cue on the track that is showing, as the browser holds it. */
function showingCueTexts(page: Page): Promise<string[] | null> {
  return page.locator('video').evaluate((el) => {
    const tracks = (el as HTMLVideoElement).textTracks;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (track.mode !== 'showing' || !track.cues) continue;
      return Array.from(track.cues, (cue) => (cue as VTTCue).text);
    }
    return null;
  });
}

test('an uploaded long cue shows as short lines, at the small size by default', async ({
  page,
  seed,
  seededUser,
}, testInfo) => {
  const { project } = await seed.project(seededUser);
  await uploadAndOpen(page, project.id, `Subtitle Video ${Date.now()}`);
  const video = page.locator('video');
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);

  await page.locator('input[type="file"][accept*=".vtt"]').setInputFiles({
    name: 'long.vtt',
    mimeType: 'text/vtt',
    buffer: Buffer.from(SUBTITLE_FILE),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // An upload selects its own track, so the cue loads without opening the menu.
  await expect.poll(() => showingCueTexts(page), { timeout: 30_000 }).toEqual([BALANCED_CUE]);

  // The cue rule only applies while the element carries this attribute.
  await expect(video).toHaveAttribute('data-subtitle-scaled', '');

  // Small is three quarters of Medium. Comparing the two keeps the picture-height arithmetic,
  // which is unit tested in tests/unit/subtitle-appearance.test.ts, out of this spec.
  const cueFontSize = () =>
    video.evaluate((el) =>
      Number.parseFloat((el as HTMLVideoElement).style.getPropertyValue('--subtitle-font-size'))
    );
  await expect.poll(cueFontSize).toBeGreaterThan(0);
  const smallSize = await cueFontSize();

  await page.getByTitle('Subtitles (C)').click();
  await page.getByRole('menuitem', { name: /^Size/ }).click();
  await page.getByRole('menuitem', { name: 'Medium', exact: true }).click();
  // Both sizes are rounded to a tenth of a pixel, so the ratio is close to 4/3, not exact.
  await expect.poll(async () => (await cueFontSize()) / smallSize).toBeCloseTo(4 / 3, 1);

  // Midway through the cue the browser has it active, with the broken lines.
  await video.evaluate((el) => {
    const media = el as HTMLVideoElement;
    media.pause();
    media.currentTime = 1;
  });
  await expect
    .poll(() =>
      video.evaluate((el) => {
        const tracks = (el as HTMLVideoElement).textTracks;
        for (let index = 0; index < tracks.length; index += 1) {
          const active = tracks[index].activeCues;
          if (tracks[index].mode === 'showing' && active) {
            return Array.from(active, (cue) => (cue as VTTCue).text);
          }
        }
        return null;
      })
    )
    .toEqual([BALANCED_CUE]);
  // Left in the test output for a person to look at; the assertions above are the check.
  await page.screenshot({ path: testInfo.outputPath('subtitles.png') });
});
