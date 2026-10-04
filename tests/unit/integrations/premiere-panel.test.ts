import { describe, expect, it } from 'vitest';
import panel from '@/integrations/premiere-panel/markers.js';

describe('Premiere panel helpers', () => {
  it.each([
    ['10594584000', '24000/1001'],
    ['10584000000', '24'],
    ['10160640000', '25'],
    ['8475667200', '30000/1001'],
    ['8467200000', '30'],
    ['5292000000', '48'],
    ['5080320000', '50'],
    ['4237833600', '60000/1001'],
    ['4233600000', '60'],
  ])('reads a timebase of %s ticks per frame as %s fps', (timebase, rate) => {
    expect(panel.rateFromTimebase(timebase)).toBe(rate);
  });

  it('refuses a rate the export API does not take', () => {
    // 23.976 drifted by one tick, and 29.97 written as 2997/100.
    expect(panel.rateFromTimebase('10594584001')).toBeNull();
    expect(panel.rateFromTimebase(String(254016000000 / 29.97))).toBeNull();
    expect(panel.rateFromTimebase('')).toBeNull();
  });

  it('turns frames into exact tick strings past 2^53', () => {
    expect(panel.framesToTicks(3, '24000/1001')).toBe('31783752000');
    // A whole day at 59.94 fps: 5,178,816 frames.
    expect(panel.framesToTicks(5178816, '60000/1001')).toBe('21946960453017600');
  });

  it('reads the project and video from a video page link', () => {
    expect(
      panel.parseVideoLink(' https://open-frame.net/projects/p%201/videos/v%202/?version=x ')
    ).toEqual({ origin: 'https://open-frame.net', projectId: 'p 1', videoId: 'v 2' });
  });

  it.each([
    'http://localhost:3000/projects/p/videos/v',
    'http://127.0.0.1/projects/p/videos/v',
    'http://192.168.122.1:3420/projects/p/videos/v',
    'http://10.0.0.5/projects/p/videos/v',
    'http://172.20.1.1/projects/p/videos/v',
    'http://studio.local/projects/p/videos/v',
  ])('accepts plain http on a local address: %s', (value) => {
    expect(panel.parseVideoLink(value)).toMatchObject({ projectId: 'p', videoId: 'v' });
  });

  it.each([
    'not a link',
    'https://open-frame.net/projects/p1',
    'https://open-frame.net/projects/p1/videos/v1/compare',
    'https://open-frame.net/x/projects/p1/videos/v1',
    'https://open-frame.net/projects/%E0/videos/v1',
    'file:///projects/p/videos/v',
    'ftp://open-frame.net/projects/p/videos/v',
    'http://open-frame.net/projects/p/videos/v',
    'http://172.32.0.1/projects/p/videos/v',
    'http://192.169.0.1/projects/p/videos/v',
    'http://localhost.example.com/projects/p/videos/v',
  ])('rejects %s as a video link', (value) => {
    expect(panel.parseVideoLink(value)).toBeNull();
  });

  it('keeps a token per server', () => {
    expect(panel.tokenKey('https://open-frame.net')).toBe('openframe.token:https://open-frame.net');
    expect(panel.tokenKey('https://evil.example')).not.toBe(
      panel.tokenKey('https://open-frame.net')
    );
  });

  it('owns only markers whose last line names this version', () => {
    const comments = panel.markerComments({ comments: 'Ann: fix it' }, 'ver1');
    expect(comments).toBe('Ann: fix it\n[OpenFrame ver1]');
    expect(panel.ownsMarker(comments, 'ver1')).toBe(true);
    // Premiere may hand line breaks back as CR.
    expect(panel.ownsMarker('Ann: fix it\r[OpenFrame ver1]', 'ver1')).toBe(true);
    expect(panel.ownsMarker(comments, 'ver2')).toBe(false);
    expect(panel.ownsMarker('Editor note [OpenFrame ver1]', 'ver1')).toBe(false);
    expect(panel.ownsMarker('note\n[OpenFrame ver1]\nmore', 'ver1')).toBe(false);
    expect(panel.ownsMarker('[OpenFrame ver1]', 'ver1')).toBe(false);
    expect(panel.ownsMarker(undefined, 'ver1')).toBe(false);
  });

  it('builds the same marker key from the API and from what Premiere reads back', () => {
    const written = panel.markerKey(panel.framesToTicks(250, '25'), 'Ann: a\nb\n[OpenFrame v]');
    expect(written).toBe('2540160000000|Ann: a\nb\n[OpenFrame v]');
    expect(panel.markerKey(' 2540160000000', 'Ann: a\r\nb\r[OpenFrame v]')).toBe(written);
    expect(panel.markerKey('2540160000001', 'Ann: a\nb\n[OpenFrame v]')).not.toBe(written);
  });

  it('names a version with or without its label', () => {
    expect(panel.versionName({ versionNumber: 3, versionLabel: 'Final' })).toBe('v3: Final');
    expect(panel.versionName({ versionNumber: 3, versionLabel: null })).toBe('v3');
  });

  it('reads the error message from every response shape', () => {
    expect(panel.errorMessage(404, { error: { message: 'Version not found' } })).toBe(
      'Version not found'
    );
    expect(panel.errorMessage(400, { error: 'Bad fps' })).toBe('Bad fps');
    expect(panel.errorMessage(500, { error: { code: 1 } })).toBe('HTTP 500');
    expect(panel.errorMessage(502, null)).toBe('HTTP 502');
  });

  it('splits work into batches of the given size', () => {
    expect(panel.chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(panel.chunks([], 50)).toEqual([]);
  });
});
