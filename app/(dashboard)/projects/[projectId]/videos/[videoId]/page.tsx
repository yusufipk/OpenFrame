import { VideoPageContent } from '@/components/video-page-content';
import { auth } from '@/lib/auth';
import { isBunnyUploadsEnabled } from '@/lib/feature-flags';
import { requireVideoProjectAccessOrRedirect } from '@/lib/route-access';

interface VideoPageProps {
  params: Promise<{ projectId: string; videoId: string }>;
}

export default async function VideoPage({ params }: VideoPageProps) {
  const { projectId, videoId } = await params;
  const session = await auth();

  await requireVideoProjectAccessOrRedirect({
    projectId,
    videoId,
    userId: session?.user?.id,
    intent: 'view',
    allowPublicView: true,
  });

  return (
    <VideoPageContent
      mode="dashboard"
      videoId={videoId}
      projectId={projectId}
      bunnyUploadsEnabled={isBunnyUploadsEnabled()}
    />
  );
}
