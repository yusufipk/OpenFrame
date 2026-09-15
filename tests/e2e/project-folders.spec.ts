import { test, expect, storageStateFor } from './fixtures';
import { db } from '@/lib/db';

test('folder navigation and account invitation expose only the assigned area', async ({
  page,
  seed,
  seededUser,
  browser,
  playwright,
  baseURL,
}) => {
  const { project } = await seed.project(seededUser);
  const director = await seed.user();
  await page.goto(`/projects/${project.id}`);
  await page.getByLabel('Folder name').fill('Assigned area');
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('link', { name: 'Assigned area', exact: true }).click();
  await expect(page).toHaveURL(/folderId=/);
  const folder = await db.projectFolder.findFirstOrThrow({
    where: { projectId: project.id, name: 'Assigned area' },
  });
  await page.getByLabel('Folder name').fill('Offline');
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Offline', exact: true })).toBeVisible();
  const child = await db.projectFolder.findFirstOrThrow({ where: { parentId: folder.id } });
  await db.video.create({
    data: { projectId: project.id, folderId: child.id, title: 'Assigned cut' },
  });
  await db.video.create({ data: { projectId: project.id, title: 'Hidden sibling cut' } });
  await page.getByRole('button', { name: 'Manage access', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Restrict access', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm access change' }).click();
  await expect
    .poll(
      async () =>
        (await db.projectFolder.findUniqueOrThrow({ where: { id: folder.id } })).accessMode
    )
    .toBe('RESTRICTED');
  await dialog.getByLabel('Invitation email').fill(director.email!);
  await dialog.getByRole('button', { name: 'Create account invitation' }).click();
  const invitation = dialog.getByLabel('Invitation link');
  await expect(invitation).toBeVisible();
  const invitationUrl = await invitation.inputValue();
  const context = await browser.newContext({
    storageState: await storageStateFor(playwright.request, baseURL!, director.email!),
  });
  try {
    const assignedPage = await context.newPage();
    await assignedPage.goto(invitationUrl);
    await expect(assignedPage).toHaveURL(new RegExp(`folderId=${folder.id}`));
    await expect(assignedPage.getByRole('link', { name: 'Offline', exact: true })).toBeVisible();
    await expect(assignedPage.getByRole('link', { name: 'Project root', exact: true })).toHaveCount(
      0
    );
    await expect(
      assignedPage.getByRole('button', { name: 'Manage access', exact: true })
    ).toHaveCount(0);
    await assignedPage.getByRole('link', { name: 'Offline', exact: true }).click();
    await expect(assignedPage.getByText('Assigned cut', { exact: true })).toBeVisible();
    await expect(assignedPage.getByText('Hidden sibling cut', { exact: true })).toHaveCount(0);
    const rootResponse = await context.request.get(`${baseURL}/api/projects/${project.id}/videos`);
    expect(rootResponse.status()).toBe(403);
    await assignedPage.goto(`${baseURL}/shared`);
    await expect(assignedPage.getByRole('link', { name: /Assigned area/ })).toBeVisible();
    expect(
      await db.projectMember.count({ where: { projectId: project.id, userId: director.id } })
    ).toBe(0);
    expect(await db.workspaceMember.count({ where: { userId: director.id } })).toBe(0);
  } finally {
    await context.close();
  }
});
