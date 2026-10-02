import { describe, expect, it } from 'vitest';
import {
  buildNleComments,
  nleTimecode,
  parseNleOptions,
  secondsToNleFrames,
  selectNleThreads,
} from '@/lib/nle-comment-export';
import type { ExportCommentRow } from '@/lib/comment-export';
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
    'İpek 中文 🎬 & <marker><in>0</in></marker> " \'\r\n001 001 V C\n|C:ResolveColorRed |M:Injected |D:999\t\u0000\u0001\u2028\ud800';
  const rows = [
    row({ content: hostile, timestampEnd: 3 }),
    row({
      commentId: 'reply',
      parentCommentId: 'parent',
      level: 1,
      timestamp: 1.001,
      content: 'Reply\nSecond line',
      isResolved: true,
    }),
    row({ commentId: 'same', content: 'Same frame', timestampEnd: 4 }),
    row({ commentId: 'later', timestamp: 5 }),
  ];
  it('round trips all rows through XML without injecting nodes or external references', () => {
    const { doc, markers } = parseMarkerXml(buildNleComments(rows, hostile, 'xml', options));
    expect(markers).toHaveLength(2);
    expect(markers[0]).toEqual({ start: 24, end: 96, entries: rows.slice(0, 3) });
    expect(markers[1]).toEqual({ start: 120, end: 121, entries: [rows[3]] });
    expect(doc.querySelectorAll('marker')).toHaveLength(2);
    expect(doc.querySelectorAll('file, pathurl, effect')).toHaveLength(0);
    expect(doc.querySelector('sequence > duration')!.textContent).toBe('121');
    expect(doc.querySelector('sequence > name')!.textContent).toContain('<marker>');
  });
  it('round trips same-frame ranges, threads and hostile text in EDL without injecting directives', () => {
    const events = parseMarkerEdl(buildNleComments(rows, hostile, 'edl', options));
    expect(events).toEqual([
      { timecode: '01:00:01:00', out: '01:00:01:01', duration: 72, entries: rows.slice(0, 3) },
      { timecode: '01:00:05:00', out: '01:00:05:01', duration: 1, entries: [rows[3]] },
    ]);
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
