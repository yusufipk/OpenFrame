import { auth } from '@/lib/auth';
import { requireVideoProjectAccessOrRedirect } from '@/lib/route-access';
import CompareVersionsPageClient from './compare-versions-page-client';

interface CompareVersionsPageProps {
  params: Promise<{ projectId: string; videoId: string }>;
}

export default async function CompareVersionsPage({ params }: CompareVersionsPageProps) {
  const { projectId, videoId } = await params;
  const session = await auth();

  await requireVideoProjectAccessOrRedirect({
    projectId,
    videoId,
    userId: session?.user?.id,
    intent: 'view',
    allowPublicView: true,
  });

  return <CompareVersionsPageClient projectId={projectId} videoId={videoId} />;
}
