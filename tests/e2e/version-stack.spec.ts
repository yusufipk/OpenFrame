// Dragging a file card onto another on the project page stacks it as the
// target's newest version. The assertions are on the database rows and on the
// card that disappears, not on the toast, which a handler can show and then do
// nothing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { db } from '@/lib/db';
import { createVersion, createVideo } from '../factories';
import { REPO_ROOT } from '../helpers/env';
import type { Locator, Page } from '@playwright/test';

const SAMPLE_VIDEO = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample.mp4');

function fileCard(page: Page, title: string) {
  return page
    .getByTestId('file-card')
    .filter({ has: page.getByRole('heading', { name: title, level: 3, exact: true }) });
}

/** Counts merge requests that carry a confirmation token, i.e. the ones that commit. */
function countCommits(page: Page) {
  const commits = { count: 0 };
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/versions/merge')) return;
    if (request.postDataJSON()?.confirmationToken) commits.count += 1;
  });
  return commits;
}

test('dragging a card onto another adds it as a new version and removes the dragged card', async ({
  page,
  seed,
  seededUser,
}) => {
  const { project } = await seed.project(seededUser);
  const original = await createVideo({ projectId: project.id, title: 'Original cut' });
  const originalVersion = await createVersion({
    videoParentId: original.id,
    providerId: 'youtube',
    providerVideoId: 'dQw4w9WgXcQ',
  });
  // Two cuts on the dragged file, so the card badge (a version count) and the
  // newest version number are different values and a mix-up between them shows.
  const newCut = await createVideo({ projectId: project.id, title: 'Second pass' });
  const draft = await createVersion({
    videoParentId: newCut.id,
    providerId: 'youtube',
    providerVideoId: 'dQw4w9WgXcQ',
    versionNumber: 1,
    isActive: false,
  });
  const final = await createVersion({
    videoParentId: newCut.id,
    providerId: 'youtube',
    providerVideoId: 'dQw4w9WgXcQ',
    versionNumber: 4,
  });
  const commits = countCommits(page);

  await page.goto(`/projects/${project.id}`);
  await expect(
    page.getByText('Drop a new cut onto a file, or drag one file onto another, to add a version.')
  ).toBeVisible();
  await fileCard(page, 'Second pass').dragTo(fileCard(page, 'Original cut'));

  const dialog = page.getByRole('alertdialog', {
    name: 'Add "Second pass" as a new version of "Original cut"?',
  });
  await expect(dialog).toBeVisible();
  // The description is the server's own confirmation text, so its arrival means
  // the preview request ran and handed back a token.
  await expect(dialog.getByText(/Its versions, comments and attachments move/)).toBeVisible();
  expect(await db.video.findUnique({ where: { id: newCut.id } })).not.toBeNull();

  await dialog.getByRole('button', { name: 'Add as version' }).click();

  await expect.poll(async () => db.video.findUnique({ where: { id: newCut.id } })).toBeNull();
  // Proves the request matcher used by the cancel test matches a real commit.
  expect(commits.count).toBe(1);
  const versions = await db.videoVersion.findMany({
    where: { videoParentId: original.id },
    orderBy: { versionNumber: 'asc' },
    select: { id: true, versionNumber: true, isActive: true },
  });
  expect(versions).toEqual([
    { id: originalVersion.id, versionNumber: 1, isActive: false },
    { id: draft.id, versionNumber: 2, isActive: false },
    { id: final.id, versionNumber: 3, isActive: true },
  ]);
  await expect(fileCard(page, 'Second pass')).toHaveCount(0);
  await expect(fileCard(page, 'Original cut').getByText('v3', { exact: true })).toBeVisible();
  // The optimistic badge must agree with what the server renders.
  await page.reload();
  await expect(fileCard(page, 'Original cut').getByText('v3', { exact: true })).toBeVisible();
});

test('cancelling the confirmation sends no commit and leaves both files as they were', async ({
  page,
  seed,
  seededUser,
}) => {
  const { project } = await seed.project(seededUser);
  const original = await createVideo({ projectId: project.id, title: 'Keep me' });
  await createVersion({ videoParentId: original.id, providerId: 'youtube' });
  const other = await createVideo({ projectId: project.id, title: 'Leave me' });
  const otherVersion = await createVersion({ videoParentId: other.id, providerId: 'youtube' });
  const commits = countCommits(page);

  await page.goto(`/projects/${project.id}`);
  await fileCard(page, 'Leave me').dragTo(fileCard(page, 'Keep me'));
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('button', { name: 'Add as version' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(dialog).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(commits.count).toBe(0);
  await expect(fileCard(page, 'Leave me')).toHaveCount(1);
  expect(
    (await db.videoVersion.findUniqueOrThrow({ where: { id: otherVersion.id } })).videoParentId
  ).toBe(other.id);
});

/**
 * Drops sample.mp4 on `target` the way a file dragged in from the desktop
 * arrives: a DataTransfer that carries a File and the `Files` type.
 */
async function dropSampleVideo(page: Page, target: Locator) {
  const bytes = [...readFileSync(SAMPLE_VIDEO)];
  const dataTransfer = await page.evaluateHandle((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], 'sample.mp4', { type: 'video/mp4' }));
    return transfer;
  }, bytes);
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
}

