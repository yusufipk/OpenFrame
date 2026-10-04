import { describe, expect, it } from 'vitest';
import {
  buildNleComments,
  nleTimecode,
  parseNleOptions,
  buildPanelMarkers,
  premiereMarkerColor,
  premierePanelColor,
  resolveMarkerColor,
  secondsToNleFrames,
  selectNleThreads,
} from '@/lib/nle-comment-export';
import { flattenCommentsForExport, type ExportCommentRow } from '@/lib/comment-export';
import { parseMarkerEdl, parseMarkerXml } from '../../helpers/nle-parser';

const options = { fps: '24', origin: '01:00:00:00', dropFrame: false };
function row(overrides: Partial<ExportCommentRow> = {}): ExportCommentRow {
  return {
    commentId: 'parent',
    parentCommentId: null,
    level: 0,
    authorName: 'İpek 🎬',
    authorType: 'user',
    content: 'Hello',
    timestamp: 1,
    timestampEnd: null,
    tag: 'Review',
    isResolved: false,
    hasVoiceNote: false,
    voiceDuration: null,
    hasImageAttachment: false,
    hasAnnotation: false,
    createdAtIso: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('NLE timing', () => {
  it.each([
    ['24000/1001', 1001, 24000],
    ['30000/1001', 1001, 30000],
    ['60000/1001', 1001, 60000],
    ['24000/1001', 80000, 1918082],
    ['30000/1001', 80000, 2397602],
    ['60000/1001', 80000, 4795205],
    ['24', 0.0625, 2],
    ['25', 0.02, 1],
    ['30', 1, 30],
    ['48', 1, 48],
    ['50', 1, 50],
    ['60', 1, 60],
  ])('converts %s fps exactly', (fps, seconds, frames) => {
    expect(secondsToNleFrames(seconds, parseNleOptions({ ...options, fps }))).toBe(frames);
  });
  it.each([
    ['30000/1001', 1799, '00:00:59;29'],
    ['30000/1001', 1800, '00:01:00;02'],
    ['30000/1001', 17982, '00:10:00;00'],
    ['30000/1001', 107892, '01:00:00;00'],
    ['60000/1001', 3599, '00:00:59;59'],
    ['60000/1001', 3600, '00:01:00;04'],
    ['60000/1001', 35964, '00:10:00;00'],
    ['60000/1001', 215784, '01:00:00;00'],
  ])('formats drop frame %s at %s', (fps, frame, tc) => {
    expect(
      nleTimecode(frame, parseNleOptions({ fps, origin: '00:00:00;00', dropFrame: true }))
    ).toBe(tc);
  });
  it('parses a DF origin as actual frames, with no offset applied to XML marker positions', () => {
    const opts = { fps: '30000/1001', origin: '01:00:00;00', dropFrame: true };
    const { doc, markers } = parseMarkerXml(
      buildNleComments([row({ timestamp: 1001 })], 'Title', 'xml', opts)
    );
    expect(doc.querySelector('sequence > timecode > frame')!.textContent).toBe('107892');
    expect(doc.querySelector('sequence > rate > timebase')!.textContent).toBe('30');
    expect(doc.querySelector('sequence > rate > ntsc')!.textContent).toBe('TRUE');
    expect(markers[0].start).toBe(30000);
    expect(
      parseMarkerEdl(buildNleComments([row({ timestamp: 1001 })], '', 'edl', opts))[0].timecode
    ).toBe('01:16:41;00');
  });
  it.each([
    { fps: '29.97' },
    { fps: '0' },
    { fps: '24', dropFrame: true },
    { origin: '24:00:00:00' },
    { origin: '00:60:00:00' },
    { origin: '00:00:00:24' },
    { origin: '0:00:00:00' },
    { fps: '30000/1001', origin: '00:01:00;00', dropFrame: true },
    { fps: '60000/1001', origin: '00:01:00;03', dropFrame: true },
    { origin: '00:00:00;00' },
  ])('rejects invalid options %j', (override) => {
    expect(() => parseNleOptions({ ...options, ...override })).toThrow();
  });
  it.each([NaN, Infinity, -1, 86401])('rejects invalid seconds %s', (timestamp) => {
    expect(() => buildNleComments([row({ timestamp })], '', 'edl', options)).toThrow();
  });
  it('refuses reversed ranges and overflow rather than moving or losing markers', () => {
    expect(() => buildNleComments([row({ timestampEnd: 0 })], '', 'xml', options)).toThrow();
    expect(() =>
      buildNleComments([row({ timestamp: 1 })], '', 'edl', { ...options, origin: '23:59:59:00' })
    ).toThrow();
  });
});

describe('NLE serializers', () => {
  const hostile =
    'İpek 中文 🎬 & <marker><in>0</in></marker> " \'\r\n001 001 V C\n|C:ResolveColorRed |M:Injected |D:999\t\u0000\u0001 \ud800';
  // Input order is creation order: the second root predates the replies, but the
  // marker still lists each reply under the comment it answers.
  const rows = [
    row({ content: hostile, timestampEnd: 3 }),
    row({ commentId: 'same', authorName: 'Elif', content: 'Same frame', tag: '', timestampEnd: 4 }),
    row({
      commentId: 'reply',
      parentCommentId: 'parent',
      level: 1,
      authorName: 'Ahmet',
      tag: '',
      timestamp: 1.001,
      content: 'Reply\nSecond line',
      isResolved: true,
    }),
    row({
      commentId: 'nested',
      parentCommentId: 'reply',
      level: 1,
      authorName: 'Elif',
      tag: '',
      content: 'Nested',
    }),
    row({ commentId: 'later', timestamp: 5, content: 'Later', hasVoiceNote: true }),
  ];
  it('writes readable XML marker text in thread order without injecting nodes or external references', () => {
    const { doc, markers } = parseMarkerXml(buildNleComments(rows, hostile, 'xml', options));
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      start: 24,
      end: 96,
      name: 'İpek 🎬: İpek 中文 🎬 & <marker><in>0</in></marker> " \' (+3)',
      comment: [
        'İpek 🎬 [Review]: İpek 中文 🎬 & <marker><in>0</in></marker> " \'',
        '001 001 V C',
        '|C:ResolveColorRed |M:Injected |D:999\t\\u0000\\u0001 \\ud800',
        '↳ Ahmet (resolved): Reply',
        '  Second line',
        '  ↳ Elif: Nested',
        'Elif: Same frame',
      ].join('\n'),
    });
    expect(markers[1]).toMatchObject({
      start: 120,
      end: 121,
      name: 'İpek 🎬: Later',
      comment: 'İpek 🎬 [Review] (voice note): Later',
    });
    expect(doc.querySelectorAll('marker')).toHaveLength(2);
    expect(doc.querySelectorAll('file, pathurl, effect')).toHaveLength(0);
    expect(doc.querySelector('sequence > duration')!.textContent).toBe('121');
    expect(doc.querySelector('sequence > name')!.textContent).toContain('<marker>');
  });
  it('writes one readable EDL line per marker, dropping emoji and neutralising directives', () => {
    const events = parseMarkerEdl(buildNleComments(rows, hostile, 'edl', options));
    expect(events).toEqual([
      {
        timecode: '01:00:01:00',
        out: '01:00:01:01',
        duration: 72,
        color: 'Cyan',
        text:
          'İpek [Review]: İpek 中文 & <marker><in>0</in></marker> " \' 001 001 V C ¦C:ResolveColorRed ¦M:Injected ¦D:999' +
          ' / ↳ Ahmet (resolved): Reply Second line / ↳ Elif: Nested / Elif: Same frame',
      },
      {
        timecode: '01:00:05:00',
        out: '01:00:05:01',
        duration: 1,
        color: 'Cyan',
        text: 'İpek [Review] (voice note): Later',
      },
    ]);
  });
  it('names the author a reply answers when its parent is on another marker', () => {
    // Carol answered Alice at a later frame, before Bob commented there: the 2s marker
    // must not present Carol as a reply to Bob, nor indent her under nothing.
    const crossRows = [
      row({ commentId: 'alice', authorName: 'Alice', tag: '', content: 'At one' }),
      row({
        commentId: 'carol',
        parentCommentId: 'alice',
        authorName: 'Carol',
        tag: '',
        tagColor: '#3B82F6',
        timestamp: 2,
        content: 'Answer',
      }),
      row({ commentId: 'bob', authorName: 'Bob', tag: '', timestamp: 2, content: 'At two' }),
    ];
    const { markers } = parseMarkerXml(buildNleComments(crossRows, '', 'xml', options));
    expect(markers[1].comment).toBe('Carol (reply to Alice): Answer\nBob: At two');
    expect(markers[1].name).toBe('Carol: Answer (+1)');
    expect(parseMarkerEdl(buildNleComments(crossRows, '', 'edl', options))[1]).toMatchObject({
      color: 'Blue',
      text: 'Carol (reply to Alice): Answer / Bob: At two',
    });
  });
  it('names a marker after its attachment when the first comment has no text', () => {
    const [marker] = parseMarkerXml(
      buildNleComments(
        [row({ authorName: 'A', tag: '', content: '', hasVoiceNote: true })],
        '',
        'xml',
        options
      )
    ).markers;
    expect(marker.name).toBe('A: (voice note)');
  });
  it('treats C1 line breaks (NEL) as spaces so EDL text stays on its own line', () => {
    const [event] = parseMarkerEdl(
      buildNleComments(
        [row({ authorName: 'A', tag: '', content: 'a\u0085\u009b|C:ResolveColorRed b' })],
        '',
        'edl',
        options
      )
    );
    expect(event.text).toBe('A: a ¦C:ResolveColorRed b');
  });
  it('clips only the XML marker name; the comment keeps the full text', () => {
    const long = 'x'.repeat(200);
    const [marker] = parseMarkerXml(
      buildNleComments([row({ authorName: 'A', content: long, tag: '' })], '', 'xml', options)
    ).markers;
    expect(marker.name).toBe(`A: ${'x'.repeat(76)}…`);
    expect(marker.comment).toBe(`A: ${long}`);
  });
  it('sorts markers by their frame even when input rows are reversed', () => {
    const unsorted = [row({ timestamp: 5 }), row({ timestamp: 1 })];
    expect(
      parseMarkerEdl(buildNleComments(unsorted, '', 'edl', options)).map(
        (marker) => marker.timecode
      )
    ).toEqual(['01:00:01:00', '01:00:05:00']);
    expect(
      parseMarkerXml(buildNleComments(unsorted, '', 'xml', options)).markers.map(
        (marker) => marker.start
      )
    ).toEqual([24, 120]);
  });

  it('supports empty exports and refuses more than 999 EDL events without truncation', () => {
    expect(parseMarkerEdl(buildNleComments([], '', 'edl', options))).toEqual([]);
    expect(parseMarkerXml(buildNleComments([], '', 'xml', options)).markers).toEqual([]);
    const many = Array.from({ length: 1000 }, (_, i) => row({ timestamp: i }));
    expect(() => buildNleComments(many, '', 'edl', options)).toThrow('999');
    expect(parseMarkerXml(buildNleComments(many, '', 'xml', options)).markers).toHaveLength(1000);
  });
  it('refuses a cyclic thread inside one marker instead of dropping its comments', () => {
    const cyclic = [
      row({ commentId: 'a', parentCommentId: 'b' }),
      row({ commentId: 'b', parentCommentId: 'a' }),
    ];
    expect(() => buildNleComments(cyclic, '', 'xml', options)).toThrow('cyclic');
  });
});

