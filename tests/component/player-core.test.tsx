import { describe, it, expect, vi } from 'vitest';
import { createRef, type ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlayerCore } from '@/components/video-page/player-core';
import { DEFAULT_SUBTITLE_APPEARANCE } from '@/components/video-page/hooks/subtitle-appearance';

function playerProps(): ComponentProps<typeof PlayerCore> {
  return {
    activeVersionId: 'version-1',
    activeProviderId: 'r2',
    embedUrl: '/shot.mp4',
    videoRef: createRef(),
    iframeRef: createRef(),
    bunnyViewportRef: createRef(),
    timelineRef: createRef(),
    progressRef: createRef(),
    playheadRef: createRef(),
    scrubReadoutRef: createRef(),
    videoContainerRef: createRef(),
    showScrubReadout: false,
    isFullscreenMode: false,
    cursorIdle: false,
    isPlaying: false,
    isLoopEnabled: false,
    loopDisabled: false,
    handleLoopToggle: vi.fn(),
    handlePlayPause: vi.fn(),
    handleVideoMouseMove: vi.fn(),
    handleVideoMouseLeave: vi.fn(),
    isBunnyPortraitSource: false,
    bunnyPortraitFrameWidth: 0,
    showBunnyProcessingOverlay: false,
    showBunnyErrorOverlay: false,
    showResumePrompt: false,
    savedProgress: null,
    formatTime: (value) => `${value}s`,
    handleResumeFromSaved: vi.fn(),
    handleDismissResume: vi.fn(),
    isAnnotating: false,
    annotationCanvasRef: createRef(),
    setAnnotationStrokes: vi.fn(),
    setIsAnnotating: vi.fn(),
    setViewingAnnotation: vi.fn(),
    viewingAnnotation: null,
    isEditingAnnotation: false,
    editAnnotationCanvasRef: createRef(),
    setEditAnnotationData: vi.fn(),
    setIsEditingAnnotation: vi.fn(),
    currentTime: 0,
    duration: 3,
    isFrameMode: false,
    frameStepLabel: '1 frame',
    handleSkip: vi.fn(),
    handleFrameModeToggle: vi.fn(),
    handleMuteToggle: vi.fn(),
    isMuted: false,
    selectedQualityLabel: 'Auto',
    selectedQualityLevel: -1,
    qualityOptions: [],
    handleQualityChange: vi.fn(),
    subtitles: [],
    subtitleTracks: [],
    subtitleTrackKey: '',
    activeSubtitleLanguage: null,
    onSelectSubtitleLanguage: vi.fn(),
    canManageSubtitles: false,
    onUploadSubtitle: vi.fn(),
    onDeleteSubtitle: vi.fn(),
    isUploadingSubtitle: false,
    subtitleAppearance: DEFAULT_SUBTITLE_APPEARANCE,
    onChangeSubtitleAppearance: vi.fn(),
    playbackSpeed: 1,
    speedOptions: [0.5, 1, 2],
    handleSpeedChange: vi.fn(),
    toggleFullscreen: vi.fn(),
    showComments: true,
    setShowComments: vi.fn(),
    handleTimelinePointerDown: vi.fn(),
    handleTimelinePointerMove: vi.fn(),
    handleSeekToTimestamp: vi.fn(),
    commentMarkers: [],
  };
}

describe('PlayerCore short shots', () => {
  it.each([2, 3, 20])(
    'removes the dark overlay immediately during a %s second shot',
    (duration) => {
      const props = playerProps();
      const { container, rerender } = render(<PlayerCore {...props} duration={duration} />);
      expect(container.querySelector('.bg-black\\/20')).not.toBeNull();
      rerender(<PlayerCore {...props} duration={duration} isPlaying />);
      fireEvent.mouseMove(props.videoContainerRef.current!);
      expect(container.querySelector('.bg-black\\/20')).toBeNull();
      rerender(<PlayerCore {...props} duration={duration} />);
      expect(container.querySelector('.bg-black\\/20')).not.toBeNull();
    }
  );

  it.each([21, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'preserves the hover overlay for a longer or unknown duration (%s)',
    (duration) => {
      const { container } = render(<PlayerCore {...playerProps()} duration={duration} isPlaying />);
      expect(container.querySelector('.bg-black\\/20')).toHaveClass('group-hover:opacity-100');
    }
  );

  it('shows an accessible loop toggle and disables it when playback is locked', () => {
    const props = playerProps();
    const { rerender } = render(<PlayerCore {...props} />);
    const button = screen.getByRole('button', { name: 'Loop playback' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveAttribute('title', 'Enable loop (R)');
    fireEvent.click(button);
    expect(props.handleLoopToggle).toHaveBeenCalledTimes(1);
    rerender(<PlayerCore {...props} isLoopEnabled />);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    rerender(<PlayerCore {...props} loopDisabled />);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(props.handleLoopToggle).toHaveBeenCalledTimes(1);
  });
});
