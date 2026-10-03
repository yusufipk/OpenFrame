// A fresh account walks the wizard and comes out with a workspace and a project.
//
// The account is seeded rather than registered through the form: registration is
// rate limited to five per hour per IP and auth.spec.ts already owns that path.
// What matters here is `onboardingCompletedAt: null`, which is what sends
// /dashboard to /onboarding.
import { anonTest as test, expect, signInPage } from './fixtures';

test('a fresh user creates a workspace and a project and lands on the dashboard', async ({
  page,
  seed,
}) => {
  const stamp = Date.now();
  const user = await seed.user({ name: 'Onboarding Person', onboardingCompletedAt: null });
  const workspaceName = `Onboarded Workspace ${stamp}`;
  const projectName = `Onboarded Project ${stamp}`;

  await signInPage(page, user.email ?? '');

  await page.goto('/dashboard');

  // Step 1: welcome. The dashboard bounces an un-onboarded user here.
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(
    page.getByRole('heading', { name: 'Welcome to OpenFrame, Onboarding!' })
  ).toBeVisible();
  await expect(page.getByText('Step 1 of 5')).toBeVisible();
  await page.getByRole('button', { name: 'Get Started' }).click();

  // Step 2: workspace.
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  await page.getByLabel('Workspace Name').fill(workspaceName);
  await page.getByRole('button', { name: 'Create Workspace' }).click();

  // Step 3: project.
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
  await page.getByLabel('Project Name').fill(projectName);
  await page.getByRole('button', { name: 'Create Project' }).click();

  // Step 4: informational.
  await expect(page.getByRole('heading', { name: 'Adding videos' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it, continue' }).click();

  // Step 5: notifications. `Skip` still posts /api/onboarding/complete.
  await expect(page.getByRole('heading', { name: 'Notification preferences' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(projectName) })).toBeVisible();
  await expect(page.getByText(workspaceName)).toBeVisible();

  // Onboarding does not run a second time.
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/dashboard$/);
});

// Skipping the workspace step leaves an account with nothing to put a project in.
// The empty dashboard has to send it to workspace creation instead of a dead end.
test('an account without a workspace is sent from the empty dashboard to create one', async ({
  page,
  seed,
}) => {
  const user = await seed.user({ name: 'No Workspace Person' });
  const workspaceName = `First Workspace ${Date.now()}`;

  await signInPage(page, user.email ?? '');
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create Project' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Create Workspace' }).click();

  await expect(page).toHaveURL(/\/workspaces\/new$/);
  await page.getByLabel('Workspace Name').fill(workspaceName);
  await page.getByRole('button', { name: 'Create Workspace' }).click();

  await expect(page).toHaveURL(/\/workspaces\/(?!new$)[^/]+$/);
  await expect(page.getByRole('link', { name: 'Create Project' })).toBeVisible();
});
