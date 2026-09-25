export function versionCommentsPath(versionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(versionId)) {
    throw new Error('Invalid video version identifier.');
  }
  return `/api/versions/${encodeURIComponent(versionId)}/comments`;
}
