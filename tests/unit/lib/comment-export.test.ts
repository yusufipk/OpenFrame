import { describe, expect, it, vi } from 'vitest';
import {
  buildCommentsCsv,
  buildExportFileBaseName,
  flattenCommentsForExport,
  type ExportCommentRow,
} from '@/lib/comment-export';
import { buildCommentsPdf, fitLine, pdfDrawableText, wrapText } from '@/lib/comment-export-pdf';
import { parseCsv, pdfPages, pdfTextItems, type PdfTextItem } from '../../helpers/export-readers';

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

// A4 page width and the 48pt margins, written out rather than imported.
const RIGHT_EDGE = 595.28 - 48;
// Footers sit at 32pt; body text has to stay well above them.
const FOOTER_TOP = 48;

function find(items: PdfTextItem[], str: string): PdfTextItem {
  const item = items.find((entry) => entry.str === str);
  if (!item) throw new Error(`No text item "${str}" in ${items.map((i) => i.str).join(' | ')}`);
  return item;
}

function csv(rows: ExportCommentRow[], meta = META): string[][] {
  return parseCsv(buildCommentsCsv(rows, meta).replace(/^﻿/, ''));
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
  it('starts with a byte order mark and ends lines with CRLF so Excel reads UTF-8', () => {
    const text = buildCommentsCsv([row({ content: 'Çalışma ğüşİ' })], META);
    expect(text.startsWith('﻿"#","Time"')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.split('\r\n')).toHaveLength(3);
  });

  it('writes readable headers and one row per comment', () => {
    const [header, line] = csv([
      row({
        content: 'Çalışma ğüşİ',
        tag: 'Urgent',
        timestampEnd: 18,
        isResolved: true,
        hasVoiceNote: true,
        voiceDuration: 4.25,
        hasImageAttachment: true,
        hasAnnotation: true,
      }),
    ]);
    expect(header).toEqual([
      '#',
      'Time',
      'Author',
      'Comment',
      'Reply to',
      'Tag',
      'Status',
      'Attachments',
      'Created',
      'Comment ID',
      'Parent comment ID',
    ]);
    expect(line).toEqual([
      '1',
      '0:00:12 - 0:00:18',
      'Alice',
      'Çalışma ğüşİ',
      '',
      'Urgent',
      'Resolved',
      'Voice note (0:04), Image, Drawing',
      '2026-01-15 09:00 UTC',
      'comment-1',
      '',
    ]);
  });

  it('numbers threads, repeats the number on replies and names who a reply answers', () => {
    const lines = csv([
      row({ commentId: 'c1', authorName: 'Alice' }),
      row({ commentId: 'r1', parentCommentId: 'c1', level: 1, authorName: 'Bob' }),
      row({ commentId: 'r2', parentCommentId: 'c1', level: 1, authorName: 'Cem' }),
      row({ commentId: 'c2', authorName: 'Dee' }),
    ]).slice(1);
    expect(lines.map((line) => [line[0], line[2], line[4], line[10]])).toEqual([
      ['1', 'Alice', '', ''],
      ['1', 'Bob', 'Alice', 'c1'],
      ['1', 'Cem', 'Alice', 'c1'],
      ['2', 'Dee', '', ''],
    ]);
  });

  it('says Open for unresolved comments and lists a voice note without a known length', () => {
    const line = csv([row({ hasVoiceNote: true, voiceDuration: null })])[1];
    expect(line[6]).toBe('Open');
    expect(line[7]).toBe('Voice note');
  });

  it('gives a reply the status of its thread, not its own flag', () => {
    const lines = csv([
      row({ commentId: 'c1', isResolved: true }),
      row({ commentId: 'r1', parentCommentId: 'c1', level: 1, isResolved: false }),
      row({ commentId: 'c2', isResolved: false }),
      row({ commentId: 'r2', parentCommentId: 'c2', level: 1, isResolved: true }),
    ]).slice(1);
    expect(lines.map((line) => line[6])).toEqual(['Resolved', 'Resolved', 'Open', 'Open']);
  });

  it.each([
    ['-5', '-5'],
    ['-2.5', '-2.5'],
    ['+3', "'+3"],
  ])('writes the number %s as %s', (content, expected) => {
    expect(csv([row({ content })])[1][3]).toBe(expected);
  });

  it('keeps quotes and line breaks inside the comment cell', () => {
    const content = 'He said "ship it"\nthen left, quickly';
    expect(csv([row({ content })])[1][3]).toBe(content);
  });

  it.each(['=SUM(A1:A9)', '+1+1', '-2+3', '@import', '  =cmd|calc', '\t=danger'])(
    'neutralises the spreadsheet formula %s with a leading apostrophe',
    (content) => {
      expect(csv([row({ content })])[1][3]).toBe(`'${content}`);
    }
  );

  it('leaves ordinary content untouched', () => {
    expect(csv([row({ content: 'Fix the audio at 0:12' })])[1][3]).toBe('Fix the audio at 0:12');
  });

  it.each([
    [0, '0:00:00'],
    [9, '0:00:09'],
    [59.9, '0:00:59'],
    [60, '0:01:00'],
    [65, '0:01:05'],
    [599, '0:09:59'],
    [3599, '0:59:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [36000, '10:00:00'],
  ])('writes %s seconds as the clock time %s', (timestamp, expected) => {
    expect(csv([row({ timestamp })])[1][1]).toBe(expected);
  });

  it('leaves out the Time column for a still image', () => {
    const [header, line] = csv([row({ timestamp: 0 })], { ...META, mediaType: 'IMAGE' });
    expect(header.slice(0, 3)).toEqual(['#', 'Author', 'Comment']);
    expect(line.slice(0, 3)).toEqual(['1', 'Alice', 'Looks good']);
  });
});

