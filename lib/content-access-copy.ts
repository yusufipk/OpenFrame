import type { ContentMode } from '@/lib/content-access';

/**
 * What switching to `mode` changes, beyond what the "Only invited people" checkbox already
 * says. INHERIT follows the enclosing folder, which may itself be restricted, so it never
 * promises the whole project.
 */
export function accessChangeMessage(mode: ContentMode) {
  if (mode === 'RESTRICTED') return 'Owners and admins keep access.';
  if (mode === 'PUBLIC') return 'Anyone with the link can view and comment, without an account.';
  return 'Anyone who can open its folder or project gets access.';
}
