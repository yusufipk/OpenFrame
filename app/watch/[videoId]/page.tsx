import { VideoPageContent } from '@/components/video-page-content';
import { ShareLinkBootstrap } from '@/components/share-link-bootstrap';
import { ShareLinkUnlock } from '@/components/share-link-unlock';

interface WatchPageProps {
  params: Promise<{ videoId: string }>;
  searchParams: Promise<{ shareToken?: string; unlock?: string }>;
}

export default async function WatchPage({ params, searchParams }: WatchPageProps) {
  const { videoId } = await params;
  const { shareToken, unlock } = await searchParams;

  if (typeof shareToken === 'string' && shareToken.length > 0) {
    return <ShareLinkBootstrap videoId={videoId} shareToken={shareToken} />;
  }

  if (unlock === '1') {
    return <ShareLinkUnlock videoId={videoId} />;
  }

  return <VideoPageContent mode="watch" videoId={videoId} />;
}
