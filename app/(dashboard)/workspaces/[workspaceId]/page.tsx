import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  ArrowLeft,
  Plus,
  Settings,
  FolderOpen,
  Clock,
  Users,
  Globe,
  Lock,
  UserPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { VideoDragDropUploader } from '@/components/video-drag-drop-uploader';

function VisibilityIcon({ visibility }: { visibility: string }) {
  switch (visibility) {
    case 'PUBLIC':
      return <Globe className="h-3.5 w-3.5" />;
    case 'INVITE':
      return <UserPlus className="h-3.5 w-3.5" />;
    default:
      return <Lock className="h-3.5 w-3.5" />;
  }
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

interface WorkspacePageProps {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ page?: string }>;
}

export default async function WorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const session = await auth();
  const { workspaceId } = await params;
  const resolvedSearchParams = await searchParams;
  const MAX_PAGE = 1000;

  if (!session?.user?.id) {
    redirect('/login');
  }

  const pageParam = resolvedSearchParams?.page;
  const parsedPage = pageParam ? Number(pageParam) : 1;
  const page =
    Number.isSafeInteger(parsedPage) && parsedPage > 0 && parsedPage <= MAX_PAGE ? parsedPage : 1;
  const pageSize = 20;
  const skip = (page - 1) * pageSize;

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      owner: { select: { id: true, name: true } },
      members: {
        where: { userId: session.user.id },
        select: { role: true },
      },
      projects: {
        orderBy: { updatedAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          _count: { select: { videos: true, members: true } },
        },
      },
      _count: { select: { projects: true, members: true } },
    },
  });

  if (!workspace) {
    notFound();
  }

  const isOwner = session.user.id === workspace.ownerId;
  const membership = workspace.members[0];
  const isMember = !!membership;
  const isAdmin = isOwner || membership?.role === 'ADMIN';
  const access = await checkWorkspaceAccess(
    { id: workspace.id, ownerId: workspace.ownerId },
    session.user.id
  );

  if (!access.hasAccess || (!isOwner && !isMember)) {
    redirect('/dashboard');
  }

  const totalPages = Math.ceil(workspace._count.projects / pageSize);

  return (
    <div className="px-6 lg:px-8 py-8 w-full">
      <VideoDragDropUploader
        workspaceId={workspaceId}
        canUpload={isAdmin && workspace._count.projects > 0}
      />
      {/* Back & Header */}
      <div className="mb-6">
        <Link
          href="/workspaces"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          All Workspaces
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{workspace.name}</h1>
          {workspace.description && (
            <p className="text-muted-foreground mt-1">{workspace.description}</p>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 mt-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <FolderOpen className="h-3.5 w-3.5" />
              {workspace._count.projects} projects
            </span>
            <span className="flex items-center gap-1">
              <Users className="h-3.5 w-3.5" />
              {workspace._count.members + 1} members
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto mt-2 sm:mt-0">
          {isAdmin && (
            <>
              <Button asChild variant="outline" size="sm" className="flex-1 sm:flex-none">
                <Link href={`/workspaces/${workspaceId}/members`}>
                  <Users className="h-4 w-4 mr-2" />
                  Members
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" className="flex-1 sm:flex-none">
                <Link href={`/workspaces/${workspaceId}/settings`}>
                  <Settings className="h-4 w-4 mr-2" />
                  Settings
                </Link>
              </Button>
              <Button asChild size="sm" className="w-full sm:w-auto">
                <Link href={`/workspaces/${workspaceId}/projects/new`}>
                  <Plus className="h-4 w-4 mr-2" />
                  New Project
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Projects Grid */}
      {workspace.projects.length > 0 ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {workspace.projects.map((project: (typeof workspace.projects)[number]) => (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <Card className="h-full transition-colors hover:bg-accent/50 cursor-pointer">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <CardTitle className="flex items-center gap-2">
                        <FolderOpen className="h-5 w-5 text-primary" />
                        {project.name}
                      </CardTitle>
                      <Badge variant="outline" className="flex items-center gap-1">
                        <VisibilityIcon visibility={project.visibility} />
                        {project.visibility.toLowerCase()}
                      </Badge>
                    </div>
                    <CardDescription className="line-clamp-2">
                      {project.description || 'No description'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        {formatRelativeTime(project.updatedAt)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {project._count.members + 1}
                      </span>
                      <span>{project._count.videos} videos</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-end space-x-2">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? (
                  <Link href={`/workspaces/${workspaceId}?page=${page - 1}`}>Previous</Link>
                ) : (
                  'Previous'
                )}
              </Button>
              <span className="text-sm font-medium">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                asChild={page < totalPages}
              >
                {page < totalPages ? (
                  <Link href={`/workspaces/${workspaceId}?page=${page + 1}`}>Next</Link>
                ) : (
                  'Next'
                )}
              </Button>
            </div>
          )}
        </>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FolderOpen className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No projects yet</h3>
            <p className="text-muted-foreground text-center mb-4">
              Create a project in this workspace to get started
            </p>
            {isAdmin && (
              <Button asChild>
                <Link href={`/workspaces/${workspaceId}/projects/new`}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Project
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
