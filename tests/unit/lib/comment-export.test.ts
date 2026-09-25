import { describe, expect, it } from 'vitest';
import {
  buildCommentsCsv,
  buildCommentsPdf,
  buildExportFileBaseName,
  flattenCommentsForExport,
  type ExportCommentRow,
} from '@/lib/comment-export';

type FlattenInput = Parameters<typeof flattenCommentsForExport>[0];
type InputComment = FlattenInput[number];
type InputReply = InputComment['replies'][number];

function reply(overrides: Partial<InputReply> = {}): InputReply {
  return {
    id: 'reply-1',
    parentId: 'comment-1',
    content: 'A reply',
    timestamp: 5,
    timestampEnd: null,
    isResolved: false,
    voiceUrl: null,
    voiceDuration: null,
    imageUrl: null,
    annotationData: null,
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    author: { name: 'Replier' },
    guestName: null,
    tag: null,
    ...overrides,
  };
}

function comment(overrides: Partial<InputComment> = {}): InputComment {
  return {
    id: 'comment-1',
    parentId: null,
    content: 'Looks good',
    timestamp: 12.5,
    timestampEnd: null,
    isResolved: false,
    voiceUrl: null,
    voiceDuration: null,
    imageUrl: null,
    annotationData: null,
    createdAt: new Date('2026-01-15T09:00:00.000Z'),
    author: { name: 'Alice' },
    guestName: null,
    tag: null,
    replies: [],
    ...overrides,
  };
}

function row(overrides: Partial<ExportCommentRow> = {}): ExportCommentRow {
  return {
    commentId: 'comment-1',
    parentCommentId: null,
    level: 0,
    authorName: 'Alice',
    authorType: 'user',
    content: 'Looks good',
    timestamp: 12.5,
    timestampEnd: null,
    tag: '',
    isResolved: false,
    hasVoiceNote: false,
    voiceDuration: null,
    hasImageAttachment: false,
    hasAnnotation: false,
    createdAtIso: '2026-01-15T09:00:00.000Z',
    ...overrides,
  };
}

type ExportMeta = Parameters<typeof buildCommentsCsv>[1];

const META: ExportMeta = { videoTitle: 'My Video', versionNumber: 2, versionLabel: 'Rough cut' };

function csvRows(rows: ExportCommentRow[], meta = META): string[][] {
  // Splitting on newlines is only valid for rows whose cells carry no newline,
  // so the multiline test parses its own output instead of using this helper.
  return buildCommentsCsv(rows, meta)
    .split('\n')
    .map((line) => line.split(','));
}

describe('buildExportFileBaseName', () => {
  it.each([
    ['My Video', 2, 'my-video-v2-comments'],
    ['My  Video', 1, 'my-video-v1-comments'],
    ['A---B', 1, 'a-b-v1-comments'],
    ['Trailing spaces   ', 3, 'trailing-spaces-v3-comments'],
    ['  Leading spaces', 3, 'leading-spaces-v3-comments'],
    ['Version 2.0 (final)', 7, 'version-2-0-final-v7-comments'],
  ])('turns %s v%s into %s', (title, version, expected) => {
    expect(buildExportFileBaseName(title, version)).toBe(expected);
  });

  it('falls back to a generic segment when the title has no usable characters', () => {
    expect(buildExportFileBaseName('!!!', 4)).toBe('comments-v4-comments');
    expect(buildExportFileBaseName('', 4)).toBe('comments-v4-comments');
  });

  it('strips non-ascii letters rather than transliterating them', () => {
    expect(buildExportFileBaseName('Ünlü Vidéo', 1)).toBe('nl-vid-o-v1-comments');
  });

  it('never lets a path separator survive into the file name', () => {
    expect(buildExportFileBaseName('../../etc/passwd', 1)).toBe('etc-passwd-v1-comments');
  });
});

