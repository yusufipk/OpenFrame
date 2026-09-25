// The direct upload path, end to end: the browser presigns against the app,
// PUTs the bytes straight at MinIO, and the app finalises the version.
//
// This needs the `e2e` compose profile up (minio-test plus its bucket) and the
// R2_* variables from playwright.config.ts. Without them
// isDirectFileUploadEnabled() is false and the `Direct Upload` tab is not
// rendered at all, so the first assertion below fails loudly rather than
// silently testing nothing.
//
// Note on TESTING.md section 6: it says to upload "through the drag-drop
// uploader". The uploader on the dashboard and project pages
// (components/video-drag-drop-uploader.tsx) has no <input type="file"> at all,
// only window-level drop listeners, so setInputFiles cannot reach it. The real
// upload form is /projects/{id}/videos/new, which does have a file input, and
// that is what this spec drives.
import path from 'node:path';
import { test, expect } from './fixtures';
import { REPO_ROOT } from '../helpers/env';

const SAMPLE_VIDEO = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample.mp4');

// The upload is three network round trips plus a MinIO PUT, and `next build`
// output is cold on the first hit of each route.
test.setTimeout(120_000);

test('a video file is uploaded to object storage and a second version is added', async ({
  page,
  seed,
  seededUser,
}) => {
  const { project } = await seed.project(seededUser);
  const title = `Uploaded Video ${Date.now()}`;

  await page.goto(`/projects/${project.id}/videos/new`);
  // `CardTitle` renders a <div>, so the page is identified by its tab strip.
  await expect(page.getByRole('tab', { name: 'Paste URL' })).toBeVisible();

  // Present only when the app resolved a direct upload provider.
  const directUploadTab = page.getByRole('tab', { name: 'Direct Upload' });
  await expect(directUploadTab).toBeVisible();
  await directUploadTab.click();

  await page.getByLabel('Files').setInputFiles(SAMPLE_VIDEO);
  await expect(page.getByText('sample.mp4')).toBeVisible();

  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Add Video', exact: true }).click();

  // Back on the project page with the video listed. A failed presign or a
  // rejected PUT would leave us on the form with an error instead.
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`), { timeout: 90_000 });
  const videoHeading = page.getByRole('heading', { name: title, level: 3 });
  await expect(videoHeading).toBeVisible();

  // --- second version ------------------------------------------------------
  await videoHeading.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/videos/[^/]+$`));

  // One version so far, so there is nothing to compare against yet.
  await expect(page.getByText('v1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare' })).toHaveCount(0);

  await page.getByRole('button', { name: 'New Version' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Add New Version' })).toBeVisible();

  await dialog.getByRole('tab', { name: 'Upload File' }).click();
  await dialog.getByLabel('Video File').setInputFiles(SAMPLE_VIDEO);
  // Located by placeholder, not by label: the "Version Label (optional)" <Label>
  // in components/video-page/version-actions-dialog.tsx has no htmlFor and the
  // <Input> next to it has no id, so the two are not associated and there is no
  // accessible name to match. Another entry for the accessibility list.
  await dialog.getByPlaceholder('e.g. Final Cut, Review Round 2').fill('Round 2');
  await dialog.getByRole('button', { name: 'Add Version 2' }).click();

  // The new version becomes the active one, which is also what makes the
  // compare view reachable.
  await expect(page.getByText('v2', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Compare' })).toBeVisible();
});
