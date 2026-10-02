import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { GET } from '@/app/api/versions/[versionId]/comments/export/route';
import { createComment, seedVersion } from '../factories';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import { parseCsv, pdfPages } from '../helpers/export-readers';
import { parseFcpxml } from '../helpers/nle-parser';

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

  it('downloads an FCPXML project with a to-do marker per thread', async () => {
    const { scenario } = await seedThread();
    const response = await request(
      scenario.version.id,
      'format=fcpxml&fps=25&origin=00%3A00%3A00%3A00&dropFrame=false'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/\.fcpxml"$/);
    const { markers } = parseFcpxml(await response.text());
    expect(markers).toEqual([
      {
        start: '300/25s',
        duration: '75/25s',
        value: 'Ayşe Çelik: Ses burada patlıyor, şöyle düzeltelim (+1)',
        completed: '0',
        note: 'Ayşe Çelik [Teknik]: Ses burada patlıyor, şöyle düzeltelim\n↳ İsmail (resolved): Tamam, düzeltiyorum',
      },
    ]);
  });
});
