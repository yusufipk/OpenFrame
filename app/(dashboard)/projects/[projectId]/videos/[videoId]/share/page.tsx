import { requireVideoProjectAccessOrRedirect } from '@/lib/route-access';
import VideoSharePageClient from './video-share-page-client';

interface VideoSharePageProps {
  params: Promise<{ projectId: string; videoId: string }>;
}

export default async function VideoSharePage({ params }: VideoSharePageProps) {
  const { projectId, videoId } = await params;

  await requireVideoProjectAccessOrRedirect({
    projectId,
    videoId,
    intent: 'manage',
  });

  return <VideoSharePageClient projectId={projectId} videoId={videoId} />;
}
