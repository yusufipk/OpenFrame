import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSubtitles } from '@/components/video-page/hooks/use-subtitles';
import type { Subtitle } from '@/components/video-page/types';

const LONG_CUE =
  'test. A test is a small program that automatically checks whether the code works correctly.';
const BALANCED_LONG_CUE =
  'test. A test is a small program\nthat automatically checks whether\nthe code works correctly.';

function subtitle(language: string): Subtitle {
  return {
    id: `sub-${language}`,
    language,
    label: language,
    canDelete: false,
    versionId: 'v1',
    url: `/api/upload/subtitle/${language}.vtt`,
    sizeBytes: 10,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    uploadedByUser: null,
  };
}

interface FakeTrack {
  language: string;
  mode: TextTrackMode;
  cues: { text: string; line: number | 'auto'; snapToLines: boolean }[];
}

/**
 * jsdom has no WebVTT support at all: <track> never loads and `textTracks` is empty. This
 * stands in for the surface the hook touches, with cues already parsed.
 */
function createVideoStub(tracks: FakeTrack[]) {
  const textTracks = Object.assign([...tracks], {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return {
    textTracks,
    querySelectorAll: () => [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLVideoElement;
}

describe('useSubtitles cue layout', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: { subtitles: [subtitle('en'), subtitle('tr')], canManageSubtitles: false },
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('breaks long cues on the track being shown and leaves the hidden one alone', async () => {
    const english: FakeTrack = {
      language: 'en',
      mode: 'disabled',
      cues: [{ text: LONG_CUE, line: 'auto', snapToLines: false }],
    };
    const turkish: FakeTrack = {
      language: 'tr',
      mode: 'disabled',
      cues: [{ text: LONG_CUE, line: 'auto', snapToLines: false }],
    };
    const videoRef = { current: createVideoStub([english, turkish]) };

    const { result } = renderHook(() =>
      useSubtitles({ videoId: 'video-1', versionId: 'v1', videoRef, supportsSubtitles: true })
    );
    await waitFor(() => expect(result.current.subtitles).toHaveLength(2));

    act(() => result.current.selectSubtitleLanguage('en'));

    expect(english.mode).toBe('showing');
    expect(english.cues[0].text).toBe(BALANCED_LONG_CUE);
    expect(english.cues[0].line).toBe(-3);
    expect(turkish.mode).toBe('disabled');
    expect(turkish.cues[0].text).toBe(LONG_CUE);
  });

  it('keeps short cues and authored line breaks as they are', async () => {
    const authored = 'This first line is already rather long on its own\nand so is this one';
    const english: FakeTrack = {
      language: 'en',
      mode: 'disabled',
      cues: [
        { text: 'Short cue.', line: 'auto', snapToLines: false },
        { text: authored, line: 'auto', snapToLines: false },
      ],
    };
    const videoRef = { current: createVideoStub([english]) };

    const { result } = renderHook(() =>
      useSubtitles({ videoId: 'video-1', versionId: 'v1', videoRef, supportsSubtitles: true })
    );
    await waitFor(() => expect(result.current.subtitles).toHaveLength(2));

    act(() => result.current.selectSubtitleLanguage('en'));

    expect(english.cues.map((cue) => cue.text)).toEqual(['Short cue.', authored]);
  });
});
