import { describe, expect, it } from 'vitest';
import {
  framesToSeconds,
  importDedupeKey,
  markerCommentContent,
  parseImportRequest,
  planMarkerImport,
} from '@/lib/editor-marker-import';

const marker = (startFrame: number, comments: string, extra = {}) => ({
  startFrame,
  durationFrames: 0,
  name: '',
  comments,
  ...extra,
});

describe('parseImportRequest', () => {
  it('fills in the optional marker fields', () => {
    expect(parseImportRequest({ fps: '25', markers: [{ startFrame: 10 }] })).toEqual({
      fps: '25',
      markers: [{ startFrame: 10, durationFrames: 0, name: '', comments: '' }],
    });
  });

  it.each([
    ['no body', null],
    ['a rounded NTSC rate', { fps: '29.97', markers: [{ startFrame: 0 }] }],
    ['no markers', { fps: '25', markers: [] }],
    ['markers that are not a list', { fps: '25', markers: { startFrame: 0 } }],
    ['501 markers', { fps: '25', markers: Array.from({ length: 501 }, () => ({ startFrame: 0 })) }],
    ['a negative frame', { fps: '25', markers: [{ startFrame: -1 }] }],
    ['a fractional frame', { fps: '25', markers: [{ startFrame: 1.5 }] }],
    ['a frame as text', { fps: '25', markers: [{ startFrame: '10' }] }],
    ['a fractional duration', { fps: '25', markers: [{ startFrame: 0, durationFrames: 0.5 }] }],
    ['a name that is not text', { fps: '25', markers: [{ startFrame: 0, name: 5 }] }],
    ['a marker that is not an object', { fps: '25', markers: ['x'] }],
  ])('refuses %s', (_label, body) => {
    expect(parseImportRequest(body)).toHaveProperty('error');
  });

  it('reads a null duration, name and note as empty', () => {
    expect(
      parseImportRequest({
        fps: '25',
        markers: [{ startFrame: 3, durationFrames: null, name: null, comments: null }],
      })
    ).toEqual({
      fps: '25',
      markers: [{ startFrame: 3, durationFrames: 0, name: '', comments: '' }],
    });
  });

  it('accepts exactly 500 markers', () => {
    const markers = Array.from({ length: 500 }, () => ({ startFrame: 0 }));
    expect(parseImportRequest({ fps: '25', markers })).not.toHaveProperty('error');
  });
});

describe('framesToSeconds', () => {
  it('uses the exact NTSC ratio', () => {
    expect(framesToSeconds(30, '30000/1001')).toBeCloseTo(1.001, 10);
    expect(framesToSeconds(250, '25')).toBe(10);
    expect(framesToSeconds(0, '24000/1001')).toBe(0);
  });
});

describe('markerCommentContent', () => {
  it('puts the name and the note on separate lines and drops whichever is empty', () => {
    expect(markerCommentContent({ name: 'Color', comments: 'Too warm' })).toBe('Color\nToo warm');
    expect(markerCommentContent({ name: '  ', comments: 'Too warm ' })).toBe('Too warm');
    expect(markerCommentContent({ name: 'Color', comments: '' })).toBe('Color');
    expect(markerCommentContent({ name: '', comments: 'a\r\nb\rc' })).toBe('a\nb\nc');
    expect(markerCommentContent({ name: '', comments: ' \n ' })).toBe('');
    expect(markerCommentContent({ name: 'A\u0000B', comments: '\u0000' })).toBe('AB');
  });
});

