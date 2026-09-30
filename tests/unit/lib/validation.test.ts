import { describe, expect, it } from 'vitest';
import {
  isSafeAppRelativePath,
  isValidHttpUrl,
  validateAnnotationStrokes,
  validateOptionalUrl,
  validateOptionalUrlOrAppPath,
  validateUrl,
} from '@/lib/validation';

const UUID = '11111111-2222-3333-4444-555555555555';

function stroke(overrides: Record<string, unknown> = {}) {
  return { points: [{ x: 1, y: 2 }], color: '#FF3B30', width: 4, ...overrides };
}

describe('validateAnnotationStrokes', () => {
  it('returns a normalised copy of a valid single stroke', () => {
    const input = [{ points: [{ x: 1.5, y: -2.25 }], color: '#0a0B0c', width: 3 }];

    expect(validateAnnotationStrokes(input)).toEqual([
      { points: [{ x: 1.5, y: -2.25 }], color: '#0a0B0c', width: 3 },
    ]);
  });

  it('returns fresh objects rather than the caller-supplied ones', () => {
    const point = { x: 1, y: 2 };
    const input = [{ points: [point], color: '#FF3B30', width: 4 }];

    const result = validateAnnotationStrokes(input);

    expect(result).not.toBe(input);
    expect(result?.[0]).not.toBe(input[0]);
    expect(result?.[0].points[0]).not.toBe(point);
  });

  it('accepts an empty stroke list', () => {
    expect(validateAnnotationStrokes([])).toEqual([]);
  });

  it('accepts a stroke with an empty point list', () => {
    expect(validateAnnotationStrokes([stroke({ points: [] })])).toEqual([
      { points: [], color: '#FF3B30', width: 4 },
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns null for %s input', (_label, value) => {
    expect(validateAnnotationStrokes(value)).toBeNull();
  });

  it.each([
    ['a plain object', { points: [] }],
    ['a string', '[]'],
    ['a number', 0],
    ['a boolean', true],
  ])('returns null when the payload is %s instead of an array', (_label, value) => {
    expect(validateAnnotationStrokes(value)).toBeNull();
  });

  it('accepts exactly 500 strokes', () => {
    const input = Array.from({ length: 500 }, () => stroke());
    expect(validateAnnotationStrokes(input)).toHaveLength(500);
  });

  it('rejects 501 strokes', () => {
    const input = Array.from({ length: 501 }, () => stroke());
    expect(validateAnnotationStrokes(input)).toBeNull();
  });

  it('accepts exactly 2000 points in one stroke', () => {
    const points = Array.from({ length: 2000 }, (_unused, i) => ({ x: i, y: i }));
    expect(validateAnnotationStrokes([stroke({ points })])?.[0].points).toHaveLength(2000);
  });

  it('rejects 2001 points in one stroke', () => {
    const points = Array.from({ length: 2001 }, (_unused, i) => ({ x: i, y: i }));
    expect(validateAnnotationStrokes([stroke({ points })])).toBeNull();
  });

  it('rejects the whole payload when only the last stroke is over the point limit', () => {
    const points = Array.from({ length: 2001 }, (_unused, i) => ({ x: i, y: i }));
    expect(validateAnnotationStrokes([stroke(), stroke({ points })])).toBeNull();
  });

  it.each([1, 20, 1.5, 19.75])('accepts stroke width %s', (width) => {
    expect(validateAnnotationStrokes([stroke({ width })])?.[0].width).toBe(width);
  });

  it.each([0, 0.999, -1, 20.0001, 21, 1000])('rejects stroke width %s', (width) => {
    expect(validateAnnotationStrokes([stroke({ width })])).toBeNull();
  });

  it.each([
    ['a numeric string', '4'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects a stroke whose width is %s', (_label, width) => {
    expect(validateAnnotationStrokes([stroke({ width })])).toBeNull();
  });

  // Both bounds comparisons are false for NaN, so the range check alone let it through
  // into the stored annotation JSON, where JSON.stringify renders it as null. Coordinates
  // always had the isFinite() guard the width was missing.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('refuses a %s stroke width, as it does for coordinates', (_label, width) => {
    expect(validateAnnotationStrokes([stroke({ width })])).toBeNull();
  });

  it.each(['#FF3B30', '#ff3b30', '#000000', '#AbCdEf'])('accepts colour %s', (color) => {
    expect(validateAnnotationStrokes([stroke({ color })])?.[0].color).toBe(color);
  });

  it.each([
    '#fff',
    '#FF3B3',
    '#FF3B301',
    'FF3B30',
    'red',
    'rgb(255,0,0)',
    '#GGGGGG',
    '#FF3B30 ',
    ' #FF3B30',
    '#FF3B30\n',
  ])('rejects colour %s', (color) => {
    expect(validateAnnotationStrokes([stroke({ color })])).toBeNull();
  });

  it.each([
    ['null', null],
    ['a number', 16711680],
  ])('rejects a stroke whose colour is %s', (_label, color) => {
    expect(validateAnnotationStrokes([stroke({ color })])).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects a point whose x is %s', (_label, x) => {
    expect(validateAnnotationStrokes([stroke({ points: [{ x, y: 0 }] })])).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects a point whose y is %s', (_label, y) => {
    expect(validateAnnotationStrokes([stroke({ points: [{ x: 0, y }] })])).toBeNull();
  });

  it.each([
    ['a numeric string', { x: '1', y: 2 }],
    ['missing y', { x: 1 }],
    ['missing x', { y: 2 }],
    ['a null coordinate', { x: null, y: 2 }],
  ])('rejects a point with %s', (_label, point) => {
    expect(validateAnnotationStrokes([stroke({ points: [point] })])).toBeNull();
  });

  it('rejects a nested array where a point object is expected', () => {
    expect(validateAnnotationStrokes([stroke({ points: [[1, 2]] })])).toBeNull();
  });

  it('rejects a null point', () => {
    expect(validateAnnotationStrokes([stroke({ points: [null] })])).toBeNull();
  });

  it('rejects a non-array points value', () => {
    expect(validateAnnotationStrokes([stroke({ points: { 0: { x: 1, y: 2 } } })])).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'stroke'],
    ['a number', 1],
  ])('rejects a stroke that is %s', (_label, value) => {
    expect(validateAnnotationStrokes([value])).toBeNull();
  });

  it('drops unexpected stroke properties instead of copying them through', () => {
    const input = [{ ...stroke(), tool: 'eraser', onClick: 'alert(1)' }];

    const result = validateAnnotationStrokes(input);

    expect(Object.keys(result![0]).sort()).toEqual(['color', 'points', 'width']);
  });

  it('drops unexpected point properties', () => {
    const input = [stroke({ points: [{ x: 1, y: 2, pressure: 0.5 }] })];

    expect(Object.keys(validateAnnotationStrokes(input)![0].points[0]).sort()).toEqual(['x', 'y']);
  });

  it('does not pollute Object.prototype from a __proto__ key on a stroke', () => {
    const payload = JSON.parse(
      '[{"points":[{"x":1,"y":2}],"color":"#FF3B30","width":4,"__proto__":{"polluted":"yes"}}]'
    );

    const result = validateAnnotationStrokes(payload);

    expect(result).toEqual([{ points: [{ x: 1, y: 2 }], color: '#FF3B30', width: 4 }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not pollute Object.prototype from a __proto__ key on a point', () => {
    const payload = JSON.parse(
      '[{"points":[{"x":1,"y":2,"__proto__":{"pointPolluted":"yes"}}],"color":"#FF3B30","width":4}]'
    );

    const result = validateAnnotationStrokes(payload);

    expect(result?.[0].points).toEqual([{ x: 1, y: 2 }]);
    expect(({} as Record<string, unknown>).pointPolluted).toBeUndefined();
  });

  it('rejects a stroke whose width arrives via the prototype chain rather than as an own key', () => {
    const proto = { width: 4, color: '#FF3B30' };
    const inherited = Object.create(proto) as Record<string, unknown>;
    inherited.points = [{ x: 1, y: 2 }];

    // Destructuring does read inherited keys, so this documents that a prototype
    // carrying the required fields is accepted, and the copy is a plain object.
    const result = validateAnnotationStrokes([inherited]);

    expect(result).toEqual([{ points: [{ x: 1, y: 2 }], color: '#FF3B30', width: 4 }]);
    expect(Object.getPrototypeOf(result![0])).toBe(Object.prototype);
  });

  it.each(['rectangle', 'ellipse', 'line', 'arrow'])(
    'keeps the %s shape on a two-point stroke',
    (shape) => {
      const input = [
        stroke({
          points: [
            { x: 0.1, y: 0.2 },
            { x: 0.7, y: 0.9 },
          ],
          shape,
        }),
      ];

      expect(validateAnnotationStrokes(input)).toEqual([
        {
          points: [
            { x: 0.1, y: 0.2 },
            { x: 0.7, y: 0.9 },
          ],
          color: '#FF3B30',
          width: 4,
          shape,
        },
      ]);
    }
  );

  it('writes no shape key for a freehand stroke', () => {
    expect(Object.keys(validateAnnotationStrokes([stroke()])![0]).sort()).toEqual([
      'color',
      'points',
      'width',
    ]);
  });

  it.each([
    ['an unknown shape name', { shape: 'triangle' }],
    ['an explicit freehand shape', { shape: 'freehand' }],
    ['a non-string shape', { shape: 1 }],
    ['a null shape', { shape: null }],
    ['a rectangle with one point', { shape: 'rectangle', points: [{ x: 0, y: 0 }] }],
    ['an arrow with no points', { shape: 'arrow', points: [] }],
    [
      'an arrow whose start and end are the same point',
      {
        shape: 'arrow',
        points: [
          { x: 0.4, y: 0.4 },
          { x: 0.4, y: 0.4 },
        ],
      },
    ],
    [
      'a line with three points',
      {
        shape: 'line',
        points: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 1 },
        ],
      },
    ],
  ])('rejects a stroke with %s', (_label, overrides) => {
    expect(validateAnnotationStrokes([stroke(overrides)])).toBeNull();
  });

  it('accepts a null-prototype stroke object', () => {
    const nullProto = Object.assign(Object.create(null), stroke());

    expect(validateAnnotationStrokes([nullProto])).toEqual([
      { points: [{ x: 1, y: 2 }], color: '#FF3B30', width: 4 },
    ]);
  });
});

