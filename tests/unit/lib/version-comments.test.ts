import { describe, expect, it } from 'vitest';
import { versionCommentsPath } from '@/lib/client/version-comments';

describe('versionCommentsPath', () => {
  it('targets the comment endpoint for a generated version identifier', () => {
    expect(versionCommentsPath('cm0abcdefghijklmnopqrstuv')).toBe(
      '/api/versions/cm0abcdefghijklmnopqrstuv/comments'
    );
    expect(versionCommentsPath('version_123-abc')).toBe('/api/versions/version_123-abc/comments');
  });

  it.each(['', '..', '../other', 'a/b', 'a\\b', 'a?x=1', 'a#fragment', '%2e%2e', '//example.com'])(
    'rejects a value that could change URL structure: %j',
    (versionId) => {
      expect(() => versionCommentsPath(versionId)).toThrow('Invalid video version identifier.');
    }
  );
});
