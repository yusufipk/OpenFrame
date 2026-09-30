/**
 * Entries for the "What's new" panel in the app header, newest first.
 *
 * Each entry tells a user what they can do now, in plain words. Leave out internal fixes,
 * security patches, limits and quotas, and anything a user would not notice. The copy
 * describes the hosted service with every feature enabled: a self-hosted instance without
 * the live review service will not have live review.
 */

export interface WhatsNewEntry {
  /** Release date as `YYYY-MM-DD`. */
  date: string;
  title: string;
  description: string;
}

export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [
  {
    date: '2026-09-30',
    title: 'API tokens for scripts and AI agents',
    description:
      'Create an API token in Settings, choose what it may do, and a render script or an AI agent like Claude Code can upload versions, work through comments, request approvals and more for you, no browser needed.',
  },
  {
    date: '2026-09-30',
    title: 'Download all assets',
    description:
      'The Assets tab of a video has a Download all button that saves every image, video and voice note attached to it in one go.',
  },
  {
    date: '2026-09-30',
    title: 'Subtitle size and background',
    description:
      'Make subtitles smaller or larger and pick a translucent, solid or no background from the CC menu; your choice is kept for every video. Press C to turn subtitles on or off.',
  },
  {
    date: '2026-09-30',
    title: 'Brand a project for your client',
    description:
      "Give a project your client's color, a banner and a logo in its settings. Everyone who opens the project or one of its videos sees it in their brand.",
  },
  {
    date: '2026-09-29',
    title: 'Shapes in drawings',
    description:
      'When you draw on a comment, the toolbar now has a rectangle, an ellipse, a straight line and an arrow next to the pen. Drag across the frame to mark exactly the part you mean.',
  },
  {
    date: '2026-09-29',
    title: 'Delete projects without typing the name',
    description:
      'If you create and delete a lot of projects, you can now skip typing the project name before each delete: turn it off in Settings. You still confirm each delete with a click, and typing the name stays required until you turn it off.',
  },
  {
    date: '2026-09-28',
    title: 'Share from the toolbar',
    description:
      'On desktop, Share now sits in the toolbar above the player, so sharing a video or image takes one click. Compare moved into the ⋮ menu.',
  },
  {
    date: '2026-09-26',
    title: 'Live review',
    description:
      'Watch a video together in real time. One person controls playback while everyone follows along, and you can draw on a paused frame together and save your drawing as a comment.',
  },
  {
    date: '2026-09-26',
    title: 'Review still images',
    description:
      'Upload PNG, JPEG or WebP images straight into a project and review them like videos, with comments, drawings, zoom, versions and share links. Images and voice notes attached to comments also open in a preview with their own discussion.',
  },
  {
    date: '2026-09-25',
    title: 'Shorter share links',
    description:
      'New public share links are much shorter and easier to paste into a message. Links you already sent keep working.',
  },
  {
    date: '2026-09-15',
    title: 'Nested folders and folder access',
    description:
      'Organize a project into folders inside folders, and share a single folder or video without giving someone the whole project. Video access settings now live in the Share dialog.',
  },
  {
    date: '2026-09-15',
    title: 'Folder counts and name sorting',
    description:
      'Folder cards show how many videos they hold, and you can sort folders and videos by name, A to Z or Z to A.',
  },
  {
    date: '2026-09-08',
    title: 'Download voice notes',
    description:
      'Voice comments now have a download button and save as WAV files that open in any editing app.',
  },
  {
    date: '2026-08-22',
    title: 'Subtitles',
    description:
      'Upload SRT or WebVTT subtitles for each version of a video, and turn them on from the captions button in the player. YouTube videos show their own captions from the same button.',
  },
  {
    date: '2026-08-20',
    title: 'Several images in one comment',
    description:
      'Attach up to five screenshots to a comment or reply by pasting, dropping or picking them. You can also add or remove images when you edit a comment.',
  },
  {
    date: '2026-08-20',
    title: 'Faster playback',
    description:
      'Uploaded videos now play at up to 16x, with more speeds between 2x and 16x. YouTube videos still go up to 2x.',
  },
];

/** Most recent entry date, or null when there are no entries. */
export function getLatestWhatsNewDate(entries: readonly WhatsNewEntry[]): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (latest === null || entry.date > latest) latest = entry.date;
  }
  return latest;
}

/**
 * Whether the panel holds something the viewer has not opened yet. `lastSeen` is the latest
 * entry date recorded the last time they opened it; anything that is not a `YYYY-MM-DD`
 * date counts as never opened.
 */
export function hasUnseenWhatsNew(lastSeen: string | null, latest: string | null): boolean {
  if (latest === null) return false;
  if (lastSeen === null || !/^\d{4}-\d{2}-\d{2}$/.test(lastSeen)) return true;
  return latest > lastSeen;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formats a `YYYY-MM-DD` date as "Sep 28, 2026". It reads the string directly instead of
 * going through `Date`, so the viewer's time zone can never move it to the day before.
 */
export function formatWhatsNewDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}