describe('isValidHttpUrl', () => {
  it.each([
    'http://example.com',
    'https://example.com',
    'https://example.com/path?query=1#hash',
    'HTTPS://EXAMPLE.COM',
    'http://localhost:3000',
    'https://user:pass@example.com',
  ])('accepts %s', (url) => {
    expect(isValidHttpUrl(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'vbscript:msgbox(1)',
    'mailto:someone@example.com',
    'blob:https://example.com/uuid',
    '//example.com/protocol-relative',
    '/relative/path',
    'example.com',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isValidHttpUrl(url)).toBe(false);
  });
});

describe('validateUrl', () => {
  it('returns null for a valid https URL', () => {
    expect(validateUrl('https://example.com')).toBeNull();
  });

  it('names the field in the required message', () => {
    expect(validateUrl('', 'Thumbnail')).toBe('Thumbnail is required');
  });

  it('names the field in the scheme message', () => {
    expect(validateUrl('javascript:alert(1)', 'Thumbnail')).toBe(
      'Thumbnail must be a valid HTTP or HTTPS URL'
    );
  });

  it('defaults the field name to URL', () => {
    expect(validateUrl('javascript:alert(1)')).toBe('URL must be a valid HTTP or HTTPS URL');
  });
});

describe('validateOptionalUrl', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('accepts %s', (_label, value) => {
    expect(validateOptionalUrl(value)).toBeNull();
  });

  it('still rejects a dangerous scheme', () => {
    expect(validateOptionalUrl('javascript:alert(1)')).toBe(
      'URL must be a valid HTTP or HTTPS URL'
    );
  });
});