async function versionsOf(videoId: string) {
  return db.videoVersion.findMany({
    where: { videoParentId: videoId },
    orderBy: { versionNumber: 'asc' },
    select: { versionNumber: true, isActive: true, providerId: true },
  });
}

test.describe('new cuts from the desktop', () => {
  // A MinIO PUT and a cold `next build` route per upload.
  test.setTimeout(120_000);

  test('a file dropped on a card becomes its new version, not a new file', async ({
    page,
    seed,
    seededUser,
  }) => {
    const { project } = await seed.project(seededUser);
    const target = await createVideo({ projectId: project.id, title: 'Drop target' });
    await createVersion({ videoParentId: target.id, providerId: 'youtube' });
    const bystander = await createVideo({ projectId: project.id, title: 'Bystander' });
    await createVersion({ videoParentId: bystander.id, providerId: 'youtube' });

    await page.goto(`/projects/${project.id}`);
    await dropSampleVideo(page, fileCard(page, 'Drop target').getByRole('heading'));

    await expect
      .poll(() => versionsOf(target.id), { timeout: 90_000 })
      .toEqual([
        { versionNumber: 1, isActive: false, providerId: 'youtube' },
        { versionNumber: 2, isActive: true, providerId: 'r2' },
      ]);
    expect(await db.video.count({ where: { projectId: project.id } })).toBe(2);
    expect(await versionsOf(bystander.id)).toHaveLength(1);
    await expect(fileCard(page, 'Drop target').getByText('v2', { exact: true })).toBeVisible();
  });

  test('a file dropped between the cards still uploads as a new file', async ({
    page,
    seed,
    seededUser,
  }) => {
    const { project } = await seed.project(seededUser);
    const existing = await createVideo({ projectId: project.id, title: 'Existing' });
    await createVersion({ videoParentId: existing.id, providerId: 'youtube' });

    await page.goto(`/projects/${project.id}`);
    await dropSampleVideo(page, page.getByRole('heading', { name: 'Files' }));

    await expect
      .poll(() => db.video.count({ where: { projectId: project.id } }), { timeout: 90_000 })
      .toBe(2);
    expect(await versionsOf(existing.id)).toHaveLength(1);
  });

  test('the card menu adds a local file as a new version', async ({ page, seed, seededUser }) => {
    const { project } = await seed.project(seededUser);
    const target = await createVideo({ projectId: project.id, title: 'Menu target' });
    await createVersion({ videoParentId: target.id, providerId: 'youtube' });

    await page.goto(`/projects/${project.id}`);
    const card = fileCard(page, 'Menu target');
    await card.hover();
    await card.getByRole('button', { name: 'Actions for Menu target' }).click();
    await page.getByRole('menuitem', { name: 'Add Version' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Or upload a file').setInputFiles(SAMPLE_VIDEO);
    await dialog.getByRole('button', { name: 'Add Version 2' }).click();

    await expect(dialog).toHaveCount(0, { timeout: 90_000 });
    expect(await versionsOf(target.id)).toEqual([
      { versionNumber: 1, isActive: false, providerId: 'youtube' },
      { versionNumber: 2, isActive: true, providerId: 'r2' },
    ]);
  });

  test('a file dropped on the player becomes the new version of that file', async ({
    page,
    seed,
    seededUser,
  }) => {
    const { project } = await seed.project(seededUser);
    const video = await createVideo({ projectId: project.id, title: 'Watching this' });
    await createVersion({ videoParentId: video.id, providerId: 'youtube' });

    await page.goto(`/projects/${project.id}/videos/${video.id}`);
    await expect(page.getByRole('button', { name: 'New Version' })).toBeVisible();
    await dropSampleVideo(page, page.getByText('Watching this', { exact: true }).first());

    await expect
      .poll(() => versionsOf(video.id), { timeout: 90_000 })
      .toEqual([
        { versionNumber: 1, isActive: false, providerId: 'youtube' },
        { versionNumber: 2, isActive: true, providerId: 'r2' },
      ]);
    expect(await db.video.count({ where: { projectId: project.id } })).toBe(1);
  });
});
