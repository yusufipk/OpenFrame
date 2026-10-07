// Workspace member management, driven entirely from the browser.
//
// The API behind /api/workspaces/:id/members is well covered by the api suite.
// What is not covered anywhere is the round trip: an owner invites someone in
// one browser, that person accepts in another, and the role they end up with
// decides what their pages render. This spec asserts on the *other* account's
// view after every change the owner makes, because a permission change that the
// owner's own page reports but the member's browser never sees is exactly the
// bug an api-level test cannot find.
//
// Two things about the invite flow are worth knowing before reading on:
//
//  1. Inviting never adds a member directly, even when the address already
//     belongs to an account. app/api/workspaces/[workspaceId]/members/route.ts
//     always creates an Invitation and emails a link.
//  2. SMTP is deliberately unset for this suite (see playwright.config.ts), so
//     nothing is delivered. The token is read out of the database instead. That
//     is the one shortcut here; everything on either side of it goes through the
//     UI.
import { test, expect, storageStateFor, type StorageState } from './fixtures';
import { db } from '@/lib/db';

/**
 * The invitation link the owner's invite would have emailed.
 *
 * Scoped to the address the test just invited, so it cannot pick up a row from
 * a parallel worker.
 */
async function invitationTokenFor(email: string): Promise<string> {
  const invitation = await db.invitation.findFirst({
    where: { email, scope: 'WORKSPACE', status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { token: true },
  });
  if (!invitation) {
    throw new Error(`No pending workspace invitation was created for ${email}.`);
  }
  return invitation.token;
}

/**
 * The member row for `email` in the Current Members card.
 *
 * The rows carry no role, no heading and no test id, so the only stable anchor
 * is the address itself: the <p> holding it, then three levels up to the row
 * div that also holds the role select and the remove button. See
 * components/members-management-page.tsx.
 */
function memberRowFor(page: import('@playwright/test').Page, email: string) {
  return page.getByText(email, { exact: true }).locator('xpath=ancestor::div[3]');
}

test('an invited member accepts, is promoted, and is removed, and their own pages follow', async ({
  page,
  browser,
  playwright,
  baseURL,
  seed,
  seededUser,
}) => {
  // `confirm()` guards the remove button. Playwright dismisses dialogs by
  // default, which would make the DELETE never fire and the assertion below
  // fail for a reason that has nothing to do with the product.
  page.on('dialog', (dialog) => void dialog.accept());

  const workspace = await seed.workspace(seededUser);
  const member = await seed.user({ name: 'Invited Reviewer' });
  const memberEmail = member.email ?? '';
  expect(memberEmail).not.toEqual('');

  const memberState: StorageState = await storageStateFor(
    playwright.request,
    baseURL ?? '',
    memberEmail
  );
  const memberContext = await browser.newContext({ storageState: memberState });

  try {
    const memberPage = await memberContext.newPage();

    // --- before the invitation ----------------------------------------------
    // A stranger to the workspace is bounced off it entirely. This is the
    // control for every "the member can see it now" assertion further down.
    await memberPage.goto(`/workspaces/${workspace.id}`);
    await expect(memberPage).toHaveURL(/\/dashboard$/);

    // --- the owner invites --------------------------------------------------
    await page.goto(`/workspaces/${workspace.id}/members`);
    await expect(page.getByText('No members yet. Invite someone above.')).toBeVisible();

    await page.getByLabel('Email Address').fill(memberEmail);
    await page.getByRole('button', { name: 'Invite' }).click();

    await expect(
      page.getByText(
        `Invitation created for ${memberEmail}, but email could not be sent. Copy the link to share it.`
      )
    ).toBeVisible();
    // The pending list is the owner-visible proof that a row was written; the
    // success banner alone would also appear for a no-op.
    await expect(page.getByText('No pending invitations.')).toHaveCount(0);
    await expect(page.getByText(memberEmail, { exact: true })).toBeVisible();

    // --- the member accepts -------------------------------------------------
    const token = await invitationTokenFor(memberEmail);
    await memberPage.goto(`/invitations/accept?token=${token}`);

    // Accepting lands on the workspace it was for, which is itself the first
    // proof that the membership row now exists: the same URL redirected to
    // /dashboard a moment ago.
    await expect(memberPage).toHaveURL(
      new RegExp(`/workspaces/${workspace.id}\\?invite=accepted$`)
    );
    await expect(memberPage.getByRole('heading', { name: workspace.name })).toBeVisible();

    // COMMENTATOR is the role that was sent, so the management controls must
    // not be there.
    await expect(memberPage.getByRole('link', { name: 'Members' })).toHaveCount(0);
    await expect(memberPage.getByRole('link', { name: 'Settings' })).toHaveCount(0);

    // And the page behind that button is refused, not merely unlinked.
    await memberPage.goto(`/workspaces/${workspace.id}/members`);
    await expect(memberPage).toHaveURL(/\/dashboard$/);

    // --- the owner promotes them to ADMIN -----------------------------------
    await page.reload();
    const memberRow = memberRowFor(page, memberEmail);
    const roleSelect = memberRow.getByRole('combobox');
    await expect(roleSelect).toContainText('Commentator');

    await roleSelect.click();
    await page.getByRole('option', { name: 'Admin' }).click();
    await expect(roleSelect).toContainText('Admin');

    // The member's own browser has to see the new role, not just the owner's.
    await memberPage.goto(`/workspaces/${workspace.id}`);
    await expect(memberPage.getByRole('link', { name: 'Members' })).toBeVisible();

    await memberPage.goto(`/workspaces/${workspace.id}/members`);
    await expect(memberPage.getByRole('heading', { name: 'Members' })).toBeVisible();
    // An admin sees the owner as well as themselves, so the empty-state line is
    // the wrong thing to look for; the owner's address is the right one.
    await expect(memberPage.getByText(seededUser.email ?? '', { exact: true })).toBeVisible();

    // --- the owner removes them ---------------------------------------------
    await page.reload();
    const rowToRemove = memberRowFor(page, memberEmail);
    await rowToRemove.getByRole('button').last().click();

    await expect(page.getByText('No members yet. Invite someone above.')).toBeVisible();

    // Back to where the spec started: no access at all.
    await memberPage.goto(`/workspaces/${workspace.id}`);
    await expect(memberPage).toHaveURL(/\/dashboard$/);
  } finally {
    await memberContext.close();
  }
});

test('a commentator cannot invite anyone, and the owner can withdraw a pending invitation', async ({
  page,
  browser,
  playwright,
  baseURL,
  seed,
  seededUser,
}) => {
  const workspace = await seed.workspace(seededUser);
  const commentator = await seed.user({ name: 'Commentator Only' });
  const commentatorEmail = commentator.email ?? '';

  // Seeded directly rather than invited through the UI: the invite-then-accept
  // path is what the test above exists for, and repeating it here would double
  // this spec's runtime to set up a precondition.
  await db.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: commentator.id, role: 'COMMENTATOR' },
  });

  const commentatorContext = await browser.newContext({
    storageState: await storageStateFor(playwright.request, baseURL ?? '', commentatorEmail),
  });

  try {
    const commentatorPage = await commentatorContext.newPage();

    // The member page is the only route to the invite form, and 'manage' intent
    // sends a commentator away from it.
    await commentatorPage.goto(`/workspaces/${workspace.id}/members`);
    await expect(commentatorPage).toHaveURL(/\/dashboard$/);
    await expect(commentatorPage.getByLabel('Email Address')).toHaveCount(0);

    // --- the owner invites a third party and then withdraws it --------------
    const outsiderEmail = `e2e-withdrawn-${Date.now()}@example.com`;

    await page.goto(`/workspaces/${workspace.id}/members`);
    await page.getByLabel('Email Address').fill(outsiderEmail);
    await page.getByRole('button', { name: 'Invite' }).click();
    await expect(
      page.getByText(
        `Invitation created for ${outsiderEmail}, but email could not be sent. Copy the link to share it.`
      )
    ).toBeVisible();

    const invitationRow = page
      .getByText(outsiderEmail, { exact: true })
      .locator('xpath=ancestor::div[2]');
    await invitationRow.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByText('Invitation canceled')).toBeVisible();
    await expect(page.getByText('No pending invitations.')).toBeVisible();

    // Withdrawn for real: the token that was minted no longer opens anything.
    const withdrawn = await db.invitation.findFirst({
      where: { email: outsiderEmail },
      select: { status: true },
    });
    expect(withdrawn?.status).toEqual('CANCELED');
  } finally {
    // The invitation row hangs off the workspace, which hangs off the owner, so
    // the Seed's own user cleanup takes it with it.
    await commentatorContext.close();
  }
});