describe('NLE marker colors', () => {
  it.each([
    ['#3B82F6', 'Blue', 4294741314],
    ['#EF4444', 'Red', 4281740498],
    ['#E11D48', 'Red', 4281740498],
    ['#8B5CF6', 'Purple', 4289825711],
    ['#EC4899', 'Pink', 4289825711],
    ['#22C55E', 'Green', 4281828977],
    ['#F59E0B', 'Yellow', 4281049552],
    ['#F97316', 'Yellow', 4280578025],
    ['#22D3EE', 'Cyan', 4292277273],
    ['#6B7280', 'Cocoa', 4294967295],
    ['#F3F4F6', 'Cream', 4294967295],
  ])('maps tag color %s to Resolve %s and Premiere %i', (hex, resolve, premiere) => {
    expect(resolveMarkerColor(hex)).toBe(resolve);
    expect(premiereMarkerColor(hex)).toBe(premiere);
  });
  it('colors a marker from its first comment, falling back to the player colors', () => {
    const colored = [
      // Listed first but a reply: the comment it answers decides the color.
      row({ commentId: 'reply', parentCommentId: 'parent', tagColor: '#3B82F6' }),
      row({ tagColor: '#EF4444' }),
      row({ commentId: 'resolved', timestamp: 2, tag: '', tagColor: null, isResolved: true }),
      row({ commentId: 'open', timestamp: 3, tag: '', tagColor: null }),
    ];
    expect(
      parseMarkerEdl(buildNleComments(colored, '', 'edl', options)).map((event) => event.color)
    ).toEqual(['Red', 'Green', 'Cyan']);
    const { markers } = parseMarkerXml(buildNleComments(colored, '', 'xml', options));
    expect(markers.map((marker) => marker.pproColor)).toEqual([4281740498, 4281828977, 4292277273]);
  });
});

