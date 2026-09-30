/**
 * Height of the player (or image viewport) when the comments are stacked under
 * it on a phone: 16:9 of the width, but never more than about a third of the
 * screen, so a portrait video cannot push the comments off it. Measured in dvh,
 * so it also shrinks when an on-screen keyboard resizes the page.
 */
export const STACKED_MEDIA_HEIGHT =
  'shrink-0 h-[min(56.25vw,35dvh)] wide:h-auto wide:flex-1 wide:min-h-0';

/**
 * Viewport for the pages that render the review layout. `resizes-content` makes
 * Android Chrome shrink the page when the keyboard opens, so the dvh heights
 * above give way and the comment box stays on screen. iOS ignores the key and
 * scrolls the focused field into view instead.
 */
export const REVIEW_PAGE_VIEWPORT = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
} as const;

/**
 * The media query behind the `narrow` Tailwind variant in app/globals.css (the stacked
 * phone layout), for the few places that have to know the layout in script. Keep the
 * two in step.
 */
export const STACKED_LAYOUT_QUERY =
  '(width < 64rem) and (orientation: portrait), (width < 64rem) and (height >= 32rem)';
