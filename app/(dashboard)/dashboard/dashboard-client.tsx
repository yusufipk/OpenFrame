'use client';

import { ProjectFilter } from './project-filter';

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

interface DashboardClientProps {
  serializedProjects: SerializedProject[];
  workspaces: { id: string; name: string }[];
  totalPages: number;
  canCreateProjects: boolean;
}

export function DashboardClient({ serializedProjects, workspaces, totalPages, canCreateProjects }: DashboardClientProps) {
  return (
    <div className="px-6 lg:px-8 py-8 w-full">
      <ProjectFilter
        projects={serializedProjects}
        workspaces={workspaces}
        totalPages={totalPages}
        canCreateProjects={canCreateProjects}
      />
    </div>
  );
}
