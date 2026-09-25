import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImageReviewPlayer } from '@/components/video-page/image-review-player';

afterEach(() => vi.restoreAllMocks());

function renderPlayer() {
  const dimensions = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  const heights = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  const props = {
    versionId: 'version-1',
    src: '/api/upload/image/fixture.png',
    title: 'Layout review',
    isFullscreenMode: false,
    toggleFullscreen: vi.fn(),
    showComments: true,
    setShowComments: vi.fn(),
    setIsMobileCommentsOpen: vi.fn(),
    isAnnotating: false,
    annotationCanvasRef: { current: null },
    setAnnotationStrokes: vi.fn(),
    setIsAnnotating: vi.fn(),
    setViewingAnnotation: vi.fn(),
    viewingAnnotation: null,
    isEditingAnnotation: false,
    editAnnotationCanvasRef: { current: null },
    setEditAnnotationData: vi.fn(),
    setIsEditingAnnotation: vi.fn(),
  };
  const rendered = render(<ImageReviewPlayer {...props} />);
  const image = screen.getByRole('img', { name: 'Layout review' });
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 1600 },
    naturalHeight: { configurable: true, value: 1200 },
  });
  fireEvent.load(image);
  return { ...rendered, dimensions, heights, props };
}

describe('ImageReviewPlayer', () => {
  it('fits the image and exposes 100 percent and zoom controls without playback controls', () => {
    const { container, dimensions, heights } = renderPlayer();
    const stage = container.querySelector('[style*="scale"]') as HTMLElement;
    expect(stage.style.width).toBe('800px');
    expect(stage.style.height).toBe('600px');
    expect(stage.style.transform).toContain('scale(1)');
    expect(screen.queryByRole('button', { name: /play/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show image at 100%' }));
    expect(stage.style.transform).toContain('scale(2)');
    expect(screen.getByRole('button', { name: 'Show image at 100%' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fit image' }));
    expect(stage.style.transform).toContain('scale(1)');
    dimensions.mockRestore();
    heights.mockRestore();
  });

  it('keeps the comment toggle available in image mode', () => {
    const { props, dimensions, heights } = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Hide comments' }));
    expect(props.setShowComments).toHaveBeenCalledWith(false);
    expect(props.setIsMobileCommentsOpen).toHaveBeenCalledWith(false);
    dimensions.mockRestore();
    heights.mockRestore();
  });

  it('keeps draw and edit toolbars inside the viewport when the image is zoomed', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const { container, rerender, props } = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Show image at 100%' }));
    const viewport = screen.getByTestId('image-review-viewport');
    const stage = container.querySelector('[style*="scale"]') as HTMLElement;
    const toolbarLayer = screen.getByTestId('image-annotation-toolbar-layer');

    rerender(<ImageReviewPlayer {...props} isAnnotating />);
    const drawClose = screen.getByTitle('Close annotation tool');
    expect(stage.style.transform).toContain('scale(2)');
    expect(stage.querySelector('canvas')).toBeInTheDocument();
    expect(toolbarLayer).toContainElement(drawClose);
    expect(stage).not.toContainElement(drawClose);
    expect(viewport).toContainElement(drawClose);
    fireEvent.click(drawClose);
    expect(props.setIsAnnotating).toHaveBeenCalledWith(false);

    rerender(<ImageReviewPlayer {...props} isEditingAnnotation />);
    const editClose = screen.getByTitle('Close annotation tool');
    expect(toolbarLayer).toContainElement(editClose);
    expect(stage).not.toContainElement(editClose);
    fireEvent.click(editClose);
    expect(props.setIsEditingAnnotation).toHaveBeenCalledWith(false);
  });
});
