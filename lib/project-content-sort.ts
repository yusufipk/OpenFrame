import type { Prisma } from '@prisma/client';

export const projectContentSortLabels = {
  desc: 'Newest first',
  asc: 'Oldest first',
  'name-asc': 'Name: A to Z',
  'name-desc': 'Name: Z to A',
} as const;

export type ProjectContentSort = keyof typeof projectContentSortLabels;

export function parseProjectContentSort(value?: string | null): ProjectContentSort {
  return value === 'asc' || value === 'name-asc' || value === 'name-desc' ? value : 'desc';
}

export function projectVideoOrderBy(
  sort: ProjectContentSort
): Prisma.VideoOrderByWithRelationInput[] {
  if (sort === 'name-asc' || sort === 'name-desc') {
    const direction = sort === 'name-asc' ? 'asc' : 'desc';
    return [{ title: direction }, { id: direction }];
  }
  return [{ updatedAt: sort }, { id: sort }];
}

export function projectFolderOrderBy(
  sort: ProjectContentSort
): Prisma.ProjectFolderOrderByWithRelationInput[] {
  const direction = sort === 'name-desc' ? 'desc' : 'asc';
  return [{ name: direction }, { id: direction }];
}