describe('planMarkerImport', () => {
  it('turns markers into comments with ranges and leaves out empty, long and late ones', () => {
    const plan = planMarkerImport(
      {
        fps: '25',
        markers: [
          marker(250, 'Cut here'),
          marker(0, ''),
          marker(50, 'x'.repeat(10_001)),
          marker(2600, 'After the end'),
          marker(500, 'Range', { durationFrames: 50 }),
          marker(750, 'One frame', { durationFrames: 1 }),
          marker(2400, 'Runs past the end', { durationFrames: 500 }),
          marker(60, 'x'.repeat(10_000)),
        ],
      },
      new Set(),
      100
    );
    expect(plan.create).toEqual([
      { index: 0, content: 'Cut here', timestamp: 10, timestampEnd: null },
      { index: 4, content: 'Range', timestamp: 20, timestampEnd: 22 },
      { index: 5, content: 'One frame', timestamp: 30, timestampEnd: null },
      { index: 6, content: 'Runs past the end', timestamp: 96, timestampEnd: 100 },
      { index: 7, content: 'x'.repeat(10_000), timestamp: 2.4, timestampEnd: null },
    ]);
    expect(plan.skipped).toEqual({ empty: 1, tooLong: 1, outOfRange: 1 });
    expect(plan.duplicates).toEqual([]);
  });

  it('keeps a marker starting exactly at the end of the version', () => {
    const plan = planMarkerImport({ fps: '25', markers: [marker(2500, 'Last')] }, new Set(), 100);
    expect(plan.create).toHaveLength(1);
  });

  it('places markers and ranges up to just under a day when the version length is unknown', () => {
    const plan = planMarkerImport(
      {
        fps: '25',
        markers: [
          marker(90000, 'Late'),
          marker(90000, 'Late range', { durationFrames: 50 }),
          marker(2_159_975, 'Runs into the last second', { durationFrames: 50 }),
          marker(2_159_976, 'Past the last second'),
        ],
      },
      new Set(),
      null
    );
    expect(plan.create).toEqual([
      { index: 0, content: 'Late', timestamp: 3600, timestampEnd: null },
      { index: 1, content: 'Late range', timestamp: 3600, timestampEnd: 3602 },
      { index: 2, content: 'Runs into the last second', timestamp: 86_399, timestampEnd: null },
    ]);
    expect(plan.skipped.outOfRange).toBe(1);
  });

  it('skips a marker with a huge field as too long and keeps the rest', () => {
    const parsed = parseImportRequest({
      fps: '25',
      markers: [
        { startFrame: 0, comments: 'x'.repeat(50_001) },
        { startFrame: 0, name: 'x'.repeat(50_001) },
        { startFrame: 25, comments: 'Fine' },
      ],
    });
    if ('error' in parsed) throw new Error(parsed.error);
    const plan = planMarkerImport(parsed, new Set(), null);
    expect(plan.skipped.tooLong).toBe(2);
    expect(plan.create.map((comment) => comment.content)).toEqual(['Fine']);
  });

  it('keeps a two-frame marker as a range', () => {
    const plan = planMarkerImport(
      { fps: '25', markers: [marker(25, 'Two', { durationFrames: 2 })] },
      new Set(),
      null
    );
    expect(plan.create[0].timestampEnd).toBe(1.08);
  });

  it('turns a range clamped down to its own start into a point', () => {
    const plan = planMarkerImport(
      { fps: '25', markers: [marker(2500, 'At the end', { durationFrames: 50 })] },
      new Set(),
      100
    );
    expect(plan.create).toEqual([
      { index: 0, content: 'At the end', timestamp: 100, timestampEnd: null },
    ]);
  });

  it('reports a marker already on the version, or sent twice, as a duplicate', () => {
    const existing = new Set([importDedupeKey(10, 'Cut here')]);
    const plan = planMarkerImport(
      {
        fps: '25',
        markers: [
          marker(250, 'Cut here'),
          marker(275, 'Twice'),
          marker(275, 'Twice'),
          marker(276, 'Twice'),
        ],
      },
      existing,
      null
    );
    expect(plan.duplicates).toEqual([0, 2]);
    expect(plan.create.map((comment) => comment.index)).toEqual([1, 3]);
  });

  it('matches a stored NTSC timestamp despite float error', () => {
    const stored = framesToSeconds(1799, '30000/1001');
    const existing = new Set([importDedupeKey(Number(stored.toFixed(12)), 'Fix')]);
    const plan = planMarkerImport(
      { fps: '30000/1001', markers: [marker(1799, 'Fix')] },
      existing,
      null
    );
    expect(plan.duplicates).toEqual([0]);
  });
});
