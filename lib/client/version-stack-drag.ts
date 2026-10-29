/**
 * Drag payload type for dragging a file card onto another to stack it as a new version.
 * The page-wide upload overlay ignores drags that carry it, since a dragged card
 * thumbnail can also expose a `Files` entry in some browsers.
 */
export const VERSION_STACK_DRAG_TYPE = 'application/x-openframe-file';

/**
 * Marks an element that turns a file dropped from the desktop into a new version
 * of one project file. The page-wide uploader looks for it under the pointer and
 * sets `data-file-drop-over` on it while the drag hovers there, so the element
 * can style itself without the uploader knowing its markup.
 */
export const VERSION_DROP_TARGET_ATTR = 'data-version-drop-target';
export const VERSION_DROP_OVER_ATTR = 'data-file-drop-over';

export type VersionDropTarget = {
  videoId: string;
  title: string;
  mediaType: 'VIDEO' | 'IMAGE';
};

export function versionDropTargetProps(target: VersionDropTarget) {
  return {
    [VERSION_DROP_TARGET_ATTR]: target.videoId,
    'data-version-drop-title': target.title,
    'data-version-drop-media': target.mediaType,
  };
}

export function findVersionDropTarget(
  node: EventTarget | null
): { element: HTMLElement; target: VersionDropTarget } | null {
  if (!(node instanceof Element)) return null;
  const element = node.closest<HTMLElement>(`[${VERSION_DROP_TARGET_ATTR}]`);
  const videoId = element?.getAttribute(VERSION_DROP_TARGET_ATTR);
  if (!element || !videoId) return null;
  return {
    element,
    target: {
      videoId,
      title: element.dataset.versionDropTitle ?? '',
      mediaType: element.dataset.versionDropMedia === 'IMAGE' ? 'IMAGE' : 'VIDEO',
    },
  };
}
