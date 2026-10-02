import { createComment } from '../factories';
import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';
import { parseMarkerEdl, parseMarkerXml } from '../helpers/nle-parser';

// Real browser, auth, seeded database, route and download. Parsers do not import
// production serialization code. This is not a native NLE import compatibility test.
for (const format of ['edl', 'xml'] as const) {
  test(`downloads ${format} with rational timing, Unicode, same-frame ranges and threads`, async ({
    page,
    seed,
    seededUser,
  }, testInfo) => {
    const seeded = await seed.version(seededUser);
    const content = 'İpek 🎬 中文 <marker> & "quotes"\nSecond line |D:999';
    const parent = await createComment({
      versionId: seeded.versionId,
      authorId: seededUser.id,
      content,
      timestamp: 1001,
      timestampEnd: 1002,
    });
    const reply = await createComment({
      versionId: seeded.versionId,
      parentId: parent.id,
      authorId: seededUser.id,
      content: 'Reply\ncontinued',
      timestamp: 1001,
    });
    const nested = await createComment({
      versionId: seeded.versionId,
      parentId: reply.id,
      authorId: seededUser.id,
      content: 'Nested reply',
      timestamp: 1001,
    });
    const same = await createComment({
      versionId: seeded.versionId,
      authorId: seededUser.id,
      content: 'Same frame',
      timestamp: 1001,
      timestampEnd: 1003,
    });
    await createComment({
      versionId: seeded.versionId,
      authorId: seededUser.id,
      content: 'Filtered resolved comment',
      timestamp: 0,
      isResolved: true,
    });
    await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
    await expect(page.getByPlaceholder('Add a comment...')).toBeVisible();
    await page.getByRole('button', { name: 'Download comments' }).click();
    await page
      .getByRole('menuitem', {
        name: format === 'edl' ? 'DaVinci Resolve (EDL)' : 'Adobe Premiere (XML)',
      })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Frame rate (fps)').selectOption('30000/1001');
    await dialog.getByLabel('Drop-frame timecode').check();
    await dialog.getByLabel('Timeline start timecode').fill('01:00:00;00');
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: `Download ${format.toUpperCase()}` }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(new RegExp(`-v1-comments\\.${format}$`));
    await download.saveAs(testInfo.outputPath(`comments.${format}`));
    const path = await download.path();
    expect(path).not.toBeNull();
    const text = await readFile(path!, 'utf8');
    const markers = format === 'edl' ? parseMarkerEdl(text) : parseMarkerXml(text).markers;
    expect(markers).toHaveLength(1);
    expect(markers[0].entries.map((entry: { commentId: string }) => entry.commentId)).toEqual([
      parent.id,
      reply.id,
      nested.id,
      same.id,
    ]);
    expect(markers[0].entries[0].content).toBe(content);
    expect(markers[0].entries[1].parentCommentId).toBe(parent.id);
    expect(markers[0].entries[2].parentCommentId).toBe(reply.id);
    expect(markers[0].entries[3].timestampEnd).toBe(1003);
    expect(text).not.toContain('Filtered resolved comment');
    if (format === 'edl') {
      expect(parseMarkerEdl(text)[0]).toMatchObject({ timecode: '01:16:41;00', duration: 60 });
    } else {
      const parsed = parseMarkerXml(text);
      expect(parsed.markers[0]).toMatchObject({ start: 30000, end: 30060 });
      expect(parsed.doc.querySelector('sequence > timecode > frame')!.textContent).toBe('107892');
      expect(parsed.doc.querySelectorAll('marker')).toHaveLength(1);
    }
  });
}
