import { requireProjectAccessOrRedirect } from '@/lib/route-access';
import ProjectSettingsPageClient from './project-settings-page-client';

interface ProjectSettingsPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectSettingsPage({ params }: ProjectSettingsPageProps) {
  const { projectId } = await params;

  await requireProjectAccessOrRedirect({
    projectId,
    intent: 'manage',
  });

  return <ProjectSettingsPageClient projectId={projectId} />;
}
