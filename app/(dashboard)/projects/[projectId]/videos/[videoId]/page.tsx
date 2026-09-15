import { VideoPageContent } from '@/components/video-page-content';
import { auth } from '@/lib/auth';
import { isDirectFileUploadEnabled, isS3VideoUploadsEnabled } from '@/lib/feature-flags';
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
      directUploadsEnabled={isDirectFileUploadEnabled()}
      directUploadProvider={isS3VideoUploadsEnabled() ? 'r2' : 'bunny'}
    />
  );
}
