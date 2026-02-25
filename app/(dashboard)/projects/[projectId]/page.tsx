import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  ArrowLeft,
} from 'lucide-react';
import { GuestGate } from '@/components/guest-gate';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { ProjectContentClient } from './project-content-client';

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
  searchParams: Promise<{ page?: string }>;
}

export default async function ProjectPage({ params, searchParams }: ProjectPageProps) {
  const session = await auth();
  const { projectId } = await params;
  const resolvedSearchParams = await searchParams;

  const page = Number(resolvedSearchParams?.page) || 1;
  const pageSize = 20;
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

  // Check access
  const isOwner = session?.user?.id === project.ownerId;
  const isMember = project.members.length > 0;
  const isPublic = project.visibility === 'PUBLIC';

  // Check workspace membership
  let isWorkspaceMember = false;
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
      isWorkspaceMember = true;
      workspaceRole = ws?.ownerId === session.user.id ? 'OWNER' : wsMember?.role || null;
    }
  }

  if (!isOwner && !isMember && !isPublic && !isWorkspaceMember) {
    if (!session?.user?.id) {
      redirect('/login');
    }
    redirect('/dashboard');
  }

  // Fetch videos separately utilizing bounds
  const [paginatedVideos, totalVideos] = await Promise.all([
    db.video.findMany({
      where: { projectId: project.id },
      skip,
      take: pageSize,
      orderBy: { position: 'asc' },
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
      where: { projectId: project.id }
    })
  ]);

  const totalPages = Math.ceil(totalVideos / pageSize);

  // Transform videos for VideoCard component
  const videos = paginatedVideos.map((video) => {
    const activeVersion = video.versions[0];
    return {
      id: video.id,
      title: video.title,
      thumbnailUrl: activeVersion?.thumbnailUrl || 'https://via.placeholder.com/320x180?text=No+Thumbnail',
      currentVersion: video._count.versions,
      commentCount: activeVersion?._count.comments || 0,
      duration: formatDuration(activeVersion?.duration),
      lastUpdated: formatRelativeTime(video.updatedAt),
      updatedAt: video.updatedAt.toISOString(),
    };
  });

  const canEdit = isOwner || project.members[0]?.role === 'ADMIN' || workspaceRole === 'OWNER' || workspaceRole === 'ADMIN';
  const isAuthenticated = !!session?.user?.id;

  const projectData = {
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    workspace: project.workspace,
    members: project.members,
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
            project={projectData}
            projectId={projectId}
            videos={videos}
            canEdit={false}
            isOwner={false}
            workspaceRole={null}
            totalPages={totalPages}
            currentPage={page}
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
        project={projectData}
        projectId={projectId}
        videos={videos}
        canEdit={canEdit}
        isOwner={isOwner}
        workspaceRole={workspaceRole}
        totalPages={totalPages}
        currentPage={page}
      />
    </div>
  );
}
