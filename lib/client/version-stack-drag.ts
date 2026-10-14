/**
 * Drag payload type for dragging a file card onto another to stack it as a new version.
 * The page-wide upload overlay ignores drags that carry it, since a dragged card
 * thumbnail can also expose a `Files` entry in some browsers.
 */
export const VERSION_STACK_DRAG_TYPE = 'application/x-openframe-file';
