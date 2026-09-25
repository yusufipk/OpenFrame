// What the user is shown when something fails: an upload that dies mid-flight,
// a mutation that comes back 500, and a page whose data never arrives.
//
// The failures are injected with `page.route`, which is the only honest way in:
// the server under test is a production build with no fault injection, and
// tearing down MinIO or Postgres mid-run would take the other workers with it.
//
// Every test here has a positive control. Asserting "an error message appeared"
// is worth nothing on its own, because a page that renders an error for every
// request would pass it; each test therefore also proves the same flow succeeds
// once the interception is removed, or that the data the failed request would
// have changed is still exactly as it was.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { createVideo, createVersion } from '../factories';
import { REPO_ROOT } from '../helpers/env';
import { db } from '@/lib/db';

const SAMPLE_VIDEO = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample.mp4');

/**
 * Every request to object storage, for `page.route`.
 *
 * Derived from R2_ENDPOINT rather than hardcoded, because the host differs by
 * environment and a pattern that matches nothing fails silently in the worst
 * possible way: the PUT succeeds, the upload works, and the test that claims to
 * inject a storage failure just waits for an error message that will never
 * come. That is exactly what happened on CI, where MinIO is published on
 * localhost, while locally it is the `minio-test` compose service.
 *
 * The fallback is the compose hostname, matching playwright.config.ts.
 */
const STORAGE_GLOB = `${process.env.R2_ENDPOINT ?? 'http://minio-test:9000'}/**`;

test.setTimeout(120_000);

/** A video with an active version, cheap enough to make several of. */
async function seedVideo(projectId: string, title: string): Promise<void> {
  const video = await createVideo({ projectId, title });
  await createVersion({
    videoParentId: video.id,
    providerId: 'youtube',
    providerVideoId: 'dQw4w9WgXcQ',
    title,
    duration: 120,
  });
}

/** Puts the project page into selection mode via the first card's menu. */
async function enterSelectionMode(page: Page, anyTitle: string): Promise<void> {
  await page
    .getByRole('heading', { name: anyTitle, level: 3 })
    .locator('xpath=../..')
    .getByRole('button')
    .click();
  await page.getByRole('menuitem', { name: 'Select' }).click();
  await expect(page.getByText('Selection mode')).toBeVisible();
}

test('an upload that fails at the storage PUT leaves the form up and creates nothing', async ({
  page,
  seed,
  seededUser,
}) => {
  const { project } = await seed.project(seededUser);

  // Only the bytes are refused. The presign (`r2-init`) and everything else the
  // app serves still work, so the failure is exactly the one this test claims:
  // object storage rejected the upload halfway through.
  let refusedPuts = 0;
  await page.route(STORAGE_GLOB, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    refusedPuts += 1;
    await route.fulfill({ status: 500, contentType: 'text/plain', body: 'storage is down' });
  });

  await page.goto(`/projects/${project.id}/videos/new`);
  await page.getByRole('tab', { name: 'Direct Upload' }).click();
  await page.getByLabel('Files').setInputFiles(SAMPLE_VIDEO);
  await page.getByLabel('Title').fill('Doomed Upload');
  await page.getByRole('button', { name: 'Add Video', exact: true }).click();

  // The status reaches the user rather than being flattened into "something
  // went wrong": lib/client/r2-video-upload.ts builds the message from the XHR
  // status and handleSubmit's outer catch renders `error.message` verbatim.
  // (A single file takes uploadSingleFileWithForm, which is why the message has
  // no `sample.mp4:` prefix; only the multi-file loop adds one.)
  await expect(page.getByText('Upload failed with status 500')).toBeVisible({
    timeout: 60_000,
  });

  // The interception really happened. Without this, a STORAGE_GLOB that matches
  // nothing turns this test into an assertion about an error message that some
  // unrelated failure happened to produce, and the diagnostic points at the
  // message rather than at the pattern.
  expect(refusedPuts, `no PUT to ${STORAGE_GLOB} was intercepted`).toBeGreaterThan(0);

  // Still on the form, so the file list and the title survive for a retry.
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/videos/new$`));
  await expect(page.getByLabel('Title')).toHaveValue('Doomed Upload');

  // Nothing half-created. A version row pointing at an object that was never
  // stored would be worse than the failure itself.
  await expect.poll(() => db.video.count({ where: { projectId: project.id } })).toEqual(0);

  // Positive control: with storage healthy the very same steps succeed, so the
  // assertions above are about the injected failure and not about the form
  // being broken.
  await page.unroute(STORAGE_GLOB);
  await page.getByRole('button', { name: 'Add Video', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`), { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Doomed Upload', level: 3 })).toBeVisible();
});

