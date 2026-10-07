import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { db } from '@/lib/db';

const firstEmail = 'first.reviewer@production-review.example.com';
const secondEmail = 'second.reviewer@production-review.example.com';
const fallbackEmail = 'backup.reviewer@production-review.example.com';

async function capture(page: Page, name: string, fullPage = false) {
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await test.info().attach(name, {
    body: await page.screenshot({ fullPage, animations: 'disabled' }),
    contentType: 'image/png',
  });
}

async function expectNoHorizontalOverflow(container: Locator) {
  expect(await container.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true
  );
}

async function expectAlignedBelow(email: Locator, role: Locator, submit: Locator) {
  const emailBox = await email.boundingBox();
  const roleBox = await role.boundingBox();
  const submitBox = await submit.boundingBox();
  expect(emailBox).not.toBeNull();
  expect(roleBox).not.toBeNull();
  expect(submitBox).not.toBeNull();
  expect(roleBox!.y).toBeGreaterThan(emailBox!.y + emailBox!.height);
  expect(Math.abs(roleBox!.y - submitBox!.y)).toBeLessThan(2);
  expect(Math.abs(roleBox!.height - submitBox!.height)).toBeLessThan(2);
  expect(submitBox!.x).toBeGreaterThanOrEqual(roleBox!.x + roleBox!.width);
}