describe('flattenCommentsForExport', () => {
  it('emits each comment immediately followed by its replies', () => {
    const rows = flattenCommentsForExport([
      comment({
        id: 'c1',
        replies: [reply({ id: 'r1', parentId: 'c1' }), reply({ id: 'r2', parentId: 'c1' })],
      }),
      comment({ id: 'c2', replies: [reply({ id: 'r3', parentId: 'c2' })] }),
    ]);

    expect(rows.map((entry) => entry.commentId)).toEqual(['c1', 'r1', 'r2', 'c2', 'r3']);
    expect(rows.map((entry) => entry.level)).toEqual([0, 1, 1, 0, 1]);
    expect(rows.map((entry) => entry.parentCommentId)).toEqual([null, 'c1', 'c1', null, 'c2']);
  });

  it('sets the parent id from the enclosing comment, not from the reply row', () => {
    const rows = flattenCommentsForExport([
      comment({ id: 'c1', replies: [reply({ id: 'r1', parentId: 'stale-parent' })] }),
    ]);

    expect(rows[1].parentCommentId).toBe('c1');
  });

  it('prefers the account name over the guest name', () => {
    const rows = flattenCommentsForExport([
      comment({ author: { name: 'Alice' }, guestName: 'Guest Alice' }),
    ]);

    expect(rows[0].authorName).toBe('Alice');
    expect(rows[0].authorType).toBe('user');
  });

  it('falls back to the guest name when there is no account', () => {
    const rows = flattenCommentsForExport([comment({ author: null, guestName: 'Guest Bob' })]);

    expect(rows[0].authorName).toBe('Guest Bob');
    expect(rows[0].authorType).toBe('guest');
  });

  it('falls back to Anonymous when neither name is present', () => {
    const rows = flattenCommentsForExport([comment({ author: null, guestName: null })]);

    expect(rows[0].authorName).toBe('Anonymous');
    expect(rows[0].authorType).toBe('guest');
  });

  it('keeps authorType as user when the account has no display name', () => {
    const rows = flattenCommentsForExport([
      comment({ author: { name: null }, guestName: 'Guest Bob' }),
    ]);

    expect(rows[0].authorName).toBe('Guest Bob');
    expect(rows[0].authorType).toBe('user');
  });

  it('normalises null content to an empty string', () => {
    expect(flattenCommentsForExport([comment({ content: null })])[0].content).toBe('');
  });

  it('normalises a missing tag to an empty string and keeps a present one', () => {
    const rows = flattenCommentsForExport([
      comment({ id: 'c1', tag: null }),
      comment({ id: 'c2', tag: { name: 'Technical' } }),
    ]);

    expect(rows.map((entry) => entry.tag)).toEqual(['', 'Technical']);
  });

  it('reduces attachment fields to booleans while keeping the voice duration', () => {
    const rows = flattenCommentsForExport([
      comment({
        voiceUrl: 'https://cdn/voice.webm',
        voiceDuration: 4.25,
        imageUrl: 'https://cdn/shot.png',
        annotationData: '[{"points":[]}]',
      }),
    ]);

    expect(rows[0]).toMatchObject({
      hasVoiceNote: true,
      hasImageAttachment: true,
      hasAnnotation: true,
      voiceDuration: 4.25,
    });
  });

  it('treats an empty annotation string as no annotation', () => {
    expect(flattenCommentsForExport([comment({ annotationData: '' })])[0].hasAnnotation).toBe(
      false
    );
  });

  it('serialises createdAt as an ISO string', () => {
    const rows = flattenCommentsForExport([
      comment({ createdAt: new Date('2026-03-04T05:06:07.008Z') }),
    ]);

    expect(rows[0].createdAtIso).toBe('2026-03-04T05:06:07.008Z');
  });

  it('returns an empty list for no comments', () => {
    expect(flattenCommentsForExport([])).toEqual([]);
  });

  it('carries the timestamp range through unchanged', () => {
    const rows = flattenCommentsForExport([comment({ timestamp: 12.5, timestampEnd: 18 })]);

    expect(rows[0].timestamp).toBe(12.5);
    expect(rows[0].timestampEnd).toBe(18);
  });
});

