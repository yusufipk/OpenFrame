'use client';

import { useParams } from 'next/navigation';
import { VideoPageContent } from '@/components/video-page-content';

export default function VideoPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const videoId = params.videoId as string;

  return (
    <VideoPageContent
      mode="dashboard"
      videoId={videoId}
      projectId={projectId}
    />
  );
}
