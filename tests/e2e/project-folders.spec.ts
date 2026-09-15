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
  const createDialog = page.getByRole('dialog', { name: 'Add folder', exact: true });
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('button', { name: 'Add Folder', exact: true }).click();
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('Folder name').fill('Assigned area');
  await createDialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(createDialog).toHaveCount(0);
  await expect(page.getByLabel('Folder name')).toHaveCount(0);
  await expect(page.getByText('This folder is empty', { exact: true })).toHaveCount(0);
  await expect(
    page.getByLabel('Project contents').getByRole('link', { name: 'Assigned area', exact: true })
  ).toBeVisible();
  await page.getByRole('link', { name: 'Assigned area', exact: true }).click();
  await expect(page).toHaveURL(/folderId=/);
  const folder = await db.projectFolder.findFirstOrThrow({
    where: { projectId: project.id, name: 'Assigned area' },
  });
  await page.getByRole('button', { name: 'Add Folder', exact: true }).click();
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('Folder name').fill('Offline');
  await createDialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(createDialog).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Offline', exact: true })).toBeVisible();
  const child = await db.projectFolder.findFirstOrThrow({ where: { parentId: folder.id } });
  await db.video.create({
    data: { projectId: project.id, folderId: child.id, title: 'Assigned cut' },
  });
  await db.video.create({ data: { projectId: project.id, title: 'Hidden sibling cut' } });
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Share folder: Assigned area', exact: true });
  await expect(dialog).toBeVisible();
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
    await expect(assignedPage.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
    await assignedPage.getByRole('link', { name: 'Offline', exact: true }).click();
    await expect(assignedPage.getByText('Assigned cut', { exact: true })).toBeVisible();
    await expect(assignedPage.getByText('Hidden sibling cut', { exact: true })).toHaveCount(0);
    const rootResponse = await context.request.get(`${baseURL}/api/projects/${project.id}/videos`);
    expect(rootResponse.status()).toBe(403);
    await assignedPage
      .getByRole('banner')
      .getByRole('link', { name: 'Shared with me', exact: true })
      .click();
    await expect(assignedPage).toHaveURL(`${baseURL}/shared`);
    await expect(assignedPage.getByRole('link', { name: /Assigned area/ })).toBeVisible();
    expect(
      await db.projectMember.count({ where: { projectId: project.id, userId: director.id } })
    ).toBe(0);
    expect(await db.workspaceMember.count({ where: { userId: director.id } })).toBe(0);
  } finally {
    await context.close();
  }
});

test('lists folders and videos together below the project header', async ({
  page,
  seed,
  seededUser,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const createDialog = page.getByRole('dialog', { name: 'Add folder', exact: true });
  const { project } = await seed.project(seededUser);
  const folder = await db.projectFolder.create({
    data: { projectId: project.id, name: 'Delivery folder' },
  });
  await db.video.create({ data: { projectId: project.id, title: 'Root cut' } });
  await page.goto(`/projects/${project.id}`);
  const contents = page.getByLabel('Project contents');
  await expect(contents.getByRole('link', { name: 'Delivery folder', exact: true })).toBeVisible();
  await expect(contents.getByRole('heading', { name: 'Root cut', exact: true })).toBeVisible();
  await expect(page.getByLabel('Folder name')).toHaveCount(0);
  await expect(page.getByText('No videos yet', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('banner').getByRole('link', { name: 'Shared with me', exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Folder breadcrumb' })
      .getByRole('link', { name: 'Shared with me' })
  ).toHaveCount(0);
  const folderCard = await contents
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Delivery folder', exact: true }) })
    .boundingBox();
  const videoCard = await contents
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Root cut', exact: true }) })
    .boundingBox();
  expect(folderCard).not.toBeNull();
  expect(videoCard).not.toBeNull();
  expect(Math.abs(folderCard!.y - videoCard!.y)).toBeLessThan(2);
  expect(videoCard!.x).toBeGreaterThan(folderCard!.x);
  expect(folderCard!.height).toBeLessThan(110);
  const membersResponse = page.waitForResponse((response) => {
    if (
      !response.url().endsWith(`/api/projects/${project.id}/folders`) ||
      response.request().method() !== 'POST'
    )
      return false;
    const body = response.request().postDataJSON();
    return body.action === 'members' && body.folderId === folder.id;
  });
  await contents.getByRole('button', { name: 'Share', exact: true }).click();
  expect((await membersResponse).status()).toBe(200);
  const shareDialog = page.getByRole('dialog', {
    name: 'Share folder: Delivery folder',
    exact: true,
  });
  await expect(shareDialog).toBeVisible();
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).click();
  const header = await page.getByRole('heading', { name: project.name, exact: true }).boundingBox();
  const grid = await contents.boundingBox();
  expect(header).not.toBeNull();
  expect(grid).not.toBeNull();
  expect(grid!.y).toBeGreaterThan(header!.y + header!.height);
  await contents.getByRole('link', { name: 'Delivery folder', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`folderId=${folder.id}`));
  await expect(page.getByText('This folder is empty', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add Folder', exact: true }).click();
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('Folder name').fill('Nested delivery');
  await createDialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(createDialog).toHaveCount(0);
  await expect(
    page.getByLabel('Project contents').getByRole('link', { name: 'Nested delivery', exact: true })
  ).toBeVisible();
  expect(
    await db.projectFolder.count({
      where: { projectId: project.id, parentId: folder.id, name: 'Nested delivery' },
    })
  ).toBe(1);
});
