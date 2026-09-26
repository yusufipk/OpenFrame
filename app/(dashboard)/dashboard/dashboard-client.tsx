'use client';

import { ProjectFilter } from './project-filter';
import { VideoDragDropUploader } from '@/components/video-drag-drop-uploader';
import type { DirectUploadProvider } from '@/components/video-page/types';

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
  canUploadVideos: boolean;
  directUploadsEnabled: boolean;
  imageUploadsEnabled?: boolean;
  directUploadProvider: DirectUploadProvider;
}

export function DashboardClient({
  serializedProjects,
  workspaces,
  totalPages,
  canCreateProjects,
  canUploadVideos,
  directUploadsEnabled,
  imageUploadsEnabled = false,
  directUploadProvider,
}: DashboardClientProps) {
  return (
    <div className="px-6 lg:px-8 py-8 w-full">
      <VideoDragDropUploader
        canUpload={canUploadVideos && (directUploadsEnabled || imageUploadsEnabled)}
        directUploadsEnabled={directUploadsEnabled}
        imageUploadsEnabled={imageUploadsEnabled}
        directUploadProvider={directUploadProvider}
      />
      <ProjectFilter
        projects={serializedProjects}
        workspaces={workspaces}
        totalPages={totalPages}
        canCreateProjects={canCreateProjects}
      />
    </div>
  );
}
