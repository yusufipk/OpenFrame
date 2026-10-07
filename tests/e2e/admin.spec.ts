// The /admin area, which nothing covered before.
//
// Admin is not a database column. lib/auth.ts:144 derives `token.isAdmin` on
// every request by looking the signed-in address up in the ADMIN_EMAILS
// environment variable of the *app under test*. That has two consequences for
// this file:
//
//  1. The privileged account has to use a fixed address rather than the
//     per-test unique one every other spec gets, hence ADMIN_EMAIL below.
//     Because that address is unique in the database, the two tests that use it
//     must not run at the same time, hence the serial describe.
//  2. That variable therefore has to be set for the app under test, and
//     playwright.config.ts sets it in APP_ENV to exactly ADMIN_EMAIL below.
//     Remove it and the privileged half of this spec has nothing to sign in as,
//     so the probe below **fails** rather than skipping: this is the only
//     positive coverage of the admin area in the repo outside
//     tests/api/auth-matrix.test.ts, and a config change should not be able to
//     quietly delete it.
//
// The probe reads /api/auth/session, which is a question about configuration,
// not about the authorization being tested: if the /admin guard itself
// regressed, isAdmin would still be true and the tests below would fail on
// their own assertions.
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { anonTest, expect, E2E_PASSWORD, signInPage } from './fixtures';
import { addWorkspaceMember, createUser, createVersion, createVideo } from '../factories';
import { db } from '@/lib/db';

/**
 * The address that must appear in the app's ADMIN_EMAILS for the privileged
 * tests to run. Lower case, because lib/auth.ts lower-cases both sides.
 */
const ADMIN_EMAIL = 'e2e-admin@example.com';

const ADMIN_SETUP_HINT =
  `The app under test does not treat ${ADMIN_EMAIL} as an admin. ` +
  `APP_ENV in playwright.config.ts must set ADMIN_EMAILS to '${ADMIN_EMAIL}'; ` +
  `this is a failure rather than a skip because it is the only place the admin ` +
  `area is exercised from a browser.`;

/** Whether the app considers the signed-in account an admin. */
async function sessionIsAdmin(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/auth/session');
  if (!response.ok()) return false;
  const session = (await response.json()) as { user?: { isAdmin?: boolean } };
  return session.user?.isAdmin === true;
}

/** Creates the fixed-address admin account and signs `page` in as it. */
async function signInAsAdmin(page: Page): Promise<void> {
  await db.user.deleteMany({ where: { email: ADMIN_EMAIL } });
  await createUser({ name: 'E2E Admin', email: ADMIN_EMAIL, password: E2E_PASSWORD });
  await signInPage(page, ADMIN_EMAIL);
}

