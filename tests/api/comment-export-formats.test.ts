import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { GET } from '@/app/api/versions/[versionId]/comments/export/route';
import { addProjectMember, createComment, createUser, seedVersion } from '../factories';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import { parseCsv, pdfPages } from '../helpers/export-readers';

function request(versionId: string, query: string) {
  return callRoute(GET, apiRequest(`/api/versions/${versionId}/comments/export?${query}`), {
    versionId,
  });
}

async function seedThread() {
  const scenario = await seedVersion();
  const tag = await db.commentTag.create({
    data: { projectId: scenario.project.id, name: 'Teknik', color: '#EF4444' },
  });
  const parent = await createComment({
    versionId: scenario.version.id,
    guestName: 'Ayşe Çelik',
    content: 'Ses burada patlıyor, şöyle düzeltelim',
    timestamp: 12,
    timestampEnd: 15,
    tagId: tag.id,
  });
  await createComment({
    versionId: scenario.version.id,
    parentId: parent.id,
    guestName: 'İsmail',
    content: 'Tamam, düzeltiyorum',
    timestamp: 12,
    isResolved: true,
  });
  signedInAs(scenario.owner);
  return { scenario, parent };
}

describe('comment export formats through the route', () => {
  it('downloads a UTF-8 CSV with readable columns and the thread in order', async () => {
    const { scenario, parent } = await seedThread();
    const response = await request(scenario.version.id, 'format=csv');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    // Response.text() strips a byte order mark, so check the raw bytes.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const [header, first, second] = parseCsv(new TextDecoder().decode(bytes.slice(3)));
    expect(header.slice(0, 7)).toEqual([
      '#',
      'Time',
      'Author',
      'Comment',
      'Reply to',
      'Tag',
      'Status',
    ]);
    expect(first.slice(0, 7)).toEqual([
      '1',
      '0:00:12 - 0:00:15',
      'Ayşe Çelik',
      'Ses burada patlıyor, şöyle düzeltelim',
      '',
      'Teknik',
      'Open',
    ]);
    expect(second.slice(0, 7)).toEqual([
      '1',
      '0:00:12',
      'İsmail',
      'Tamam, düzeltiyorum',
      'Ayşe Çelik',
      '',
      // The reply's own flag is set, but only a root can be resolved in the app.
      'Open',
    ]);
    expect(first[9]).toBe(parent.id);
    expect(second[10]).toBe(parent.id);
  });

  it('downloads a PDF that keeps Turkish text, the tag and the reply, under an open thread', async () => {
    const { scenario } = await seedThread();
    const response = await request(scenario.version.id, 'format=pdf');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    const pages = await pdfPages(new Uint8Array(await response.arrayBuffer()));
    expect(pages).toHaveLength(1);
    for (const expected of [
      'Ayşe Çelik',
      'Teknik',
      'Ses burada patlıyor, şöyle düzeltelim',
      'İsmail',
      'Tamam, düzeltiyorum',
      '0:12',
      'to 0:15',
    ]) {
      expect(pages[0]).toContain(expected);
    }
    expect(pages[0]).not.toContain('Resolved');
  });

  it('returns JSON markers in frames for the editor plugins', async () => {
    const { scenario, parent } = await seedThread();
    const response = await request(scenario.version.id, 'format=markers&fps=25');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const { data } = await response.json();
    expect(data).toMatchObject({ versionNumber: scenario.version.versionNumber, fps: '25' });
    expect(data.markers).toHaveLength(1);
    expect(data.markers[0]).toMatchObject({
      startFrame: 300,
      durationFrames: 75,
      name: 'Ayşe Çelik: Ses burada patlıyor, şöyle düzeltelim (+1)',
      premiereColor: 'RED',
      resolveColor: 'Red',
      done: false,
    });
    expect(data.markers[0].commentIds).toHaveLength(2);
    expect(data.markers[0].commentIds[0]).toBe(parent.id);
    expect(data.markers[0].comments).toBe(
      'Ayşe Çelik [Teknik]: Ses burada patlıyor, şöyle düzeltelim\n↳ İsmail (resolved): Tamam, düzeltiyorum'
    );
  });

  it('leaves resolved threads out of the markers when asked', async () => {
    const { scenario } = await seedThread();
    await createComment({
      versionId: scenario.version.id,
      guestName: 'Done',
      content: 'Already fixed',
      timestamp: 40,
      isResolved: true,
    });
    const names = async (query: string) => {
      const response = await request(scenario.version.id, `format=markers&fps=25${query}`);
      expect(response.status).toBe(200);
      return (await response.json()).data.markers.map((marker: { name: string }) => marker.name);
    };
    expect(await names('')).toHaveLength(2);
    expect(await names('&includeResolved=false')).toEqual([
      'Ayşe Çelik: Ses burada patlıyor, şöyle düzeltelim (+1)',
    ]);
  });

  it('gives markers to a reviewer only when the project allows downloads', async () => {
    const { scenario } = await seedThread();
    const reviewer = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: reviewer.id });
    await db.project.update({
      where: { id: scenario.project.id },
      data: { allowDownloads: false },
    });
    signedInAs(reviewer);
    const refused = await request(scenario.version.id, 'format=markers&fps=25');
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain('Ses burada');
    // The same reviewer still gets the CSV; only the editor plugins follow the download rule.
    expect((await request(scenario.version.id, 'format=csv')).status).toBe(200);

    await db.project.update({ where: { id: scenario.project.id }, data: { allowDownloads: true } });
    const allowed = await request(scenario.version.id, 'format=markers&fps=25');
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).data.markers).toHaveLength(1);

    // The owner edits the project, so downloads being off never stops them.
    await db.project.update({
      where: { id: scenario.project.id },
      data: { allowDownloads: false },
    });
    signedInAs(scenario.owner);
    expect((await request(scenario.version.id, 'format=markers&fps=25')).status).toBe(200);
  });

  it('refuses markers for an image', async () => {
    const { scenario } = await seedThread();
    await db.video.update({ where: { id: scenario.video.id }, data: { mediaType: 'IMAGE' } });
    const response = await request(scenario.version.id, 'format=markers&fps=25');
    expect(response.status).toBe(400);
  });

  it('refuses markers without a supported frame rate', async () => {
    const { scenario } = await seedThread();
    for (const query of ['format=markers', 'format=markers&fps=29.97']) {
      const response = await request(scenario.version.id, query);
      expect(response.status).toBe(400);
    }
  });
});
