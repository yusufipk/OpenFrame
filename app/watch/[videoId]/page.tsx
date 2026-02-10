'use client';

import { useParams } from 'next/navigation';
import { VideoPageContent } from '@/components/video-page-content';

export default function WatchPage() {
  const params = useParams();
  const videoId = params.videoId as string;

  return (
    <VideoPageContent
      mode="watch"
      videoId={videoId}
    />
  );
}