describe('NLE marker text edge cases', () => {
  it('orders sibling replies, indents continuations at every depth and splits on lone CR', () => {
    const tree = [
      row({ authorName: 'P', tag: '', content: 'root' }),
      row({
        commentId: 'r1',
        parentCommentId: 'parent',
        authorName: 'R1',
        tag: '',
        content: 'a\rb',
      }),
      row({
        commentId: 'r2',
        parentCommentId: 'parent',
        authorName: 'R2',
        tag: '',
        content: 'e\n',
      }),
      row({ commentId: 'n', parentCommentId: 'r1', authorName: 'N', tag: '', content: 'c\nd' }),
    ];
    const [marker] = parseMarkerXml(buildNleComments(tree, '', 'xml', options)).markers;
    expect(marker.comment).toBe(
      ['P: root', '↳ R1: a', '  b', '  ↳ N: c', '    d', '↳ R2: e'].join('\n')
    );
  });
  it('names every attachment kind', () => {
    const [marker] = parseMarkerXml(
      buildNleComments(
        [
          row({
            authorName: 'A',
            tag: '',
            content: 'x',
            hasImageAttachment: true,
            hasAnnotation: true,
          }),
        ],
        '',
        'xml',
        options
      )
    ).markers;
    expect(marker.comment).toBe('A (image) (drawing): x');
  });
  it('drops joiners and variation selectors and spaces out DEL in EDL text', () => {
    const [event] = parseMarkerEdl(
      buildNleComments(
        [row({ authorName: 'A', tag: '', content: 'a❤️ ok a‍b c\u007fd' })],
        '',
        'edl',
        options
      )
    );
    expect(event.text).toBe('A: a❤ ok ab c d');
  });
  it('clips the XML name at exactly 80 code points, never inside a surrogate pair', () => {
    const name = (content: string) =>
      parseMarkerXml(buildNleComments([row({ authorName: 'A', content })], '', 'xml', options))
        .markers[0].name;
    expect(name('x'.repeat(77))).toBe(`A: ${'x'.repeat(77)}`);
    expect(name(`${'x'.repeat(75)}🎬yyyy`)).toBe(`A: ${'x'.repeat(75)}🎬…`);
    expect(name(`${'x'.repeat(75)} ${'y'.repeat(10)}`)).toBe(`A: ${'x'.repeat(75)}…`);
  });
  it('refuses a cycle that sits beside a valid root in the same marker', () => {
    const rows = [
      row(),
      row({ commentId: 'a', parentCommentId: 'b' }),
      row({ commentId: 'b', parentCommentId: 'a' }),
    ];
    expect(() => buildNleComments(rows, '', 'edl', options)).toThrow('cyclic');
  });
});

