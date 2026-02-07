import Link from 'next/link';
import { Plus, FolderOpen, Clock, Users, Globe, Lock, UserPlus, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { ProjectFilter } from './project-filter';

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

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  // Fetch projects where user is owner, member, or workspace member
  const projects = await db.project.findMany({
    where: {
      OR: [
        { ownerId: session.user.id },
        { members: { some: { userId: session.user.id } } },
        {
          workspace: {
            OR: [
              { ownerId: session.user.id },
              { members: { some: { userId: session.user.id } } },
            ],
          },
        },
      ],
    },
    include: {
      workspace: {
        select: { id: true, name: true },
      },
      _count: {
        select: {
          videos: true,
          members: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Build unique workspace list for filter
  const workspaceMap = new Map<string, string>();
  for (const project of projects) {
    if (project.workspace) {
      workspaceMap.set(project.workspace.id, project.workspace.name);
    }
  }
  const workspaces = Array.from(workspaceMap, ([id, name]) => ({ id, name }));

  const serializedProjects = projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    visibility: p.visibility,
    updatedAt: p.updatedAt.toISOString(),
    workspaceId: p.workspace?.id ?? null,
    workspaceName: p.workspace?.name ?? null,
    memberCount: p._count.members + 1,
    videoCount: p._count.videos,
  }));

  return (
    <div className="px-6 lg:px-8 py-8 w-full">
      <ProjectFilter projects={serializedProjects} workspaces={workspaces} />
    </div>
  );
}
