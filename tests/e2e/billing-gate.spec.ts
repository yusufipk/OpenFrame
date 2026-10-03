// The billing gate, with OPENFRAME_ENABLE_STRIPE=true.
//
// The flag is deliberately on for this suite. With it off, hasBillingAccess()
// short-circuits to `true` and buildBillingAccessWhereInput() returns `{}`, so
// every assertion in this file would pass against a gate that does not exist.
// See playwright.config.ts.
//
// Nothing here clicks a checkout button: with dummy Stripe credentials that
// would be a real request to Stripe. The assertions stop at the button being
// offered.
import { anonTest as test, expect, signInPage } from './fixtures';

test('a user whose trial has ended is pushed to settings and cannot open a project', async ({
  page,
  seed,
}) => {
  const expired = await seed.expiredUser();
  const seeded = await seed.version(expired);

  await signInPage(page, expired.email ?? '');

  // The dashboard is not reachable: requireBillingAccessOrRedirect sends the
  // user to /settings.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByText('Manage your billing access')).toBeVisible();
  await expect(page.getByText('Billing access has ended.')).toBeVisible();

  // The trial was consumed, so the offer is a plan rather than a new trial.
  // Offered, not clicked. Only STRIPE_PRICE_ID (Solo monthly) is set for this suite,
  // so Studio is shown but cannot be chosen.
  await expect(page.getByRole('button', { name: 'Choose Solo' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Choose Studio' })).toBeDisabled();

  // Their own project is closed to them too: computeProjectAccess() gates on the
  // workspace owner's billing, and they are that owner.
  await page.goto(`/projects/${seeded.project.id}`);
  await expect(page).toHaveURL(/\/settings$/);

  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  await expect(page).toHaveURL(/\/settings$/);
});

test('a user with an active trial reaches the dashboard and the project', async ({
  page,
  seed,
}) => {
  // The other half of the same gate: without this, a broken redirect that sent
  // everyone to /settings would look like a passing test above.
  const active = await seed.user();
  const seeded = await seed.version(active);

  await signInPage(page, active.email ?? '');

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

  await page.goto(`/projects/${seeded.project.id}`);
  await expect(page.getByRole('heading', { name: seeded.project.name, level: 1 })).toBeVisible();
});
