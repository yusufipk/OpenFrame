import type { Viewport } from 'next';
import { notFound } from 'next/navigation';
import { ShareLinkBootstrap } from '@/components/share-link-bootstrap';
import { db } from '@/lib/db';
import { validateShareLinkAccess } from '@/lib/share-links';
import { REVIEW_PAGE_VIEWPORT } from '@/components/video-page/stacked-layout';

export const viewport: Viewport = REVIEW_PAGE_VIEWPORT;

interface ShortSharePageProps {
  params: Promise<{ token: string }>;
}

export const dynamic = 'force-dynamic';

export default async function ShortSharePage({ params }: ShortSharePageProps) {
  const { token } = await params;
  const link = await db.shareLink.findUnique({
    where: { token },
    select: { projectId: true, videoId: true },
  });

  if (!link?.videoId) notFound();

  const access = await validateShareLinkAccess({
    token,
    projectId: link.projectId,
    videoId: link.videoId,
    requiredPermission: 'VIEW',
  });
  if (!access.hasAccess && !access.requiresPassword) notFound();

  return <ShareLinkBootstrap videoId={link.videoId} shareToken={token} />;
}