describe('buildCommentsPdf', () => {
  it('draws the header, thread, tag, status, attachments and Turkish text', async () => {
    const pages = await pdfPages(
      await buildCommentsPdf(
        [
          row({
            content: 'Ünlü çalışma: İğde ağacı şöyle',
            tag: 'Urgent',
            tagColor: '#F59E0B',
            timestampEnd: 18,
            isResolved: true,
            hasVoiceNote: true,
            voiceDuration: 4.25,
          }),
          row({
            commentId: 'r1',
            parentCommentId: 'comment-1',
            level: 1,
            authorName: 'Bob',
            content: 'Tamam',
            timestamp: 47,
          }),
        ],
        META
      )
    );
    expect(pages).toHaveLength(1);
    const text = pages[0];
    for (const expected of [
      'My Video',
      'Version 2: Rough cut',
      '1 comment, 1 reply',
      '0:12',
      'to 0:18',
      'Alice',
      'Urgent',
      'Resolved',
      'Ünlü çalışma: İğde ağacı şöyle',
      'Voice note (0:04)',
      '2026-01-15 09:00 UTC',
      'Bob',
      'Tamam',
      'OpenFrame | My Video | v2',
      'Page 1 of 1',
    ]) {
      expect(text).toContain(expected);
    }
    // A reply sits under its thread's time; it prints none of its own.
    expect(text).not.toContain('0:47');
  });

  it('shows Resolved for a thread, never for a reply on its own flag', async () => {
    const [text] = await pdfPages(
      await buildCommentsPdf(
        [row(), row({ commentId: 'r1', parentCommentId: 'comment-1', level: 1, isResolved: true })],
        META
      )
    );
    expect(text).not.toContain('Resolved');
  });

  it('prints the version without a label and names a nameless author Anonymous', async () => {
    const [text] = await pdfPages(
      await buildCommentsPdf([row({ authorName: '🎬' })], { ...META, versionLabel: null })
    );
    expect(text).toContain('Version 2 | 1 comment, 0 replies');
    expect(text).not.toContain('null');
    expect(text).toContain('Anonymous');
  });

  it('drops characters the font cannot draw instead of printing boxes', async () => {
    const [text] = await pdfPages(await buildCommentsPdf([row({ content: 'ok 🎬 go' })], META));
    expect(text).toContain('ok go');
    expect(text).not.toContain('🎬');
  });

  it('wraps long comments inside the right margin', async () => {
    const long = `${'kelime '.repeat(80)}${'x'.repeat(200)}`;
    const items = await pdfTextItems(await buildCommentsPdf([row({ content: long })], META));
    const body = items.filter((item) => /kelime|xxx/.test(item.str));
    expect(body.length).toBeGreaterThan(4);
    for (const item of body) expect(item.x + item.width).toBeLessThanOrEqual(RIGHT_EDGE + 0.5);
    expect(
      body
        .map((item) => item.str)
        .join('')
        .replace(/\s/g, '')
    ).toContain('x'.repeat(200));
  });

  it('flows one very long comment across pages above the footer without losing a line', async () => {
    const words = Array.from({ length: 1600 }, (_unused, i) => `w${i}`).join(' ');
    const items = await pdfTextItems(await buildCommentsPdf([row({ content: words })], META));
    const body = items.filter((item) => /^w\d/.test(item.str));
    expect(new Set(body.map((item) => item.page)).size).toBeGreaterThan(1);
    for (const item of body) expect(item.y).toBeGreaterThanOrEqual(FOOTER_TOP + 18);
    expect(
      body
        .map((item) => item.str)
        .join(' ')
        .match(/w\d+/g)
    ).toHaveLength(1600);
    // The heading stays on the first page with the start of the text.
    expect(find(items, 'Alice').page).toBe(1);
    expect(body[0].page).toBe(1);
  });

  it('keeps every heading on the page that holds its first three lines', async () => {
    // Every word names its comment, so each wrapped line can be traced back to it.
    const rows = Array.from({ length: 50 }, (_unused, i) =>
      row({
        commentId: `c${i}`,
        authorName: `Author${i}`,
        content: Array.from({ length: 48 + (i % 7) * 9 }, () => `b${i}x`).join(' '),
      })
    );
    const items = await pdfTextItems(await buildCommentsPdf(rows, META));
    expect(Math.max(...items.map((item) => item.page))).toBeGreaterThan(2);
    for (let i = 0; i < 50; i++) {
      const heading = find(items, `Author${i}`);
      const lines = items.filter((item) => item.str.startsWith(`b${i}x`));
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect([i, ...lines.slice(0, 3).map((line) => line.page)]).toEqual([
        i,
        heading.page,
        heading.page,
        heading.page,
      ]);
    }
  });

  it('lays out author, tag, Resolved and the date left to right without overlap', async () => {
    const items = await pdfTextItems(
      await buildCommentsPdf(
        [
          row({
            authorName: 'Maximiliana Alexandra Featherstonehaugh-Smith of Somewhere Rather Far',
            tag: 'Color correction needed before the final delivery to the client',
            isResolved: true,
          }),
        ],
        META
      )
    );
    const author = items.find((item) => item.str.startsWith('Maximiliana'))!;
    const tag = items.find((item) => item.str.startsWith('Color correction'))!;
    const resolved = find(items, 'Resolved');
    const date = find(items, '2026-01-15 09:00 UTC');
    expect(author.str.endsWith('…')).toBe(true);
    expect(tag.str.endsWith('…')).toBe(true);
    expect(author.x + author.width).toBeLessThan(tag.x);
    expect(tag.x + tag.width).toBeLessThan(resolved.x);
    expect(resolved.x + resolved.width).toBeLessThan(date.x);
    expect(date.x + date.width).toBeLessThanOrEqual(RIGHT_EDGE + 0.5);
  });

  it('drops leading and trailing blank lines of a comment', async () => {
    const top = async (content: string) =>
      find(await pdfTextItems(await buildCommentsPdf([row({ content })], META)), 'Hello').y;
    expect(await top('\n\n  \nHello\n\n')).toBe(await top('Hello'));
  });

  it('starts a new page when comments overflow and numbers every page', async () => {
    const rows = Array.from({ length: 60 }, (_unused, i) =>
      row({ commentId: `c${i}`, content: `Comment number ${i}` })
    );
    const pages = await pdfPages(await buildCommentsPdf(rows, META));
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, index) => expect(page).toContain(`Page ${index + 1} of ${pages.length}`));
    const all = pages.join('\n');
    for (let i = 0; i < 60; i++) expect(all).toContain(`Comment number ${i}`);
  });

  it('produces a one-page document saying so when there are no comments', async () => {
    const pages = await pdfPages(await buildCommentsPdf([], META));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('No comments on this version.');
    expect(pages[0]).toContain('0 comments, 0 replies');
  });

  it('shows no timecode for a still image and starts the text at the margin', async () => {
    const items = await pdfTextItems(
      await buildCommentsPdf([row({ timestamp: 72 })], { ...META, mediaType: 'IMAGE' })
    );
    expect(items.some((item) => item.str.includes('1:12'))).toBe(false);
    expect(find(items, 'Looks good').x).toBeCloseTo(48, 1);
    expect(find(items, 'Alice').x).toBeCloseTo(48, 1);
  });

  it('retries loading the fonts after a failed read', async () => {
    vi.resetModules();
    let failures = 1;
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readFile: (...args: Parameters<typeof actual.readFile>) =>
          failures-- > 0 ? Promise.reject(new Error('EIO')) : actual.readFile(...args),
      };
    });
    try {
      const fresh = await import('@/lib/comment-export-pdf');
      await expect(fresh.buildCommentsPdf([row()], META)).rejects.toThrow('EIO');
      const [text] = await pdfPages(await fresh.buildCommentsPdf([row()], META));
      expect(text).toContain('Looks good');
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });
});

