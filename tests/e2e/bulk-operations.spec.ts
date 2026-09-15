// Multi-select on the project page: deleting several videos at once, and moving
// several videos into another project in the same workspace.
//
// Both flows are behind a selection mode that is only reachable through a card's
// overflow menu, so the entry point is exercised here too. The assertions are
// deliberately about rows that disappear from one page and appear on another,
// not about the toast: a toast can be rendered by a handler that then does
// nothing.
import { test, expect } from './fixtures';
import { db } from '@/lib/db';
import { createProject, createVideo, createVersion } from '../factories';
import type { Page } from '@playwright/test';

/**
 * The overflow ("more") button on the card for `title`.
 *
 * That button is icon-only and has no accessible name, so it cannot be reached
 * by role and name. The <h3> title can, and the button is a sibling of the link
 * that wraps it: h3 -> link -> the flex row that holds both. See
 * components/video-card.tsx.
 */
function cardMenuFor(page: Page, title: string) {
  return page
    .getByRole('heading', { name: title, level: 3 })
    .locator('xpath=../..')
    .getByRole('button');
}

/** Puts the page into selection mode through the first card's overflow menu. */
async function enterSelectionMode(page: Page, anyTitle: string): Promise<void> {
  await cardMenuFor(page, anyTitle).click();
  await page.getByRole('menuitem', { name: 'Select' }).click();
  await expect(page.getByText('Selection mode')).toBeVisible();
}

/**
 * Three videos in one project, each with an active version.
 *
 * The provider is `youtube`, which needs no object storage: nothing here plays
 * a video, it only lists and deletes them.
 */
async function seedVideos(projectId: string, titles: string[]): Promise<void> {
  for (const title of titles) {
    const video = await createVideo({ projectId, title });
    await createVersion({
      videoParentId: video.id,
      providerId: 'youtube',
      providerVideoId: 'dQw4w9WgXcQ',
      title,
      duration: 120,
    });
  }
}

test('two of three videos are selected and deleted, and the third survives', async ({
  page,
  seed,
  seededUser,
}) => {
  const stamp = Date.now();
  const doomedA = `Bulk Doomed A ${stamp}`;
  const doomedB = `Bulk Doomed B ${stamp}`;
  const survivor = `Bulk Survivor ${stamp}`;

  const { project } = await seed.project(seededUser);
  await seedVideos(project.id, [doomedA, doomedB, survivor]);

  await page.goto(`/projects/${project.id}`);
  for (const title of [doomedA, doomedB, survivor]) {
    await expect(page.getByRole('heading', { name: title, level: 3 })).toBeVisible();
  }

  await enterSelectionMode(page, doomedA);

  // Nothing is selected by the act of entering the mode, so the destructive
  // button starts disabled. That is the control for the click below.
  const deleteSelected = page.getByRole('button', { name: 'Delete selected' });
  await expect(deleteSelected).toBeDisabled();

  await page.getByRole('checkbox', { name: `Select ${doomedA}` }).click();
  await page.getByRole('checkbox', { name: `Select ${doomedB}` }).click();
  await expect(page.getByText('2 selected')).toBeVisible();
  await expect(deleteSelected).toBeEnabled();

  await deleteSelected.click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Delete 2 videos?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete selected' }).click();

  await expect(page.getByRole('heading', { name: doomedA, level: 3 })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: doomedB, level: 3 })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: survivor, level: 3 })).toBeVisible();

  // Gone from the database, not just from the client-side list that
  // handleDeleteSelected filters. A reload re-renders from the server.
  await page.reload();
  await expect(page.getByRole('heading', { name: survivor, level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: doomedA, level: 3 })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: doomedB, level: 3 })).toHaveCount(0);
});

test('selected videos are moved into another project in the same workspace', async ({
  page,
  seed,
  seededUser,
}) => {
  const stamp = Date.now();
  const moving = `Bulk Moving ${stamp}`;
  const staying = `Bulk Staying ${stamp}`;

  // Both projects must share a workspace: the move dialog offers only
  // destinations inside it (app/api/projects/[projectId]/videos/move GET).
  const { project: source, workspaceId } = await seed.project(seededUser);
  const destination = await createProject({
    ownerId: seededUser.id,
    workspaceId,
    name: `Bulk Destination ${stamp}`,
    slug: `e2e-bulk-destination-${stamp}`,
  });
  await seedVideos(source.id, [moving, staying]);

  await page.goto(`/projects/${source.id}`);
  await enterSelectionMode(page, moving);
  await page.getByRole('checkbox', { name: `Select ${moving}` }).click();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Move videos' }).click();

  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Move video to another project' })
  ).toBeVisible();

  // The destination list is fetched when the dialog opens; the combobox does
  // not exist until it arrives.
  const destinationSelect = dialog.getByRole('combobox', { name: 'Destination project' });
  await expect(destinationSelect).toBeVisible();
  await destinationSelect.click();
  await page.getByRole('option', { name: destination.name }).click();
  // Serializable transactions may refuse a concurrent write with 409. Retry
  // only that explicit conflict, after proving that the source row survived.
  for (let attempt = 0; attempt < 3; attempt++) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/projects/${source.id}/videos/move`) &&
        response.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    const response = await responsePromise;
    expect((await db.video.findFirstOrThrow({ where: { title: moving } })).projectId).toBe(
      source.id
    );
    if (response.status() !== 409) {
      expect(response.status()).toBe(200);
      expect((await response.json()).data.needsConfirmation).toBe(true);
      break;
    }
    expect(attempt, 'Preview must eventually succeed').toBeLessThan(2);
    await expect(dialog.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
  }

  await expect(dialog.getByText(/Existing video links will be revoked/)).toBeVisible();
  expect((await db.video.findFirstOrThrow({ where: { title: moving } })).projectId).toBe(source.id);
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await db.video.findFirstOrThrow({ where: { title: moving } })).projectId)
    .toBe(destination.id);

  // Left the source...
  await page.reload();
  await expect(page.getByRole('heading', { name: moving, level: 3 })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: staying, level: 3 })).toBeVisible();

  // ...and arrived in the destination. Without both halves this passes for a
  // delete as readily as for a move.
  await page.goto(`/projects/${destination.id}`);
  await expect(page.getByRole('heading', { name: moving, level: 3 })).toBeVisible();
});
