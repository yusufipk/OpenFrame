import type { ContentMode } from '@/lib/content-access';

export type ContentKind = 'folder' | 'video';

export const ACCESS_MODE_LABELS: Record<ContentMode, string> = {
  INHERIT: 'Same as its folder or project',
  RESTRICTED: 'Only invited people',
};

/**
 * Explains an access mode by its outcome. INHERIT follows the enclosing folder, which may
 * itself be restricted, so the copy only promises the whole project at the top level.
 */
export function accessModeDescription(mode: ContentMode, kind: ContentKind) {
  return mode === 'RESTRICTED'
    ? `Only the people you invite below can open this ${kind}. Project and workspace owners and admins can always open it.`
    : `Whoever can open the folder this ${kind} is in can open it too. At the top level of a project, that is everyone in the project. People you invite below also get access.`;
}