describe('isSafeAppRelativePath', () => {
  it.each([
    `/api/upload/image/${UUID}.png`,
    `/api/upload/audio/${UUID}.webm`,
    `/api/upload/video/${UUID}.mp4`,
    '/placeholder-video-thumbnail.png',
  ])('accepts %s', (path) => {
    expect(isSafeAppRelativePath(path)).toBe(true);
  });

  it('accepts an uppercase extension because the pattern is case-insensitive', () => {
    expect(isSafeAppRelativePath(`/api/upload/image/${UUID}.PNG`)).toBe(true);
  });

  it.each([
    ['a traversal segment', `/api/upload/image/../../${UUID}.png`],
    ['a traversal after a valid prefix', '/placeholder-video-thumbnail.png/../secret'],
    ['an encoded traversal', `/api/upload/image/%2e%2e/${UUID}.png`],
    ['no leading slash', `api/upload/image/${UUID}.png`],
    ['a protocol-relative prefix', `//evil.com/api/upload/image/${UUID}.png`],
    ['an absolute URL', `https://evil.com/api/upload/image/${UUID}.png`],
    ['an unsupported upload kind', `/api/upload/document/${UUID}.pdf`],
    ['a short identifier', '/api/upload/image/abc.png'],
    ['a 37 character identifier', `/api/upload/image/${UUID}a.png`],
    ['a non-hex identifier', '/api/upload/image/zzzzzzzz-2222-3333-4444-555555555555.png'],
    ['no extension', `/api/upload/image/${UUID}`],
    ['a query string', `/api/upload/image/${UUID}.png?redirect=https://evil.com`],
    ['a trailing slash', `/api/upload/image/${UUID}.png/`],
    ['an unrelated app route', '/api/projects'],
    ['an empty string', ''],
  ])('rejects %s', (_label, path) => {
    expect(isSafeAppRelativePath(path)).toBe(false);
  });
});

describe('validateOptionalUrlOrAppPath', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('accepts %s', (_label, value) => {
    expect(validateOptionalUrlOrAppPath(value)).toBeNull();
  });

  it('accepts a safe upload proxy path', () => {
    expect(validateOptionalUrlOrAppPath(`/api/upload/image/${UUID}.png`)).toBeNull();
  });

  it('accepts an absolute https URL', () => {
    expect(validateOptionalUrlOrAppPath('https://cdn.example.com/a.png')).toBeNull();
  });

  it('rejects an app-relative path that is not on the allowlist', () => {
    expect(validateOptionalUrlOrAppPath('/api/projects/secret', 'Thumbnail')).toBe(
      'Thumbnail must be a valid HTTP or HTTPS URL'
    );
  });

  it('rejects a javascript URL with the supplied field name', () => {
    expect(validateOptionalUrlOrAppPath('javascript:alert(1)', 'Thumbnail')).toBe(
      'Thumbnail must be a valid HTTP or HTTPS URL'
    );
  });

  it('rejects a traversal attempt dressed up as an upload path', () => {
    expect(validateOptionalUrlOrAppPath('/api/upload/image/../../../etc/passwd')).toBe(
      'URL must be a valid HTTP or HTTPS URL'
    );
  });
});
