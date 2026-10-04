import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLuaHelpers } from '../../helpers/lua';

const call = loadLuaHelpers(
  path.join(process.cwd(), 'integrations', 'resolve', 'OpenFrame Comments.lua')
);

describe('Resolve script helpers', () => {
  it.each([
    ['23.976', '24000/1001'],
    ['23.98', '24000/1001'],
    ['24', '24'],
    ['25', '25'],
    ['29.97', '30000/1001'],
    ['29.97 DF', '30000/1001'],
    ['30', '30'],
    ['48', '48'],
    ['50', '50'],
    ['59.94 DF', '60000/1001'],
    ['60', '60'],
  ])('reads the timeline rate %s as %s', (setting, rate) => {
    expect(call('rate_from_setting', setting)).toBe(rate);
  });

  it.each(['47.952', '120', '', 'fast', null])('refuses the timeline rate %s', (setting) => {
    expect(call('rate_from_setting', setting)).toBeNull();
  });

  it('reads the server and ids from a video page link', () => {
    expect(
      call('parse_video_link', ' https://Open-Frame.net/projects/p%201/videos/v%C3%A7/?version=x ')
    ).toEqual({ origin: 'https://open-frame.net', project_id: 'p 1', video_id: 'vç' });
    expect(call('parse_video_link', 'http://192.168.122.1:3421/projects/p/videos/v')).toEqual({
      origin: 'http://192.168.122.1:3421',
      project_id: 'p',
      video_id: 'v',
    });
    expect(call('parse_video_link', 'http://[::1]:3000/projects/p/videos/v')).toMatchObject({
      origin: 'http://[::1]:3000',
    });
  });

  it.each([
    'not a link',
    'ftp://open-frame.net/projects/p/videos/v',
    'http://open-frame.net/projects/p/videos/v',
    'http://172.32.0.1/projects/p/videos/v',
    'http://192.168.1.300/projects/p/videos/v',
    'http://localhost.example.com/projects/p/videos/v',
    'https://open-frame.net/x/projects/p/videos/v',
    'https://open-frame.net/projects/p/videos/v/compare',
    'https://open-frame.net/projects/%zz/videos/v',
    'https://evil.example"&calc&"/projects/p/videos/v',
  ])('rejects %s as a video link', (value) => {
    expect(call('parse_video_link', value)).toBeNull();
  });

  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['10.20.30.40', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.10', true],
    ['nas.local', true],
    ['[::1]', true],
    ['128.0.0.1', false],
    ['11.0.0.1', false],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.300.1', false],
    ['192.168.1.256', false],
    ['localhost.example.com', false],
    ['example.com', false],
  ])('treats %s as local: %s', (host, local) => {
    expect(call('is_local_host', host)).toBe(local);
  });

  it.each([
    'https://h/projects/p%2/videos/v',
    'https://h/projects/p%/videos/v',
    'https://h/projects/p%2z/videos/v',
  ])('rejects a broken percent escape in %s', (value) => {
    expect(call('parse_video_link', value)).toBeNull();
  });

  it('encodes ids for a URL path, byte by byte', () => {
    expect(call('url_encode', 'a b/ç&"')).toBe('a%20b%2F%C3%A7%26%22');
    expect(call('url_encode', 'cmur2e6jz000d-_.~')).toBe('cmur2e6jz000d-_.~');
  });

  it.each(['24000/1001', '30000/1001', '60000/1001', '25'])(
    'builds a markers address at %s fps that the command line guard lets through',
    (rate) => {
      const url = call('markers_url', 'https://open-frame.net', 'cmver1', rate, false);
      expect(url).toBe(
        `https://open-frame.net/api/versions/cmver1/comments/export?format=markers&fps=${rate}&includeResolved=false`
      );
      expect(call('is_safe_url', url)).toBe(true);
    }
  );

  it('asks for resolved comments only when the box is ticked', () => {
    expect(call('markers_url', 'https://h', 'v', '25', true)).toContain('&includeResolved=true');
    expect(call('markers_url', 'https://h', 'v', '25', null)).toContain('&includeResolved=false');
  });

  it('builds the versions address from a parsed link, encoding the ids', () => {
    const link = call(
      'parse_video_link',
      'http://localhost:3420/projects/cmproj/videos/cmvid'
    ) as Record<string, string>;
    const url = call('versions_url', link);
    expect(url).toBe(
      'http://localhost:3420/api/projects/cmproj/videos/cmvid?includeComments=false'
    );
    expect(call('is_safe_url', url)).toBe(true);
  });

  it.each([
    'https://h/a"&calc',
    'https://h/%PATH%',
    'https://h/`id`',
    'https://h/$(id)',
    'https://h/a\\b',
    'https://h/!VAR!',
  ])('refuses %s before it reaches the shell', (url) => {
    expect(call('is_safe_url', url)).toBe(false);
  });

  it('tags markers by version and names versions like the panel', () => {
    expect(call('marker_tag', 'ver1')).toBe('openframe:ver1');
    expect(call('version_name', { versionNumber: 2, versionLabel: 'Updated Intro' })).toBe(
      'v2: Updated Intro'
    );
    expect(call('version_name', { versionNumber: 2, versionLabel: null })).toBe('v2');
  });

  it('reads the error message from every response shape', () => {
    expect(call('error_message', 404, { error: { message: 'Version not found' } })).toBe(
      'Version not found'
    );
    expect(call('error_message', 400, { error: 'Bad fps' })).toBe('Bad fps');
    expect(call('error_message', 500, { error: { code: 1 } })).toBe('HTTP 500');
    expect(call('error_message', 502, null)).toBe('HTTP 502');
  });

  it('decodes the markers response, escapes and all', () => {
    const json = JSON.stringify({
      data: {
        videoTitle: 'M4 "Pro" İnceleme',
        versionNumber: 2,
        versionLabel: null,
        markers: [
          {
            startFrame: 300,
            durationFrames: 180,
            name: 'Ayşe: 中文 <a> & \\ / tab\tend 😀',
            comments: 'line\nnext\r\nlast',
            resolveColor: 'Cyan',
            done: false,
          },
        ],
      },
    });
    expect(call('json_decode', json)).toEqual({
      data: {
        videoTitle: 'M4 "Pro" İnceleme',
        versionNumber: 2,
        markers: [
          {
            startFrame: 300,
            durationFrames: 180,
            name: 'Ayşe: 中文 <a> & \\ / tab\tend 😀',
            comments: 'line\nnext\r\nlast',
            resolveColor: 'Cyan',
            done: false,
          },
        ],
      },
    });
  });

  it('decodes \\u escapes, surrogate pairs, numbers and literals', () => {
    expect(call('json_decode', '"\\u00e7\\u0130\\ud83d\\ude00\\/"')).toBe('çİ😀/');
    expect(call('json_decode', '[-1.5e2, 0, 12, true, false]')).toEqual([-150, 0, 12, true, false]);
    expect(call('json_decode', ' { } ')).toEqual({});
  });

  it('decodes the 3-byte UTF-8 range, \\b and \\f, and replaces lone surrogates', () => {
    expect(call('json_decode', '"\\u4e2d\\u0800\\u07ff\\b\\f"')).toBe('中\u0800\u07ff\b\f');
    expect(call('json_decode', '"a\\ud800b"')).toBe('a\ufffdb');
    expect(call('json_decode', '"\\udc00"')).toBe('\ufffd');
  });

  it('keeps array positions when an element is null', () => {
    const array = call('json_decode', '[null, 1]') as unknown[];
    expect(array.length).toBe(2);
    expect(array[1]).toBe(1);
  });

  it('names a version with an empty label by its number alone', () => {
    expect(call('version_name', { versionNumber: 3, versionLabel: '' })).toBe('v3');
  });

  it.each([
    '{"a":1',
    '[1,]x',
    '{"a" 1}',
    '"\\x"',
    '{"a":1} extra',
    'nul',
    '{"a":1 "b":2}',
    '[1 2]',
    '[1-2]',
    '[1e]',
    '"\\u12g4"',
    '{1:2}',
  ])('refuses the malformed JSON %s', (text) => {
    expect(() => call('json_decode', text)).toThrow('Invalid JSON');
  });
});
