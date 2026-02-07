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
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

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
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const session = await auth();
  const { workspaceId } = await params;

  if (!session?.user?.id) {
    redirect('/login');
  }

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

  if (!isOwner && !isMember) {
    redirect('/workspaces');
  }

  return (
    <div className="px-6 lg:px-8 py-8 w-full">
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

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{workspace.name}</h1>
          {workspace.description && (
            <p className="text-muted-foreground mt-1">{workspace.description}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
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
        <div className="flex items-center gap-2">
          {isAdmin && (
            <>
              <Button asChild variant="outline" size="sm">
                <Link href={`/workspaces/${workspaceId}/members`}>
                  <Users className="h-4 w-4 mr-2" />
                  Members
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/workspaces/${workspaceId}/settings`}>
                  <Settings className="h-4 w-4 mr-2" />
                  Settings
                </Link>
              </Button>
              <Button asChild size="sm">
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
