import '../helpers/env';
import sharp from 'sharp';
import { db } from '@/lib/db';
import { test, expect } from './fixtures';

test.setTimeout(120_000);

test('an independent image supports annotations, versions and guest review', async ({
  page,
  browser,
  seed,
  seededUser,
}, testInfo) => {
  const { project } = await seed.project(seededUser);
  const title = `Studio concept ${Date.now()}`;
  const png = await sharp(
    Buffer.from(
      '<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#e4dcd0"/><rect x="120" y="100" width="350" height="440" fill="#8eabb0"/><rect x="620" y="370" width="420" height="220" rx="40" fill="#bd8064"/><path d="M0 620H1200V800H0Z" fill="#b5a28e"/></svg>'
    )
  )
    .png()
    .toBuffer();
  const file = { name: 'studio.png', mimeType: 'image/png', buffer: png };

  await page.goto(`/projects/${project.id}/videos/new`);
  await page.getByRole('tab', { name: 'Direct Upload' }).click();
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Upload File', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  await page.getByRole('heading', { name: title, level: 3 }).click();
  const viewport = page.getByTestId('image-review-viewport');
  await expect(viewport).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width
  );
  await expect(viewport.getByRole('img', { name: title, exact: true })).toHaveJSProperty(
    'naturalWidth',
    1200
  );
  await expect(page.locator('video')).toHaveCount(0);
  const video = await db.video.findFirstOrThrow({
    where: { projectId: project.id, title },
    include: { versions: true },
  });
  expect(video.mediaType).toBe('IMAGE');
  expect(video.versions).toHaveLength(1);

  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByTitle('Draw annotation on image').click();
  await expect(page.getByTitle('Close annotation tool')).toBeInViewport();
  await page.getByTitle('Close annotation tool').click();
  await page.getByTitle('Draw annotation on image').click();
  const annotationSurface = viewport.locator('svg[aria-label="Annotation canvas"]');
  await expect(annotationSurface).toBeVisible();
  const box = await annotationSurface.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('Annotation canvas has no bounds');
  const imageBounds = await viewport.getByRole('img', { name: title, exact: true }).boundingBox();
  expect(imageBounds).not.toBeNull();
  expect(box.x).toBeCloseTo(imageBounds!.x, 1);
  expect(box.y).toBeCloseTo(imageBounds!.y, 1);
  expect(box.width).toBeCloseTo(imageBounds!.width, 1);
  expect(box.height).toBeCloseTo(imageBounds!.height, 1);
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.65, { steps: 12 });
  await page.mouse.up();
  const comment = 'Make the sofa fabric less reflective';
  await page.getByPlaceholder('Add a comment...').fill(comment);
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/versions/${video.versions[0].id}/comments`)
  );
  await page.getByPlaceholder('Add a comment...').press('Control+Enter');
  expect((await savedResponse).status()).toBe(201);
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
  await expect(page.getByTitle('Jump to this timestamp')).toHaveCount(0);
  const stored = await db.comment.findFirstOrThrow({ where: { versionId: video.versions[0].id } });
  expect(stored.timestamp).toBe(0);
  expect(JSON.parse(stored.annotationData!)[0].points.length).toBeGreaterThan(1);
  await page.reload();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View annotation', exact: true }).click();
  await expect(annotationSurface).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('image-review.png'), fullPage: true });

  await page.getByRole('button', { name: 'New Version', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await dialog.getByPlaceholder('e.g. Final Cut, Review Round 2').fill('Matte fabric');
  await dialog.getByRole('button', { name: 'Add Version 2' }).click();
  await expect(page.getByText('v2', { exact: true })).toBeVisible();
  await expect(page.getByText(comment, { exact: true })).toHaveCount(0);
  await expect(annotationSurface).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toHaveCount(0);
  await expect(viewport.getByRole('img', { name: title, exact: true })).toHaveJSProperty(
    'naturalWidth',
    1200
  );
  await page.getByRole('button', { name: /v2.*Matte fabric/ }).click();
  await page.getByRole('menuitem', { name: /v1.*Version 1/ }).click();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();

  const link = await seed.shareLink({ projectId: project.id, videoId: video.id });
  await db.shareLink.update({
    where: { id: link.id },
    data: { permission: 'COMMENT', allowGuests: true },
  });
  const guestContext = await browser.newContext({ storageState: undefined });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(new URL(`/s/${link.token}`, page.url()).toString());
    await guest.getByPlaceholder('Your name').fill('Image reviewer');
    await guest.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      guest.getByTestId('image-review-viewport').getByRole('img', { name: title, exact: true })
    ).toHaveJSProperty('naturalWidth', 1200);
    await guest.getByPlaceholder('Add a comment...').fill('The new fabric is approved');
    const guestSavedResponse = guest.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/versions\/[^/]+\/comments$/.test(new URL(response.url()).pathname)
    );
    await guest.getByPlaceholder('Add a comment...').press('Control+Enter');
    expect((await guestSavedResponse).status()).toBe(201);
    await expect(guest.getByText('The new fabric is approved', { exact: true })).toBeVisible();
    const guestComment = await db.comment.findFirstOrThrow({
      where: { guestName: 'Image reviewer', version: { videoParentId: video.id } },
    });
    expect(guestComment.authorId).toBeNull();
    expect(guestComment.timestamp).toBe(0);
  } finally {
    await guestContext.close();
  }
});
