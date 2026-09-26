import { checkFolderAccess, visibleVideoWhere, visibleFolderWhere } from '@/lib/content-access';
import Link from 'next/link';
import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { GuestGate } from '@/components/guest-gate';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { ProjectContentClient } from './project-content-client';
import ProjectLoading from './loading';
import {
  hasR2Config,
  isDirectFileUploadEnabled,
  isS3VideoUploadsEnabled,
} from '@/lib/feature-flags';
import { canDownloadProjectMedia } from '@/lib/project-download';
import {
  parseProjectContentSort,
  projectFolderOrderBy,
  projectVideoOrderBy,
} from '@/lib/project-content-sort';

function formatDuration(seconds: number | null): string {
  if (!seconds) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

interface ProjectPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ page?: string; sort?: string; folderId?: string; view?: string }>;
}

export default async function ProjectPage(props: ProjectPageProps) {
  const searchParams = await props.searchParams;
  // Query-only navigation stays in this route segment, so reset its loading boundary.
  const loadingKey = JSON.stringify([searchParams.folderId || null, searchParams.view === 'all']);

  return (
    <Suspense key={loadingKey} fallback={<ProjectLoading />}>
      <ProjectContent {...props} />
    </Suspense>
  );
}

async function ProjectContent({ params, searchParams }: ProjectPageProps) {
  const session = await auth();
  const { projectId } = await params;
  const resolvedSearchParams = await searchParams;

  const folderId = resolvedSearchParams.folderId || null;
  const all = resolvedSearchParams.view === 'all';
  const page = Math.max(1, Number(resolvedSearchParams?.page) || 1);
  const sortOrder = parseProjectContentSort(resolvedSearchParams.sort);
  const pageSize = 21;
  const skip = (page - 1) * pageSize;

  // Fetch project with videos
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      workspace: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
      members: {
        where: { userId: session?.user?.id || '' },
        select: { role: true },
      },
    },
  });

  if (!project) {
    notFound();
  }

  const projectAccess = await checkProjectAccess(project, session?.user?.id);
  const access = await checkFolderAccess(projectId, folderId, session?.user?.id);
  if (!access) notFound();
  const folders = await db.projectFolder.findMany({
    where: { projectId, AND: visibleFolderWhere(session?.user?.id) },
    orderBy: projectFolderOrderBy(sortOrder),
    include: {
      _count: {
        // Count direct children using the same visibility rules as the video list.
        select: { videos: { where: visibleVideoWhere(session?.user?.id) } },
      },
    },
  });
  const editableFolders = await db.projectFolder.findMany({
    where: { projectId, AND: visibleFolderWhere(session?.user?.id, true) },
    select: { id: true },
  });
  const editableIds = new Set(editableFolders.map((f) => f.id));
  const visibleIds = new Set(folders.map((f) => f.id));
  const folderEntries = folders.map((f) => ({
    id: f.id,
    name: f.name,
    accessMode: f.accessMode,
    parentId: f.parentId && visibleIds.has(f.parentId) ? f.parentId : null,
    canEdit: editableIds.has(f.id),
    videoCount: f._count.videos,
  }));
  const videoWhere = {
    projectId,
    AND: visibleVideoWhere(session?.user?.id),
    ...(!all ? { folderId } : {}),
  };

  // Check access
  const isOwner = session?.user?.id === project.ownerId;
  const isPublic = project.visibility === 'PUBLIC';

  // Check workspace membership
  let workspaceRole: string | null = null;
  if (session?.user?.id) {
    const wsMember = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: project.workspaceId,
          userId: session.user.id,
        },
      },
    });
    const ws = await db.workspace.findUnique({
      where: { id: project.workspaceId },
      select: { ownerId: true },
    });
    if (ws?.ownerId === session.user.id || wsMember) {
      workspaceRole = ws?.ownerId === session.user.id ? 'OWNER' : wsMember?.role || null;
    }
  }

  if (!access.hasAccess) {
    if (!session?.user?.id) {
      redirect('/login');
    }
    redirect('/dashboard');
  }

  // Fetch videos separately utilizing bounds
  const [paginatedVideos, totalVideos, allVideoIds] = await Promise.all([
    db.video.findMany({
      where: videoWhere,
      skip,
      take: pageSize,
      orderBy: projectVideoOrderBy(sortOrder),
      include: {
        versions: {
          where: { isActive: true },
          take: 1,
          include: {
            _count: { select: { comments: true } },
          },
        },
        _count: { select: { versions: true } },
      },
    }),
    db.video.count({
      where: videoWhere,
    }),
    db.video.findMany({
      where: videoWhere,
      select: { id: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    }),
  ]);

  const totalPages = Math.ceil(totalVideos / pageSize);

  // Transform videos for VideoCard component
  const videos = paginatedVideos.map((video) => {
    const activeVersion = video.versions[0];
    return {
      id: video.id,
      mediaType: video.mediaType,
      title: video.title,
      thumbnailUrl:
        activeVersion?.thumbnailUrl || 'https://via.placeholder.com/320x180?text=No+Thumbnail',
      currentVersion: video._count.versions,
      commentCount: activeVersion?._count.comments || 0,
      duration: formatDuration(activeVersion?.duration),
      lastUpdated: formatRelativeTime(video.updatedAt),
      updatedAt: video.updatedAt.toISOString(),
    };
  });

  const directUploadsEnabled = isDirectFileUploadEnabled();
  const imageUploadsEnabled = hasR2Config();
  const directUploadProvider = isS3VideoUploadsEnabled() ? 'r2' : 'bunny';

  const canEdit = access.canEdit;
  const isAuthenticated = !!session?.user?.id;

  const canDownloadProject = canDownloadProjectMedia(project, access);

  const projectData = {
    name: projectAccess.hasAccess ? project.name : (access.folder?.name ?? 'Shared content'),
    description: projectAccess.hasAccess ? project.description : null,
    visibility: project.visibility,
    allowDownloads: project.allowDownloads,
    workspace: projectAccess.hasAccess ? project.workspace : null,
    members: projectAccess.hasAccess ? project.members : [],
  };

  // Guest name gate for unauthenticated users on public projects
  if (!isAuthenticated && isPublic) {
    return (
      <GuestGate>
        <div className="px-6 lg:px-8 py-8 w-full">
          {/* Back link */}
          <div className="mb-6">
            <Link
              href="/dashboard"
              className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to Projects
            </Link>
          </div>
          <ProjectContentClient
            key={`${folderId ?? 'root'}-${all}`}
            folderId={folderId}
            folders={folderEntries}
            canSeeRoot={projectAccess.hasAccess}
            all={all}
            project={projectData}
            projectId={projectId}
            videos={videos}
            allVideoIds={allVideoIds.map((video) => video.id)}
            canEdit={false}
            canDownloadProject={canDownloadProject}
            isOwner={false}
            workspaceRole={null}
            totalPages={totalPages}
            currentPage={page}
            pageSize={pageSize}
            directUploadsEnabled={directUploadsEnabled}
            imageUploadsEnabled={imageUploadsEnabled}
            directUploadProvider={directUploadProvider}
          />
        </div>
      </GuestGate>
    );
  }

  return (
    <div className="px-6 lg:px-8 py-8 w-full">
      {/* Back link */}
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Projects
        </Link>
      </div>
      <ProjectContentClient
        key={`${folderId ?? 'root'}-${all}`}
        folderId={folderId}
        folders={folderEntries}
        canSeeRoot={projectAccess.hasAccess}
        all={all}
        project={projectData}
        projectId={projectId}
        videos={videos}
        allVideoIds={allVideoIds.map((video) => video.id)}
        canEdit={canEdit}
        canDownloadProject={canDownloadProject}
        isOwner={isOwner}
        workspaceRole={workspaceRole}
        totalPages={totalPages}
        currentPage={page}
        pageSize={pageSize}
        directUploadsEnabled={directUploadsEnabled}
        imageUploadsEnabled={imageUploadsEnabled}
        directUploadProvider={directUploadProvider}
      />
    </div>
  );
}