describe('buildCommentsCsv', () => {
  it('writes a fully quoted header row with 19 columns', () => {
    const header = csvRows([])[0];

    expect(header).toHaveLength(19);
    expect(header[0]).toBe('"video_title"');
    expect(header[header.length - 1]).toBe('"created_at_iso"');
    expect(header.every((cell) => cell.startsWith('"') && cell.endsWith('"'))).toBe(true);
  });

  it('emits one line per row plus the header', () => {
    expect(buildCommentsCsv([row(), row({ commentId: 'c2' })], META).split('\n')).toHaveLength(3);
  });

  it('repeats the video and version metadata on every row', () => {
    const lines = csvRows([row(), row({ commentId: 'c2' })]);

    expect(lines[1].slice(0, 3)).toEqual(['"My Video"', '"2"', '"Rough cut"']);
    expect(lines[2].slice(0, 3)).toEqual(['"My Video"', '"2"', '"Rough cut"']);
  });

  it('writes an empty cell for a null version label', () => {
    const lines = csvRows([row()], { ...META, versionLabel: null });

    expect(lines[1][2]).toBe('""');
  });

  it('doubles embedded double quotes', () => {
    const csv = buildCommentsCsv([row({ content: 'He said "ship it"' })], META);

    expect(csv).toContain('"He said ""ship it"""');
  });

  it('keeps a newline inside the quoted content cell', () => {
    const csv = buildCommentsCsv([row({ content: 'line one\nline two' })], META);

    expect(csv).toContain('"line one\nline two"');
  });

  it.each(['=SUM(A1:A9)', '+1+1', '-2+3', '@import', '  =cmd|calc', '\t=danger'])(
    'neutralises the spreadsheet formula %s with a leading apostrophe',
    (content) => {
      const csv = buildCommentsCsv([row({ content })], META);

      expect(csv).toContain(`"'${content}"`);
    }
  );

  it('leaves ordinary content untouched', () => {
    const csv = buildCommentsCsv([row({ content: 'Fix the audio at 0:12' })], META);

    expect(csv).toContain('"Fix the audio at 0:12"');
    expect(csv).not.toContain('"\'Fix');
  });

  it('writes the raw timestamp with three decimals', () => {
    expect(csvRows([row({ timestamp: 12.5 })])[1][8]).toBe('"12.500"');
  });

  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [59.9, '0:59'],
    [60, '1:00'],
    [65, '1:05'],
    [599, '9:59'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [36000, '10:00:00'],
  ])('formats %s seconds as %s', (timestamp, expected) => {
    expect(csvRows([row({ timestamp })])[1][9]).toBe(`"${expected}"`);
  });

  it('writes an empty cell for a null timestamp end and voice duration', () => {
    const line = csvRows([row({ timestampEnd: null, voiceDuration: null })])[1];

    expect(line[10]).toBe('""');
    expect(line[15]).toBe('""');
  });

  it('writes three decimals for a present timestamp end and voice duration', () => {
    const line = csvRows([row({ timestampEnd: 18, voiceDuration: 4.25 })])[1];

    expect(line[10]).toBe('"18.000"');
    expect(line[15]).toBe('"4.250"');
  });

  it('writes booleans as the literals true and false', () => {
    const line = csvRows([
      row({
        isResolved: true,
        hasVoiceNote: false,
        hasImageAttachment: true,
        hasAnnotation: false,
      }),
    ])[1];

    expect(line[11]).toBe('"true"');
    expect(line[14]).toBe('"false"');
    expect(line[16]).toBe('"true"');
    expect(line[17]).toBe('"false"');
  });

  // The formula guard prefixes an apostrophe to anything starting with =, +, - or @.
  // Applying it to a plain negative number stopped the spreadsheet reading the cell as a
  // number at all, which is what a negative timestamp is.
  it('leaves a negative number readable as a number', () => {
    expect(csvRows([row({ timestamp: -1 })])[1][8]).toBe(`"-1.000"`);
  });

  it('preserves the flattened thread order in the output', () => {
    const lines = csvRows([
      row({ commentId: 'c1' }),
      row({ commentId: 'r1', parentCommentId: 'c1', level: 1 }),
      row({ commentId: 'c2' }),
    ]);

    expect(lines.slice(1).map((line) => line[3])).toEqual(['"c1"', '"r1"', '"c2"']);
    expect(lines.slice(1).map((line) => line[5])).toEqual(['"0"', '"1"', '"0"']);
  });
});