describe('NLE marker color boundaries', () => {
  it.each([
    ['#B0A090', 'Yellow', 4280578025], // saturation 0.17: just above the neutral cut
    ['#808080', 'Cream', 4294967295], // lightness 0.502
    ['#7F7F7F', 'Cocoa', 4294967295], // lightness 0.498
    ['#FF8800', 'Yellow', 4280578025], // hue 32: Premiere orange
    ['#FF9100', 'Yellow', 4281049552], // hue 34: Premiere yellow
    ['#FF3300', 'Red', 4281740498], // hue 12
    ['#00BFFF', 'Cyan', 4292277273], // hue 195
    ['#0088FF', 'Blue', 4294741314], // hue 208
    ['#C026D3', 'Pink', 4289825711], // hue 293
  ])('maps %s to Resolve %s and Premiere %i', (hex, resolve, premiere) => {
    expect(resolveMarkerColor(hex)).toBe(resolve);
    expect(premiereMarkerColor(hex)).toBe(premiere);
  });
  it('carries the tag color for replies as well as top-level comments', () => {
    const base = {
      parentId: null,
      content: 'x',
      timestamp: 1,
      timestampEnd: null,
      isResolved: false,
      voiceUrl: null,
      voiceDuration: null,
      imageUrl: null,
      annotationData: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      author: { name: 'A' },
      guestName: null,
    };
    const rows = flattenCommentsForExport([
      {
        ...base,
        id: 'root',
        tag: { name: 'Red', color: '#EF4444' },
        replies: [
          { ...base, id: 'reply', parentId: 'root', tag: { name: 'Blue', color: '#3B82F6' } },
        ],
      },
    ]);
    expect(rows.map((r) => r.tagColor)).toEqual(['#EF4444', '#3B82F6']);
  });
});

