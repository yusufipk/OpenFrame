import { requireWorkspaceAccessOrRedirect } from '@/lib/route-access';
import NewWorkspaceProjectPageClient from './new-workspace-project-page-client';

interface NewWorkspaceProjectPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function NewWorkspaceProjectPage({ params }: NewWorkspaceProjectPageProps) {
  const { workspaceId } = await params;

  await requireWorkspaceAccessOrRedirect({
    workspaceId,
    intent: 'manage',
  });

  return <NewWorkspaceProjectPageClient workspaceId={workspaceId} />;
}
