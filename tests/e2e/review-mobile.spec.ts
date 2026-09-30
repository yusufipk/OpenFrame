// Runs in the `mobile-chrome` project only (see playwright.config.ts).
//
// The review and compare pages on a phone. A reviewer who opens a share link
// has to see the video and the comments together, without finding and opening
// a panel first. The comments used to sit in an off-canvas drawer that covered
// the player when opened, so a guest on a phone saw a video and no feedback.
import { anonTest as test, test as signedInTest, expect } from './fixtures';
import { SharePermission } from '@prisma/client';
import { createVersion } from '../factories';

test('a guest on a phone sees the player and the comments on one screen', async ({
  page,
  seed,
}) => {
  const owner = await seed.user();
  const seeded = await seed.version(owner, { title: `Mobile Review ${Date.now()}` });
  const feedback = `Trim the intro ${Date.now()}`;
  await seed.comment({
    versionId: seeded.versionId,
    authorId: owner.id,
    content: feedback,
    timestamp: 3,
  });
  const link = await seed.shareLink({
    projectId: seeded.project.id,
    videoId: seeded.videoId,
    permission: SharePermission.COMMENT,
  });

  await page.goto(`/s/${link.token}`);
  await expect(page).toHaveURL(new RegExp(`/watch/${seeded.videoId}$`));
  await page.getByPlaceholder('Your name').fill('Phone Reviewer');
  await page.getByRole('button', { name: 'Continue' }).click();

  // The player is a YouTube embed that cannot load here (see fixtures.ts), but
  // its frame is laid out regardless, and the layout is what is under test.
  const player = page.locator('iframe').first();
  await expect(player).toBeInViewport();

  // Both halves on screen at once, with nothing tapped: in the old drawer the
  // comment was rendered but translated off the right edge.
  await expect(page.getByText(feedback)).toBeInViewport();
  await expect(page.getByPlaceholder('Add a comment...')).toBeInViewport();

  // Stacked, not side by side: the comment sits below the player.
  const playerBox = await player.boundingBox();
  const commentBox = await page.getByText(feedback).boundingBox();
  if (!playerBox || !commentBox) throw new Error('The player or the comment has no layout box.');
  expect(commentBox.y).toBeGreaterThanOrEqual(playerBox.y + playerBox.height);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  // The drawing toolbar sits under the player, not over it: on a phone the
  // player is about 230px tall and a floating toolbar covered half of it.
  await page.getByRole('button', { name: 'Draw annotation on video' }).click();
  const toolbar = page.getByRole('group', { name: 'Drawing tool' });
  await expect(toolbar).toBeVisible();
  const toolbarBox = await toolbar.boundingBox();
  const frameBox = await player.boundingBox();
  if (!toolbarBox || !frameBox) throw new Error('The toolbar or the player has no layout box.');
  expect(toolbarBox.y).toBeGreaterThanOrEqual(frameBox.y + frameBox.height);
});

test('a landscape window narrower than a desktop keeps the comments beside the player', async ({
  page,
  seed,
}) => {
  const owner = await seed.user();
  const seeded = await seed.version(owner, { title: `Half Window ${Date.now()}` });
  const feedback = `Beside the player ${Date.now()}`;
  await seed.comment({ versionId: seeded.versionId, authorId: owner.id, content: feedback });
  const link = await seed.shareLink({ projectId: seeded.project.id, videoId: seeded.videoId });

  // A half-width desktop window on a high-density screen: under the 64rem desktop
  // breakpoint, but landscape. It once stacked the comments under a full-width player.
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`/s/${link.token}`);
  await page.getByPlaceholder('Your name').fill('Window Reviewer');
  await page.getByRole('button', { name: 'Continue' }).click();

  const player = page.locator('iframe').first();
  const comment = page.getByText(feedback);
  await expect(comment).toBeInViewport();
  const playerBox = await player.boundingBox();
  const commentBox = await comment.boundingBox();
  if (!playerBox || !commentBox) throw new Error('The player or the comment has no layout box.');
  expect(commentBox.x).toBeGreaterThanOrEqual(playerBox.x + playerBox.width);

  // The script's copy of the breakpoint agrees: the drawing toolbar floats over
  // the player here instead of dropping under it as on a phone.
  await page.getByRole('button', { name: 'Draw annotation on video' }).click();
  const toolbar = page.getByRole('group', { name: 'Drawing tool' });
  await expect(toolbar).toBeVisible();
  const toolbarBox = await toolbar.boundingBox();
  if (!toolbarBox) throw new Error('The drawing toolbar has no layout box.');
  expect(toolbarBox.y).toBeLessThan(playerBox.y + playerBox.height);
});

signedInTest(
  'compare stacks the versions on a phone instead of squeezing them side by side',
  async ({ page, seed, seededUser }) => {
    const seeded = await seed.version(seededUser, { title: `Mobile Compare ${Date.now()}` });
    await createVersion({
      videoParentId: seeded.videoId,
      versionNumber: 2,
      providerVideoId: 'dQw4w9WgXcQ',
      title: 'Second cut',
      // The seeded first version stays the active one; compare shows the latest two.
      isActive: false,
    });

    await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}/compare`);

    // The panels are measured rather than their players: the YouTube players only
    // appear once youtube.com answers, and their frames have a fixed 640px width.
    const panels = page.getByTestId('compare-panel');
    await expect(panels).toHaveCount(2);
    const first = await panels.nth(0).boundingBox();
    const second = await panels.nth(1).boundingBox();
    if (!first || !second) throw new Error('A compare panel has no layout box.');

    // Stacked: the second panel starts below the first and gets the full width.
    // Side by side on a 412px screen, each panel was about 200px wide.
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    const viewportWidth = page.viewportSize()?.width ?? 0;
    expect(second.width).toBeGreaterThan(viewportWidth * 0.9);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  }
);
