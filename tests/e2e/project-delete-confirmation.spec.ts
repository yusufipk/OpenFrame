// The typed-name step on project deletion is a per-user preference in /settings.
// Default on is covered by project-lifecycle.spec.ts; this spec turns it off,
// deletes a project with a plain confirmation, and turns it back on again.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

function preferenceToggle(page: Page) {
  // Anchored: the button's accessible name also carries its description.
  return page.getByRole('button', { name: /^Type the project name to delete/ });
}

async function setTypedNameConfirmation(page: Page, on: boolean) {
  await page.goto('/settings');
  const toggle = preferenceToggle(page);
  // Disabled until the stored preference has loaded.
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-pressed', String(!on));
  await toggle.click();
  await expect(page.getByText('Preference saved')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', String(on));

  // Stored on the server, not only in page state.
  await page.reload();
  await expect(preferenceToggle(page)).toBeEnabled();
  await expect(preferenceToggle(page)).toHaveAttribute('aria-pressed', String(on));
}

test('turning off the typed-name step lets a project be deleted with a plain confirmation', async ({
  page,
  seed,
  seededUser,
}) => {
  const { project } = await seed.project(seededUser);

  await setTypedNameConfirmation(page, false);

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: `Delete "${project.name}"?` })).toBeVisible();
  await expect(dialog.getByText('Typing the project name is turned off')).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);

  const confirm = dialog.getByRole('button', { name: 'Delete Project' });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText('Project Not Found')).toBeVisible();
});

test('turning the typed-name step back on requires the name again', async ({
  page,
  seed,
  seededUser,
}) => {
  const { project } = await seed.project(seededUser);

  await setTypedNameConfirmation(page, false);
  await setTypedNameConfirmation(page, true);

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  const dialog = page.getByRole('alertdialog');
  const confirm = dialog.getByRole('button', { name: 'Delete Project' });
  await expect(confirm).toBeDisabled();
  const nameInput = dialog.getByLabel(/Type .* to confirm/);
  await nameInput.fill(`${project.name} (wrong)`);
  await expect(confirm).toBeDisabled();
  await nameInput.fill(project.name);
  await expect(confirm).toBeEnabled();
});