test('a bulk delete that comes back 500 says so and leaves every video in place', async ({
  page,
  seed,
  seededUser,
}) => {
  const stamp = Date.now();
  const first = `Recovery Keep A ${stamp}`;
  const second = `Recovery Keep B ${stamp}`;

  const { project } = await seed.project(seededUser);
  await seedVideo(project.id, first);
  await seedVideo(project.id, second);

  // A non-JSON body on purpose: it drives the client's own fallback message
  // rather than echoing a string this test supplied.
  let refusedDeletes = 0;
  await page.route('**/api/projects/*/videos/bulk-delete', (route) => {
    refusedDeletes += 1;
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
  });

  await page.goto(`/projects/${project.id}`);
  await enterSelectionMode(page, first);
  await page.getByRole('checkbox', { name: `Select ${first}` }).click();
  await page.getByRole('checkbox', { name: `Select ${second}` }).click();
  await expect(page.getByText('2 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Delete selected' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Delete selected' }).click();

  await expect(page.getByText('Failed to delete selected files')).toBeVisible();
  expect(refusedDeletes).toBe(1);

  // The dialog stays open so the failed action can be retried from where it
  // was. It has to be dismissed before the cards behind it can be asserted on:
  // Radix marks everything outside an open alertdialog aria-hidden, so a
  // heading behind it is not in the accessibility tree at all.
  await expect(dialog.getByRole('button', { name: 'Delete selected' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // The optimistic filter in handleDeleteSelected must not have run: both cards
  // are still on screen, and both rows are still in the database.
  await expect(page.getByRole('heading', { name: first, level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: second, level: 3 })).toBeVisible();
  expect(await db.video.count({ where: { projectId: project.id } })).toEqual(2);

  // Positive control: the same click succeeds once the route is released, which
  // proves the selection and the confirm dialog were driving a real request.
  await page.unroute('**/api/projects/*/videos/bulk-delete');
  await page.getByRole('button', { name: 'Delete selected' }).click();
  await dialog.getByRole('button', { name: 'Delete selected' }).click();

  await expect(page.getByText('2 videos deleted')).toBeVisible();
  await expect.poll(() => db.video.count({ where: { projectId: project.id } })).toEqual(0);
});

test('a video page whose data request 500s offers a way back instead of an empty player', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser, { title: `Recovery Video ${Date.now()}` });
  const videoRequest = /\/api\/projects\/[^/]+\/videos\/[^/?]+\?includeComments=false/;

  await page.route(videoRequest, (route) =>
    route.fulfill({ status: 500, contentType: 'text/plain', body: 'database unavailable' })
  );

  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);

  // The status is surfaced rather than swallowed into a generic spinner.
  await expect(page.getByText(/Failed to load video: 500/)).toBeVisible();
  await expect(page.getByPlaceholder('Add a comment...')).toHaveCount(0);

  // The escape hatch actually goes somewhere.
  await page.getByRole('link', { name: 'Back to Project' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${seeded.project.id}$`));

  // Positive control: without the interception the same URL renders the player
  // page, so the error state above was caused by the 500 and not by the video
  // being unreachable for some other reason.
  await page.unroute(videoRequest);
  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  await expect(page.getByPlaceholder('Add a comment...')).toBeVisible();
  await expect(page.getByText(/Failed to load video/)).toHaveCount(0);
});
