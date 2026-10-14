// Dragging a file card onto another on the project page stacks it as the
// target's newest version. The assertions are on the database rows and on the
// card that disappears, not on the toast, which a handler can show and then do
// nothing.
import { test, expect } from './fixtures';
import { db } from '@/lib/db';
import { createVersion, createVideo } from '../factories';
import type { Page } from '@playwright/test';

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
    page.getByText('Drag a file onto another to add it as a new version.')
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
