import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITOR_PLUGIN_VERSIONS } from '@/lib/editor-plugin-versions';
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

  it('builds the import address, encoding the version id', () => {
    const url = call('import_url', 'https://open-frame.net', 'cm ver/1');
    expect(url).toBe('https://open-frame.net/api/versions/cm%20ver%2F1/comments/import');
    // An encoded id carries a %, which the shell guard refuses, so a real cuid must pass.
    expect(call('is_safe_url', call('import_url', 'https://h', 'cmver1'))).toBe(true);
  });

  it('collects only the editor markers, in timeline order', () => {
    const own = call('own_markers', {
      '120': { name: 'Color', note: 'Too warm', duration: 1, customData: '' },
      '9': { name: '', note: 'Flash frame', duration: 25 },
      '30': { name: 'Synced', note: 'Ann: x', duration: 1, customData: 'openframe:ver1' },
      '45': { name: 'Other version', note: '', duration: 1, customData: 'openframe:ver2' },
      '60': { name: 'Mine', note: 7, duration: 1, customData: 'not openframe:x' },
      '80.6': { name: 12, note: 'No duration' },
      '90': { name: 'Long', note: '', duration: 2.6 },
    });
    expect(own).toEqual([
      {
        frame: 9,
        payload: { startFrame: 9, durationFrames: 25, name: '', comments: 'Flash frame' },
      },
      { frame: 60, payload: { startFrame: 60, durationFrames: 1, name: 'Mine', comments: '' } },
      {
        frame: 80.6,
        payload: { startFrame: 81, durationFrames: 0, name: '', comments: 'No duration' },
      },
      { frame: 90, payload: { startFrame: 90, durationFrames: 3, name: 'Long', comments: '' } },
      {
        frame: 120,
        payload: { startFrame: 120, durationFrames: 1, name: 'Color', comments: 'Too warm' },
      },
    ]);
    expect(call('own_markers', null)).toEqual({});
  });

  it('maps the accepted indexes onto the batch that was sent, and nothing else', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    // The second batch: list[3 .. 5], of which the server took its first and third.
    expect(call('accepted_entries', list, 3, 3, [0, 2])).toEqual(['c', 'e']);
    expect(call('accepted_entries', list, 1, 2, [1, 1, -1, 2, 0.5, '0'])).toEqual(['b']);
    expect(call('accepted_entries', list, 1, 5, null)).toEqual({});
  });

  it('encodes what it sends as JSON the server reads back unchanged', () => {
    const body = {
      fps: '30000/1001',
      markers: [
        {
          startFrame: 0,
          durationFrames: 1,
          name: 'Ayşe "quote" \\ 中文 😀',
          comments: 'a\nb\r\tc\u0001',
        },
        { startFrame: 5178816, durationFrames: 25, name: '', comments: '' },
      ],
    };
    const text = call('json_encode', body) as string;
    expect(JSON.parse(text)).toEqual(body);
    // Whole frame numbers go out without the ".0" Lua 5.3 would add.
    expect(text).toContain('"startFrame":5178816');
    expect(call('json_encode', [])).toBe('[]');
    expect(call('json_encode', [true, false, 1.5])).toBe('[true,false,1.5]');
  });

  it('summarises a send, mentioning only what happened', () => {
    expect(call('send_summary', { created: 2, duplicates: 0, skipped: {} }, 2)).toEqual([
      'Sent 2 marker(s): 2 new comment(s) on OpenFrame.',
    ]);
    expect(
      call(
        'send_summary',
        { created: 0, duplicates: 3, skipped: { empty: 1, outOfRange: 2, tooLong: 4 } },
        10
      )
    ).toEqual([
      'Sent 10 marker(s): 0 new comment(s) on OpenFrame.',
      '3 were already there.',
      '1 had no name or note and were left out.',
      '2 start after the end of this version and were left out.',
      '4 were longer than a comment can be.',
    ]);
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

  it('carries the version the server announces', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'integrations', 'resolve', 'OpenFrame Comments.lua'),
      'utf8'
    );
    expect(source.match(/^M\.VERSION = '([^']+)'$/m)?.[1]).toBe(EDITOR_PLUGIN_VERSIONS.resolve);
  });

  it.each([
    ['0.2.0', '0.1.0', true],
    ['0.10.0', '0.9.0', true],
    ['1.0', '0.9.9', true],
    ['0.1.1', '0.1', true],
    ['0.1.0', '0.1.0', false],
    ['0.1', '0.1.0', false],
    ['0.1.0', '0.2.0', false],
    ['0.9.0', '0.10.0', false],
    ['', '0.1.0', false],
    ['1.x', '0.1.0', false],
    ['1..0', '0.1.0', false],
    ['1.0.', '0.1.0', false],
    [null, '0.1.0', false],
    [2, '0.1.0', false],
  ])('reads %s as newer than %s: %s', (latest, current, newer) => {
    expect(call('is_newer_version', latest, current)).toBe(newer);
  });

  it('asks for an update only when the server knows a newer script', () => {
    expect(call('update_notice', { premiere: '0.0.1', resolve: '9.0.0' })).toBe(
      'A new version of this script (9.0.0) is out. Download it again from the comments menu in OpenFrame and replace this file.'
    );
    // The Premiere entry is not this script's.
    expect(call('update_notice', { premiere: '9.0.0', resolve: '0.0.1' })).toBeNull();
    expect(call('update_notice', { resolve: '0.1.0' })).toBeNull();
    expect(call('update_notice', null)).toBeNull();
  });
});