describe('buildCommentsPdf', () => {
  function asText(rows: ExportCommentRow[], meta = META): string {
    return buildCommentsPdf(rows, meta).toString('utf8');
  }

  it('produces a PDF 1.4 document with a trailer', () => {
    const pdf = asText([row()]);

    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('/Type /Catalog');
    expect(pdf).toContain('startxref');
  });

  it('returns a Buffer', () => {
    expect(Buffer.isBuffer(buildCommentsPdf([row()], META))).toBe(true);
  });

  it('reports the entry count and the version label in the header block', () => {
    const pdf = asText([row(), row({ commentId: 'c2' })]);

    expect(pdf).toContain('Total Entries: 2');
    expect(pdf).toContain('Version: v2 \\(Rough cut\\)');
  });

  it('omits the parenthesised label when there is none', () => {
    const pdf = asText([row()], { ...META, versionLabel: null });

    expect(pdf).toContain('Version: v2');
    expect(pdf).not.toContain('Rough cut');
  });

  it('escapes backslashes and parentheses in the content stream', () => {
    const pdf = asText([row({ content: 'path C:\\temp (draft)' })]);

    expect(pdf).toContain('path C:\\\\temp \\(draft\\)');
  });

  it('replaces non-ascii characters with a question mark', () => {
    const pdf = asText([row({ content: 'Ünlü emoji test' })]);

    expect(pdf).toContain('?nl? emoji test');
  });

  it('marks a reply row differently from a top-level comment', () => {
    const pdf = asText([row({ level: 1, authorName: 'Replier' })]);

    expect(pdf).toContain('Reply');
  });

  it('renders the resolved, voice, image and annotation flags', () => {
    const pdf = asText([
      row({ isResolved: true, hasVoiceNote: true, hasImageAttachment: false, tag: 'Urgent' }),
    ]);

    expect(pdf).toContain('resolved=yes');
    expect(pdf).toContain('voice=yes');
    expect(pdf).toContain('image=no');
    expect(pdf).toContain('tag=Urgent');
  });

  it('omits the tag detail when the row has no tag', () => {
    expect(asText([row({ tag: '' })])).not.toContain('tag=');
  });

  it('produces a single page document for a short export', () => {
    expect(asText([row()])).toContain('/Count 1');
  });

  it('paginates once the line budget is exceeded', () => {
    const rows = Array.from({ length: 40 }, (_unused, i) => row({ commentId: `c${i}` }));
    const pdf = asText(rows);
    const count = /\/Count (\d+)/.exec(pdf)?.[1];

    expect(Number(count)).toBeGreaterThan(1);
  });

  it('still produces a valid document with no comments at all', () => {
    const pdf = asText([]);

    expect(pdf).toContain('Total Entries: 0');
    expect(pdf).toContain('/Count 1');
    expect(pdf.endsWith('%%EOF')).toBe(true);
  });

  it('wraps a very long comment across several text lines', () => {
    const longWord = 'x'.repeat(300);
    const pdf = asText([row({ content: longWord })]);
    const chunks = pdf.match(/x{90,}/g) ?? [];

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 96)).toBe(true);
  });
});

describe('still image exports', () => {
  it('leaves playback columns empty and labels the image in CSV and PDF', () => {
    const meta: ExportMeta = { ...META, mediaType: 'IMAGE' };
    const rows = csvRows([row({ timestamp: 0 })], meta);
    expect(rows[0][0]).toBe('"image_title"');
    expect(rows[1].slice(8, 11)).toEqual(['""', '""', '""']);
    const pdf = buildCommentsPdf([row({ timestamp: 0 })], meta).toString('utf8');
    expect(pdf).toContain('Image: My Video');
    expect(pdf).toContain('Comment by Alice');
    expect(pdf).not.toContain('00:00:00');
  });
});
