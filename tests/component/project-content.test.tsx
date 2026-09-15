import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectContentClient } from '@/app/(dashboard)/projects/[projectId]/project-content-client';
import { ProjectFolderBrowser, ProjectFolderCard } from '@/components/project-folder-browser';

const navigation = vi.hoisted(() => ({ push: vi.fn(), query: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

const folder = {
  id: 'folder-1',
  name: 'Recordings',
  parentId: null,
  accessMode: 'INHERIT',
  canEdit: false,
  videoCount: 0,
};

beforeEach(() => {
  navigation.push.mockClear();
  navigation.query = '';
});

describe('project folder cards', () => {
  it.each([
    [0, 'Folder'],
    [1, '1 video'],
    [2, '2 videos'],
  ] as const)('renders a count of %s as %s', (videoCount, label) => {
    render(<ProjectFolderCard projectId="project-1" folder={{ ...folder, videoCount }} />);
    expect(screen.getByText(label)).toBeVisible();
  });

  it('retains sorting when opening a folder without carrying pagination or all-video view', () => {
    navigation.query = 'sort=name-desc&page=3&view=all';
    render(<ProjectFolderCard projectId="project-1" folder={folder} />);
    expect(screen.getByRole('link', { name: 'Recordings' })).toHaveAttribute(
      'href',
      '/projects/project-1?folderId=folder-1&sort=name-desc'
    );
  });

  it('retains sorting in breadcrumbs and view switches', () => {
    navigation.query = 'sort=name-desc&page=3&folderId=folder-1';
    render(
      <ProjectFolderBrowser
        projectId="project-1"
        folderId="folder-1"
        folders={[folder]}
        canEdit={false}
        canSeeRoot
        all={false}
      />
    );
    expect(screen.getByRole('link', { name: 'Project root' })).toHaveAttribute(
      'href',
      '/projects/project-1?sort=name-desc'
    );
    expect(screen.getByRole('link', { name: 'Recordings' })).toHaveAttribute(
      'href',
      '/projects/project-1?folderId=folder-1&sort=name-desc'
    );
    expect(screen.getByRole('link', { name: 'All project videos' })).toHaveAttribute(
      'href',
      '/projects/project-1?sort=name-desc&folderId=folder-1&view=all'
    );
  });
});

describe('project sort menu', () => {
  it.each([
    ['Name: A to Z', 'name-asc'],
    ['Name: Z to A', 'name-desc'],
    ['Oldest first', 'asc'],
  ] as const)(
    'selects %s and resets pagination while preserving the current view',
    async (label, value) => {
      navigation.query = 'folderId=folder-1&view=all&page=3';
      const user = userEvent.setup();
      render(
        <ProjectContentClient
          project={{
            name: 'Project',
            description: null,
            visibility: 'PRIVATE',
            allowDownloads: false,
            workspace: null,
            members: [],
          }}
          projectId="project-1"
          folderId="folder-1"
          folders={[]}
          canSeeRoot
          all
          videos={[]}
          allVideoIds={[]}
          canEdit={false}
          canDownloadProject={false}
          isOwner={false}
          workspaceRole={null}
          totalPages={3}
          currentPage={3}
          pageSize={21}
          directUploadsEnabled={false}
          directUploadProvider="r2"
        />
      );
      await user.click(screen.getByRole('button', { name: 'Newest first' }));
      expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(4);
      await user.click(screen.getByRole('menuitemradio', { name: label }));
      expect(navigation.push).toHaveBeenCalledWith(
        `?folderId=folder-1&view=all&page=1&sort=${value}`
      );
    }
  );
});
