/**
 * What a personal access token may be allowed to do. Pure data, so the settings
 * card can import it without pulling the database client into the browser.
 */

export const API_TOKEN_SCOPES = [
  'read',
  'upload',
  'manage',
  'delete',
  'comments:read',
  'comments:write',
  'approvals',
  'share',
  'download',
] as const;

export const MAX_API_TOKEN_NAME_LENGTH = 60;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const API_TOKEN_SCOPE_DETAILS: Record<
  ApiTokenScope,
  { label: string; description: string }
> = {
  read: {
    label: 'Read',
    description: 'List and open workspaces, projects, folders, videos and versions, and play them',
  },
  upload: {
    label: 'Upload',
    description: 'Add videos, new versions, assets and subtitles',
  },
  manage: {
    label: 'Manage',
    description: 'Create and edit workspaces, private projects and folders, rename videos',
  },
  delete: {
    label: 'Delete',
    description: 'Delete workspaces, projects, videos, versions, assets and subtitles',
  },
  'comments:read': {
    label: 'Read comments',
    description: 'Read comments and tags, export them',
  },
  'comments:write': {
    label: 'Write comments',
    description: 'Add, edit, resolve and delete comments and tags',
  },
  approvals: {
    label: 'Approvals',
    description:
      'Request approvals, approve, reject and cancel them. Shows approvers with their email addresses',
  },
  share: {
    label: 'Sharing and members',
    description:
      'Share links, invitations, roles, project visibility and moving content. It can give other people full access, so treat it like every permission at once',
  },
  download: {
    label: 'Download',
    description:
      'Download versions, assets and whole projects. Read can already play the media and open assets',
  },
};

/** What a new token starts with in the settings card. */
export const DEFAULT_API_TOKEN_SCOPES: readonly ApiTokenScope[] = ['read', 'upload'];

export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return typeof value === 'string' && (API_TOKEN_SCOPES as readonly string[]).includes(value);
}
