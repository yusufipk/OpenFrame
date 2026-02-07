'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, FolderOpen, Clock, Users, Globe, Lock, UserPlus, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface SerializedProject {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  updatedAt: string;
  workspaceId: string | null;
  workspaceName: string | null;
  memberCount: number;
  videoCount: number;
}

interface ProjectFilterProps {
  projects: SerializedProject[];
  workspaces: { id: string; name: string }[];
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
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

export function ProjectFilter({ projects, workspaces }: ProjectFilterProps) {
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('all');

  const filtered =
    selectedWorkspace === 'all'
      ? projects
      : projects.filter((p) => p.workspaceId === selectedWorkspace);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
          {workspaces.length > 0 && (
            <Select value={selectedWorkspace} onValueChange={setSelectedWorkspace}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="All Workspaces" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Workspaces</SelectItem>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    {ws.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </Link>
        </Button>
      </div>

      {/* Projects Grid */}
      {filtered.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((project) => (
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
                  {project.workspaceName && (
                    <div className="mt-1">
                      <Badge variant="secondary" className="text-xs flex items-center gap-1 w-fit">
                        <Building2 className="h-3 w-3" />
                        {project.workspaceName}
                      </Badge>
                    </div>
                  )}
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
                      {project.memberCount}
                    </span>
                    <span>{project.videoCount} videos</span>
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
            <h3 className="text-lg font-medium mb-2">
              {selectedWorkspace === 'all' ? 'No projects yet' : 'No projects in this workspace'}
            </h3>
            <p className="text-muted-foreground text-center mb-4">
              {selectedWorkspace === 'all'
                ? 'Create your first project to start collecting video feedback'
                : 'Create a project in this workspace to get started'}
            </p>
            <Button asChild>
              <Link href="/projects/new">
                <Plus className="h-4 w-4 mr-2" />
                Create Project
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );
}
