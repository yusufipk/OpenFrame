import { auth } from '@/lib/auth';
import { checkFolderAccess } from '@/lib/content-access';
import { redirect } from 'next/navigation';
import {
  hasR2Config,
  isDirectFileUploadEnabled,
  isS3VideoUploadsEnabled,
} from '@/lib/feature-flags';
import NewVideoPageClient from './new-video-page-client';

interface NewVideoPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ folderId?: string }>;
}

export default async function NewVideoPage({ params, searchParams }: NewVideoPageProps) {
  const { projectId } = await params;

  const folderId = (await searchParams).folderId ?? null;
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  const access = await checkFolderAccess(projectId, folderId, session.user.id);
  if (!access?.canEdit) redirect('/shared');

  return (
    <NewVideoPageClient
      folderId={folderId}
      projectId={projectId}
      directUploadsEnabled={isDirectFileUploadEnabled()}
      imageUploadsEnabled={hasR2Config()}
      directUploadProvider={isS3VideoUploadsEnabled() ? 'r2' : 'bunny'}
    />
  );
}