async function expectFullWidth(field: Locator, container: Locator) {
  const fieldBox = await field.boundingBox();
  const containerBox = await container.boundingBox();
  expect(fieldBox).not.toBeNull();
  expect(containerBox).not.toBeNull();
  expect(Math.abs(fieldBox!.width - containerBox!.width)).toBeLessThan(2);
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 360, height: 800 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const scope of ['project', 'workspace'] as const) {
      test(`${scope} invitation controls and pending links remain usable`, async ({
        page,
        context,
        seed,
        seededUser,
      }) => {
        const { project, workspaceId } = await seed.project(seededUser);
        const id = scope === 'project' ? project.id : workspaceId;
        const endpoint = `/api/${scope}s/${id}/members`;
        await page.goto(`/${scope}s/${id}/members`);
        const email = page.getByLabel('Email Addresses', { exact: true });
        const form = page.locator('form').filter({ has: email });
        const role = form.getByRole('combobox');
        const submit = form.getByRole('button', { name: 'Invite', exact: true });
        await expect(email).toBeVisible();
        await capture(page, `${scope}-${viewport.name}-form`, true);
        await expectAlignedBelow(email, role, submit);
        await expectFullWidth(email, form);
        await expectNoHorizontalOverflow(page.locator('html'));
        await email.fill(`${firstEmail},\n${secondEmail}`);
        await expectAlignedBelow(email, role, submit);
        await role.click();
        await expect(page.getByRole('option', { name: 'Admin', exact: true })).toBeInViewport();
        await capture(page, `${scope}-${viewport.name}-role`);
        await page.getByRole('option', { name: 'Commentator', exact: true }).click();
        await submit.click();
        await expect(submit).toBeEnabled();
        const firstLink = page.getByLabel(`Invitation link for ${firstEmail}`, { exact: true });
        const secondLink = page.getByLabel(`Invitation link for ${secondEmail}`, { exact: true });
        await expect(firstLink).toBeVisible();
        await expect(secondLink).toBeVisible();
        const firstUrl = await firstLink.inputValue();
        const row = firstLink.locator('xpath=ancestor::div[2]');
        await expectNoHorizontalOverflow(row);
        await expect(row.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: 'Resend', exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
        const actionBoxes = await Promise.all(
          ['Copy link', 'Resend', 'Cancel'].map((name) =>
            row.getByRole('button', { name, exact: true }).boundingBox()
          )
        );
        for (const box of actionBoxes) {
          expect(box).not.toBeNull();
          expect(Math.abs(box!.y - actionBoxes[0]!.y)).toBeLessThan(2);
        }
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await row.getByRole('button', { name: 'Copy link', exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(firstUrl);
        await row.getByRole('button', { name: 'Resend', exact: true }).click();
        await expect(submit).toBeEnabled();
        await expect(firstLink).toHaveValue(firstUrl);
        expect(
          await db.invitation.count({
            where: {
              email: firstEmail,
              status: 'PENDING',
              ...(scope === 'project' ? { projectId: id } : { workspaceId: id }),
            },
          })
        ).toBe(1);
        await expectNoHorizontalOverflow(page.locator('html'));
        await capture(page, `${scope}-${viewport.name}-pending`, true);

        // Refuse the list refresh after a real invite to expose the returned-link fallback.
        let refusedRefreshes = 0;
        await page.route(`**${endpoint}`, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          refusedRefreshes++;
          await route.fulfill({ status: 503, json: { error: 'Temporary test failure' } });
        });
        await email.fill(fallbackEmail);
        await submit.click();
        const fallbackLink = page.getByLabel(`Invitation link for ${fallbackEmail}`, {
          exact: true,
        });
        await expect(fallbackLink).toBeVisible();
        await expect.poll(() => refusedRefreshes).toBeGreaterThan(0);
        await expectNoHorizontalOverflow(page.locator('html'));
        await capture(page, `${scope}-${viewport.name}-refresh-fallback`, true);
      });
    }

    for (const scope of ['folder', 'video'] as const) {
      test(`${scope} invitation dialog keeps roles and row actions reachable`, async ({
        page,
        context,
        seed,
        seededUser,
      }) => {
        const { project } = await seed.project(seededUser);
        const endpoint = `/api/projects/${project.id}/folders`;
        if (scope === 'folder') {
          const folder = await db.projectFolder.create({
            data: { projectId: project.id, name: 'Client review folder' },
          });
          await page.goto(`/projects/${project.id}?folderId=${folder.id}`);
          await page
            .getByRole('group', { name: 'Project actions' })
            .getByRole('button', { name: 'Members', exact: true })
            .click();
        } else {
          const video = await db.video.create({
            data: { projectId: project.id, title: 'Client review video' },
          });
          await page.goto(`/projects/${project.id}/videos/${video.id}/share`);
          await page.getByRole('button', { name: 'Members', exact: true }).click();
        }
        const dialog = page.getByRole('dialog');
        const email = dialog.getByLabel('Invitation email', { exact: true });
        const role = dialog.getByRole('combobox', { name: 'Invitation role', exact: true });
        const submit = dialog.getByRole('button', { name: 'Send invitations', exact: true });
        await expect(email).toBeVisible();
        await expect(submit).toBeEnabled();
        await expect(submit).toBeInViewport();
        await expectNoHorizontalOverflow(dialog);
        await capture(page, `${scope}-${viewport.name}-form`);
        await email.fill(`${firstEmail},\n${secondEmail}`);
        await role.click();
        await expect(
          page.getByRole('option', { name: 'Admin: manage this area', exact: true })
        ).toBeInViewport();
        await capture(page, `${scope}-${viewport.name}-role`);
        await page
          .getByRole('option', { name: 'Commentator: view and comment', exact: true })
          .click();
        await submit.click();
        await expect(submit).toBeEnabled();
        const firstLink = dialog.getByLabel(`Invitation link for ${firstEmail}`, { exact: true });
        await expect(firstLink).toBeVisible();
        await expect(
          dialog.getByLabel(`Invitation link for ${secondEmail}`, { exact: true })
        ).toBeVisible();
        const firstUrl = await firstLink.inputValue();
        const row = firstLink.locator('..');
        await row.scrollIntoViewIfNeeded();
        await expectNoHorizontalOverflow(dialog);
        await expectNoHorizontalOverflow(row);
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await row.getByRole('button', { name: 'Copy link', exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(firstUrl);
        await row.getByRole('button', { name: 'Resend', exact: true }).click();
        await expect(submit).toBeEnabled();
        await expect(firstLink).toHaveValue(firstUrl);
        await row.scrollIntoViewIfNeeded();
        await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
        await capture(page, `${scope}-${viewport.name}-pending`);
        const secondRow = dialog
          .getByLabel(`Invitation link for ${secondEmail}`, { exact: true })
          .locator('..');
        await secondRow
          .getByRole('button', { name: 'Cancel', exact: true })
          .scrollIntoViewIfNeeded();
        await expect(
          secondRow.getByRole('button', { name: 'Cancel', exact: true })
        ).toBeInViewport();
        await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
        await capture(page, `${scope}-${viewport.name}-last-row`);

        let refusedRefreshes = 0;
        await page.route(`**${endpoint}`, async (route) => {
          if (route.request().postDataJSON()?.action !== 'members') return route.continue();
          refusedRefreshes++;
          await route.fulfill({ status: 503, json: { error: 'Temporary test failure' } });
        });
        await email.fill(fallbackEmail);
        await submit.click();
        const fallbackLink = dialog.getByLabel(`Invitation link for ${fallbackEmail}`, {
          exact: true,
        });
        await expect(fallbackLink).toBeVisible();
        await expect.poll(() => refusedRefreshes).toBeGreaterThan(0);
        await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
        const fallbackCopy = fallbackLink
          .locator('..')
          .getByRole('button', { name: 'Copy link', exact: true });
        await fallbackCopy.scrollIntoViewIfNeeded();
        await expect(fallbackCopy).toBeInViewport();
        await expectNoHorizontalOverflow(dialog);
        await capture(page, `${scope}-${viewport.name}-refresh-fallback`);
      });
    }
  });
}