anonTest.describe('the admin area', () => {
  // ADMIN_EMAIL is a unique column, so only one test may hold it at a time.
  anonTest.describe.configure({ mode: 'serial' });

  anonTest.afterEach(async () => {
    await db.user.deleteMany({ where: { email: ADMIN_EMAIL } });
  });

  anonTest('an ordinary signed-in user is refused every admin page', async ({ page, seed }) => {
    const user = await seed.user({ name: 'Not An Admin' });
    await signInPage(page, user.email ?? '');

    // The session is real: without this the redirects below would prove nothing
    // more than that /admin is behind a login.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
    expect(await sessionIsAdmin(page.context().request)).toEqual(false);

    for (const route of ['/admin', '/admin/users', '/admin/feedback']) {
      await page.goto(route);
      // app/admin/layout.tsx sends a non-admin to the marketing root.
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toHaveCount(0);
    }

    // Refused, not missing. A route that did not exist would answer 404, and a
    // 404 would satisfy every assertion above for the wrong reason.
    const missing = await page.request.get('/definitely-not-a-route', { maxRedirects: 0 });
    expect(missing.status()).toEqual(404);
    const admin = await page.request.get('/admin', { maxRedirects: 0 });
    expect(admin.status()).not.toEqual(404);

    // The write side is guarded independently of the pages.
    const refresh = await page.request.post('/api/admin/stats/refresh-r2');
    expect(refresh.status()).toEqual(403);
  });

  anonTest(
    'an admin reaches the dashboard and can search the user list',
    async ({ page, seed }) => {
      // Seeded before the probe so the search below has something to find.
      const target = await seed.user({ name: 'Findable Person' });
      const targetEmail = target.email ?? '';

      await signInAsAdmin(page);
      expect(await sessionIsAdmin(page.context().request), ADMIN_SETUP_HINT).toBe(true);

      await page.goto('/admin');
      await expect(page).toHaveURL(/\/admin$/);
      await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();

      // The dashboard is not a static shell: it counts rows, and the count has to
      // be at least the two accounts this test created.
      const totalUsers = Number(
        (await page.getByText('Total Users').locator('xpath=../..').innerText())
          .replace(/[^0-9]/g, '')
          .trim()
      );
      expect(totalUsers).toBeGreaterThanOrEqual(2);

      // --- one action: search the user list -----------------------------------
      await page.getByRole('link', { name: 'Users' }).first().click();
      await expect(page).toHaveURL(/\/admin\/users$/);

      // Scoped to the form: the global header carries an icon button whose
      // accessible name is also "Search".
      const searchForm = page.locator('form[action="/admin/users"]');
      const search = searchForm.getByLabel('Search users by name or email');
      const submit = searchForm.getByRole('button', { name: 'Search' });

      await search.fill(targetEmail);
      await submit.click();

      await expect(page).toHaveURL(/[?&]q=/);
      await expect(page.getByText(targetEmail, { exact: true })).toBeVisible();

      // The filter really filters: the admin's own row is in the unfiltered list
      // and must be absent from this one.
      await expect(page.getByText(ADMIN_EMAIL, { exact: true })).toHaveCount(0);

      // And a query that matches nobody says so, rather than falling back to
      // everybody.
      await search.fill(`no-such-person-${Date.now()}@example.invalid`);
      await submit.click();
      await expect(page.getByText('No users match these filters.')).toBeVisible();
      await expect(page.getByText(targetEmail, { exact: true })).toHaveCount(0);
    }
  );

  anonTest(
    'shows team uploader names, owner exclusion and sorting on both admin pages',
    async ({ page, seed }, testInfo) => {
      const [solo, one, two, editor, colorist, inactive] = await Promise.all([
        seed.user({ name: 'Uploader Browser Account Solo' }),
        seed.user({ name: 'Uploader Browser Account One' }),
        seed.user({ name: 'Uploader Browser Account Two' }),
        seed.user({ name: 'Editor Çiğdem' }),
        seed.user({ name: 'Colorist Özgür' }),
        seed.user({ name: 'Inactive Collaborator' }),
      ]);

      await db.user.updateMany({
        where: { id: { in: [solo.id, one.id, two.id] } },
        data: { subscriptionStatus: 'ACTIVE' },
      });

      for (const owner of [solo, one, two]) {
        const { project, workspaceId } = await seed.project(owner);
        const video = await createVideo({ projectId: project.id });
        await createVersion({ videoParentId: video.id, versionNumber: 1, uploadedById: owner.id });
        if (owner.id === solo.id) continue;

        await addWorkspaceMember({ workspaceId, userId: editor.id, role: 'ADMIN' });
        await createVersion({ videoParentId: video.id, versionNumber: 2, uploadedById: editor.id });
        await createVersion({ videoParentId: video.id, versionNumber: 3, uploadedById: editor.id });
        await addWorkspaceMember({ workspaceId, userId: inactive.id, role: 'ADMIN' });
        await createVersion({
          videoParentId: video.id,
          versionNumber: 4,
          uploadedById: inactive.id,
          createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        });
        await createVersion({ videoParentId: video.id, versionNumber: 5, uploadedById: null });
        if (owner.id === two.id) {
          await addWorkspaceMember({ workspaceId, userId: colorist.id, role: 'ADMIN' });
          await createVersion({
            videoParentId: video.id,
            versionNumber: 6,
            uploadedById: colorist.id,
          });
        }
      }

      await signInAsAdmin(page);
      expect(await sessionIsAdmin(page.context().request), ADMIN_SETUP_HINT).toBe(true);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/admin/users?q=Uploader%20Browser%20Account');
      const usersTable = page.getByRole('table');
      const headers = await usersTable.getByRole('columnheader').allTextContents();
      const teamColumn = headers.findIndex((text) => text.includes('Team uploaders (30d)'));
      expect(teamColumn).toBeGreaterThanOrEqual(0);

      const assertTeam = async (
        table: Locator,
        identity: string,
        column: number,
        count: string,
        names: string[]
      ) => {
        const row = table.getByRole('row').filter({ hasText: identity });
        await expect(row).toHaveCount(1);
        const cell = row.getByRole('cell').nth(column);
        await expect(cell.locator('span').first()).toHaveText(count);
        await expect(cell.getByRole('listitem')).toHaveText(names);
      };

      await assertTeam(usersTable, solo.email ?? '', teamColumn, '0', []);
      await assertTeam(usersTable, one.email ?? '', teamColumn, '1', ['Editor Çiğdem']);
      await assertTeam(usersTable, two.email ?? '', teamColumn, '2', [
        'Colorist Özgür',
        'Editor Çiğdem',
      ]);

      await page.getByRole('link', { name: 'Team uploaders (30d)' }).click();
      await expect(page).toHaveURL(/[?&]sortDirection=desc/);
      await expect(usersTable.locator('tbody tr').first()).toContainText(two.email ?? '');
      await page.getByRole('link', { name: 'Team uploaders (30d)' }).click();
      await expect(page).toHaveURL(/[?&]sortDirection=asc/);
      await expect(usersTable.locator('tbody tr').first()).toContainText(solo.email ?? '');
      await page.screenshot({
        path: testInfo.outputPath('team-uploaders-users.png'),
        fullPage: true,
      });

      await page.goto('/admin/growth');
      const growthTable = page.getByRole('table').filter({
        has: page.getByRole('columnheader', { name: 'Team uploaders', exact: true }),
      });
      await expect(growthTable).toHaveCount(1);
      const growthHeaders = await growthTable.getByRole('columnheader').allTextContents();
      const growthTeamColumn = growthHeaders.findIndex((text) => text.trim() === 'Team uploaders');
      expect(growthTeamColumn).toBeGreaterThanOrEqual(0);
      await assertTeam(growthTable, 'Uploader Browser Account Solo', growthTeamColumn, '0', []);
      await assertTeam(growthTable, 'Uploader Browser Account One', growthTeamColumn, '1', [
        'Editor Çiğdem',
      ]);
      await assertTeam(growthTable, 'Uploader Browser Account Two', growthTeamColumn, '2', [
        'Colorist Özgür',
        'Editor Çiğdem',
      ]);
      await growthTable.screenshot({ path: testInfo.outputPath('team-uploaders-growth.png') });
    }
  );
});
