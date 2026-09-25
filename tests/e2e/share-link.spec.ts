// Share links: the owner creates one, a stranger opens it, and an expired one is
// refused.
//
// Accessibility findings this spec has to work around, reported rather than
// hidden: neither the guest-name input (components/video-page/guest-name-gate.tsx)
// nor the password input (components/share-link-unlock.tsx) has a label, an
// aria-label or an id, and a password input has no ARIA role at all, so there is
// no getByRole route to either. They are located by placeholder here.
import { test, expect, anonTest } from './fixtures';

test('the owner creates a review link and a stranger opens it through the guest gate', async ({
  page,
  browser,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser, { title: `Shared Video ${Date.now()}` });

  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}/share`);

  // The page is identified by its create control rather than by the card title
  // "Share Video For Review": that title is server-rendered, and while the
  // streamed markup is being swapped into place there are briefly two copies of
  // it in the document (one still hidden), which is a strict-mode violation
  // waiting to happen. The button is rendered only by the client, after the
  // link settings have loaded, so there is only ever one of it, and waiting for
  // it also means the fetch behind "Loading link settings..." has finished.
  const createLink = page.getByRole('button', { name: 'Create Review Link' });
  await expect(createLink).toBeVisible();
  await createLink.click();

  const linkField = page.locator('input[readonly]');
  await expect(linkField).toBeVisible();
  const shareUrl = await linkField.inputValue();
  expect(new URL(shareUrl).pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{16}$/);
  expect(new URL(shareUrl).search).toBe('');

  // A stranger, in a context with no session at all.
  //
  // `storageState: undefined` is load-bearing. Playwright Test feeds the test's
  // own context options into `browser.newContext()`, and this file's `test`
  // fixture sets `storageState` to the seeded owner's session, so a bare
  // `newContext()` opens the share link as the owner: `/api/watch/:id` then
  // answers `isAuthenticated: true`, `isGuest` is false in
  // components/video-page-content.tsx, and the guest gate is skipped.
  const guestContext = await browser.newContext({ storageState: undefined });
  try {
    const guestPage = await guestContext.newPage();
    await guestPage.goto(shareUrl);

    // The bootstrap page exchanges the token for a share session cookie and
    // then lands on the clean watch URL.
    await expect(guestPage).toHaveURL(new RegExp(`/watch/${seeded.videoId}$`));

    // Guest name gate: no account, so the visitor has to say who they are.
    await expect(guestPage.getByRole('heading', { name: 'Welcome to OpenFrame' })).toBeVisible();
    await guestPage.getByPlaceholder('Your name').fill('Passing Reviewer');
    await guestPage.getByRole('button', { name: 'Continue' }).click();

    // The permission level on a link created through this UI is COMMENT, so the
    // guest gets a comment composer, not a read-only page.
    await expect(guestPage.getByPlaceholder('Add a comment...')).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test('a password on the link puts an unlock form in front of the video', async ({
  page,
  browser,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);

  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}/share`);
  await page.getByRole('button', { name: 'Create Review Link' }).click();
  await expect(page.locator('input[readonly]')).toBeVisible();

  // Setting a password rotates the token, so read the URL only afterwards.
  await page.locator('input[type="password"]').fill('share-secret-123');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();

  const shareUrl = await page.locator('input[readonly]').inputValue();

  // Anonymous on purpose; see the note in the first test about why the
  // `storageState` override is required here.
  const guestContext = await browser.newContext({ storageState: undefined });
  try {
    const guestPage = await guestContext.newPage();
    await guestPage.goto(shareUrl);

    await expect(guestPage).toHaveURL(/unlock=1$/);
    await expect(guestPage.getByRole('heading', { name: 'Password Required' })).toBeVisible();

    // Wrong password first, so the assertion below is about the password and not
    // about the form merely existing.
    await guestPage.locator('input[type="password"]').fill('not-the-password');
    await guestPage.getByRole('button', { name: 'Continue' }).click();
    await expect(guestPage.getByText('Invalid password')).toBeVisible();

    await guestPage.locator('input[type="password"]').fill('share-secret-123');
    await guestPage.getByRole('button', { name: 'Continue' }).click();

    await expect(guestPage).toHaveURL(new RegExp(`/watch/${seeded.videoId}$`));
    await guestPage.getByPlaceholder('Your name').fill('Unlocked Reviewer');
    await guestPage.getByRole('button', { name: 'Continue' }).click();
    await expect(guestPage.getByPlaceholder('Add a comment...')).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

// The UI has no expiry control at all (permission and expiresAt are fixed
// server-side), so the expired row is seeded directly. That is the only way to
// cover the branch, and it is a gap worth knowing about: an expiring link cannot
// be created through the product.
anonTest('an expired share link is refused', async ({ page, seed }) => {
  const owner = await seed.user();
  const seeded = await seed.version(owner);
  const link = await seed.shareLink({
    projectId: seeded.project.id,
    videoId: seeded.videoId,
    expiresAt: new Date(Date.now() - 60 * 60 * 1000),
  });

  await page.goto(`/watch/${seeded.videoId}?shareToken=${link.token}`);

  await expect(page.getByText('Share session is invalid')).toBeVisible();
  await expect(page.getByPlaceholder('Add a comment...')).toHaveCount(0);
});

anonTest('an existing long watch link still opens a shared video', async ({ page, seed }) => {
  const owner = await seed.user();
  const seeded = await seed.version(owner);
  const token = '1234567890abcdefghijklmnopqrstuv';
  await seed.shareLink({ projectId: seeded.project.id, videoId: seeded.videoId, token });

  await page.goto(`/watch/${seeded.videoId}?shareToken=${token}`);

  await expect(page).toHaveURL(new RegExp(`/watch/${seeded.videoId}$`));
  await expect(page.getByRole('heading', { name: 'Welcome to OpenFrame' })).toBeVisible();
});
