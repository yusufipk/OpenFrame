import { ContentAccessControls } from '@/components/content-access-controls';
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

  const { access } = await requireVideoProjectAccessOrRedirect({
    projectId,
    videoId,
    userId: session?.user?.id,
    intent: 'view',
    allowPublicView: true,
  });

  return (
    <>
      {access.canEdit && (
        <div className="px-6 pt-3">
          <ContentAccessControls projectId={projectId} videoId={videoId} />
        </div>
      )}
      <VideoPageContent
        mode="dashboard"
        videoId={videoId}
        projectId={projectId}
        directUploadsEnabled={isDirectFileUploadEnabled()}
        directUploadProvider={isS3VideoUploadsEnabled() ? 'r2' : 'bunny'}
      />
    </>
  );
}
