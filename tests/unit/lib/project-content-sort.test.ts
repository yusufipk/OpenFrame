import { describe, expect, it } from 'vitest';
import {
  parseProjectContentSort,
  projectFolderOrderBy,
  projectVideoOrderBy,
} from '@/lib/project-content-sort';

describe('project content sorting', () => {
  it.each([undefined, null, '', 'invalid', 'toString', '__proto__'])(
    '%s falls back to newest first',
    (value) => {
      expect(parseProjectContentSort(value)).toBe('desc');
    }
  );

  it.each([
    ['desc', [{ updatedAt: 'desc' }, { id: 'desc' }]],
    ['asc', [{ updatedAt: 'asc' }, { id: 'asc' }]],
    ['name-asc', [{ title: 'asc' }, { id: 'asc' }]],
    ['name-desc', [{ title: 'desc' }, { id: 'desc' }]],
  ] as const)('%s builds video ordering with a stable tie breaker', (value, expected) => {
    expect(parseProjectContentSort(value)).toBe(value);
    expect(projectVideoOrderBy(parseProjectContentSort(value))).toEqual(expected);
  });

  it('reverses folder names only for Z to A and preserves alphabetical order for date sorts', () => {
    expect(projectFolderOrderBy('name-desc')).toEqual([{ name: 'desc' }, { id: 'desc' }]);
    expect(projectFolderOrderBy('name-asc')).toEqual([{ name: 'asc' }, { id: 'asc' }]);
    expect(projectFolderOrderBy('asc')).toEqual([{ name: 'asc' }, { id: 'asc' }]);
    expect(projectFolderOrderBy('desc')).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });
});
