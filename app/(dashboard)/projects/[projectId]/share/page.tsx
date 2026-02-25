import { requireProjectAccessOrRedirect } from '@/lib/route-access';
import ProjectSharePageClient from './project-share-page-client';

interface ProjectSharePageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectSharePage({ params }: ProjectSharePageProps) {
  const { projectId } = await params;

  await requireProjectAccessOrRedirect({
    projectId,
    intent: 'manage',
  });

  return <ProjectSharePageClient projectId={projectId} />;
}