describe('PDF text helpers', () => {
  const measure = (value: string) => value.length;
  it('wraps on words, keeps explicit line breaks and splits words longer than a line', () => {
    expect(wrapText('aa bb cc\ndd', 5, measure)).toEqual(['aa bb', 'cc', 'dd']);
    expect(wrapText('abcdefghij k', 4, measure)).toEqual(['abcd', 'efgh', 'ij k']);
    expect(wrapText('', 5, measure)).toEqual(['']);
  });
  it('splits a very long word in linear time, measuring each distinct character once', () => {
    let calls = 0;
    const counted = (value: string) => {
      calls++;
      return value.length;
    };
    const lines = wrapText('ab'.repeat(5000), 80, counted);
    expect(lines).toHaveLength(125);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    // Two whole-word measurements plus one per distinct character.
    expect(calls).toBeLessThan(10);
  });
  it('clips one line with an ellipsis only when it does not fit', () => {
    expect(fitLine('abcdef', 6, measure)).toBe('abcdef');
    expect(fitLine('abc defgh', 6, measure)).toBe('abc d…');
    expect(fitLine('ab cdefgh', 4, measure)).toBe('ab…');
  });
  it('keeps supported characters, turns controls into spaces and drops the rest', () => {
    const supported = new Set(Array.from('abŞ ').map((char) => char.codePointAt(0)!));
    expect(pdfDrawableText('aŞ\tb\u0085a\n🎬b', supported)).toBe('aŞ b a\nb');
    expect(pdfDrawableText('a\u2028b\u2029a', supported)).toBe('a b a');
    expect(pdfDrawableText('a  b \t a', supported)).toBe('a b a');
  });
});