describe('NLE nested threads', () => {
  it('keeps arbitrary depth and actual parent IDs while filtering by root state', () => {
    const rows = [
      row(),
      row({ commentId: 'child', parentCommentId: 'parent', level: 1, isResolved: true }),
      row({ commentId: 'grandchild', parentCommentId: 'child', level: 1 }),
      row({ commentId: 'hidden', isResolved: true }),
      row({ commentId: 'hidden-child', parentCommentId: 'hidden', level: 1 }),
    ];
    expect(selectNleThreads(rows, true)).toEqual(rows);
    expect(selectNleThreads([...rows].reverse(), false)).toEqual(rows.slice(0, 3).reverse());
  });
  it('rejects incomplete or cyclic threads instead of silently omitting comments', () => {
    expect(() => selectNleThreads([row({ parentCommentId: 'missing' })], true)).toThrow(
      'incomplete'
    );
    expect(() =>
      selectNleThreads(
        [row({ parentCommentId: 'child' }), row({ commentId: 'child', parentCommentId: 'parent' })],
        true
      )
    ).toThrow('cyclic');
  });
});

describe('editor panel markers', () => {
  it.each([
    ['#3B82F6', 'BLUE'],
    ['#EF4444', 'RED'],
    ['#E11D48', 'RED'],
    ['#8B5CF6', 'MAGENTA'],
    ['#EC4899', 'MAGENTA'],
    ['#22C55E', 'GREEN'],
    ['#F59E0B', 'YELLOW'],
    ['#F97316', 'ORANGE'],
    ['#22D3EE', 'CYAN'],
    ['#6B7280', null],
    ['#F3F4F6', null],
  ])('maps tag color %s to the Premiere UXP color %s', (hex, name) => {
    expect(premierePanelColor(hex)).toBe(name);
  });

  it('puts every hue in the same band for the XML color and the panel color', () => {
    const names: Record<number, string> = {
      4281740498: 'RED',
      4280578025: 'ORANGE',
      4281049552: 'YELLOW',
      4281828977: 'GREEN',
      4292277273: 'CYAN',
      4294741314: 'BLUE',
      4289825711: 'MAGENTA',
    };
    const hex = (hue: number) => {
      const channel = (n: number) => {
        const k = (n + hue / 30) % 12;
        const value = 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(value * 255)
          .toString(16)
          .padStart(2, '0');
      };
      return `#${channel(0)}${channel(8)}${channel(4)}`;
    };
    for (let hue = 0; hue < 360; hue++) {
      expect([hue, premierePanelColor(hex(hue))]).toEqual([
        hue,
        names[premiereMarkerColor(hex(hue))],
      ]);
    }
  });

  it('numbers the markers in timeline order whatever order the comments come in', () => {
    const markers = buildPanelMarkers(
      [
        row({ commentId: 'late', authorName: 'Late', timestamp: 9 }),
        row({ commentId: 'early', authorName: 'Early', timestamp: 1 }),
      ],
      '25'
    );
    expect(markers.map((marker) => [marker.name, marker.startFrame])).toEqual([
      ['Marker 1', 25],
      ['Marker 2', 225],
    ]);
  });

  it('groups by frame and carries the same text, color and done state as the files', () => {
    const markers = buildPanelMarkers(
      [
        row({ authorName: 'Ann', tag: 'Fix', tagColor: '#EF4444', timestamp: 1, timestampEnd: 2 }),
        row({
          commentId: 'reply',
          parentCommentId: 'parent',
          authorName: 'Bo',
          tag: '',
          content: 'ok',
        }),
        row({
          commentId: 'late',
          authorName: 'Cem',
          tag: '',
          tagColor: null,
          timestamp: 10.01,
          isResolved: true,
        }),
      ],
      '25'
    );
    expect(markers).toEqual([
      {
        startFrame: 25,
        durationFrames: 25,
        name: 'Marker 1',
        comments: 'Ann [Fix]: Hello\n↳ Bo: ok',
        color: '#EF4444',
        premiereColor: 'RED',
        resolveColor: 'Red',
        done: false,
        commentIds: ['parent', 'reply'],
      },
      {
        startFrame: 250,
        durationFrames: 1,
        name: 'Marker 2',
        comments: 'Cem (resolved): Hello',
        color: '#22C55E',
        premiereColor: 'GREEN',
        resolveColor: 'Green',
        done: true,
        commentIds: ['late'],
      },
    ]);
  });

  it('marks a marker done only when every thread it opens is resolved at its root', () => {
    const done = (input: ExportCommentRow[]) =>
      buildPanelMarkers(input, '25').map((marker) => marker.done);
    // Two threads on one frame: the first resolved, the second still open.
    expect(
      done([row({ isResolved: true }), row({ commentId: 'open', isResolved: false })])
    ).toEqual([false]);
    // A reply on its own frame follows its resolved root, not its own flag.
    expect(
      done([
        row({ isResolved: true }),
        row({ commentId: 'late', parentCommentId: 'parent', timestamp: 3, isResolved: false }),
      ])
    ).toEqual([true, true]);
    // A resolved reply under an open root leaves the thread open.
    expect(
      done([row(), row({ commentId: 'r', parentCommentId: 'parent', isResolved: true })])
    ).toEqual([false]);
  });

  it('counts frames at exact NTSC ratios and rejects an unsupported rate', () => {
    // 3600 s at 30000/1001 is 107892.1 frames, not 108000.
    expect(buildPanelMarkers([row({ timestamp: 3600 })], '30000/1001')[0].startFrame).toBe(107892);
    expect(() => buildPanelMarkers([row()], '29.97')).toThrow('supported frame rate');
  });
});
