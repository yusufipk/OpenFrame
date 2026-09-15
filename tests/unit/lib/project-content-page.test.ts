import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, isValidElement, Suspense, type ReactNode } from 'react';
import ProjectPage from '@/app/(dashboard)/projects/[projectId]/page';
import ProjectLoading from '@/app/(dashboard)/projects/[projectId]/loading';
import { ProjectContentClient } from '@/app/(dashboard)/projects/[projectId]/project-content-client';
import { visibleVideoWhere } from '@/lib/content-access';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  projectAccess: vi.fn(),
  folderAccess: vi.fn(),
  db: {
    project: { findUnique: vi.fn() },
    projectFolder: { findMany: vi.fn() },
    workspace: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    video: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock('@/lib/db', () => ({ db: mocks.db }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth, checkProjectAccess: mocks.projectAccess }));
vi.mock('@/lib/content-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/content-access')>()),
  checkFolderAccess: mocks.folderAccess,
}));
vi.mock('@/app/(dashboard)/projects/[projectId]/project-content-client', () => ({
  ProjectContentClient: () => null,
}));
vi.mock('@/components/guest-gate', () => ({ GuestGate: () => null }));

// Inspect returned props without rendering an async component. The mocked database
// verifies query wiring, not SQL execution or the visibility predicate itself.
function clientFolders(node: ReactNode): unknown {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; folders?: unknown }>(child)) continue;
    if (child.type === ProjectContentClient) return child.props.folders;
    const result = clientFolders(child.props.children);
    if (result) return result;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: 'viewer-1' } });
  mocks.projectAccess.mockResolvedValue({ hasAccess: true, canEdit: false });
  mocks.folderAccess.mockResolvedValue({ hasAccess: true, canEdit: false });
  mocks.db.project.findUnique.mockResolvedValue({
    id: 'project-1',
    ownerId: 'owner-1',
    workspaceId: 'workspace-1',
    name: 'Project',
    visibility: 'PUBLIC',
    allowDownloads: false,
    workspace: null,
    members: [],
  });
  mocks.db.projectFolder.findMany
    .mockResolvedValueOnce([
      {
        id: 'folder-1',
        name: 'Recordings',
        parentId: null,
        accessMode: 'INHERIT',
        _count: { videos: 2 },
      },
    ])
    .mockResolvedValueOnce([]);
  mocks.db.workspace.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
  mocks.db.workspaceMember.findUnique.mockResolvedValue(null);
  mocks.db.video.findMany.mockResolvedValue([]);
  mocks.db.video.count.mockResolvedValue(0);
});

afterEach(() => vi.useRealTimers());

async function loadProjectContent(props: Parameters<typeof ProjectPage>[0]) {
  const boundary = await ProjectPage(props);
  const content = boundary.props.children;
  return content.type(content.props);
}

describe('project page query wiring', () => {
  // Structural regression coverage; this does not exercise browser streaming.
  it('returns the project skeleton boundary before fetching data and resets it between folders', async () => {
    const root = await ProjectPage({
      params: Promise.resolve({ projectId: 'project-1' }),
      searchParams: Promise.resolve({}),
    });
    expect(root.type).toBe(Suspense);
    const folder = await ProjectPage({
      params: Promise.resolve({ projectId: 'project-1' }),
      searchParams: Promise.resolve({ folderId: 'folder-1' }),
    });
    const sibling = await ProjectPage({
      params: Promise.resolve({ projectId: 'project-1' }),
      searchParams: Promise.resolve({ folderId: 'folder-2' }),
    });
    expect(folder.type).toBe(Suspense);
    expect(folder.props.fallback.type).toBe(ProjectLoading);
    expect(root.key).not.toBe(folder.key);
    expect(folder.key).not.toBe(sibling.key);
    const nextPage = await ProjectPage({
      params: Promise.resolve({ projectId: 'project-1' }),
      searchParams: Promise.resolve({ folderId: 'folder-1', page: '2', sort: 'name-desc' }),
    });
    // Keep the client mounted so selections across video pages survive sorting and pagination.
    expect(nextPage.key).toBe(folder.key);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.db.project.findUnique).not.toHaveBeenCalled();
  });

  it.each(['viewer-1', undefined])(
    'filters direct folder counts for viewer %s and passes the count to the client',
    async (userId) => {
      mocks.auth.mockResolvedValue(userId ? { user: { id: userId } } : null);
      const page = await loadProjectContent({
        params: Promise.resolve({ projectId: 'project-1' }),
        searchParams: Promise.resolve({}),
      });
      const query = mocks.db.projectFolder.findMany.mock.calls[0][0];
      expect(query.where.projectId).toBe('project-1');
      expect(query.include._count.select.videos).toEqual({ where: visibleVideoWhere(userId) });
      expect(clientFolders(page)).toEqual([
        {
          id: 'folder-1',
          name: 'Recordings',
          parentId: null,
          accessMode: 'INHERIT',
          canEdit: false,
          videoCount: 2,
        },
      ]);
    }
  );

  it('passes name ordering and pagination to the database together', async () => {
    await loadProjectContent({
      params: Promise.resolve({ projectId: 'project-1' }),
      searchParams: Promise.resolve({ sort: 'name-desc', page: '2', folderId: 'folder-1' }),
    });
    expect(mocks.db.projectFolder.findMany.mock.calls[0][0].orderBy).toEqual([
      { name: 'desc' },
      { id: 'desc' },
    ]);
    expect(mocks.db.video.findMany.mock.calls[0][0]).toMatchObject({
      where: { projectId: 'project-1', folderId: 'folder-1' },
      skip: 21,
      take: 21,
      orderBy: [{ title: 'desc' }, { id: 'desc' }],
    });
  });
});
