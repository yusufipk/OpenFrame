import { requireProjectAccessOrRedirect } from '@/lib/route-access';
import NewVideoPageClient from './new-video-page-client';

interface NewVideoPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function NewVideoPage({ params }: NewVideoPageProps) {
  const { projectId } = await params;

  await requireProjectAccessOrRedirect({
    projectId,
    intent: 'manage',
  });

  return <NewVideoPageClient projectId={projectId} />;
}
