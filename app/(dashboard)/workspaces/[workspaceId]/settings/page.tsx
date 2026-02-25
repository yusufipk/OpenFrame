import { requireWorkspaceAccessOrRedirect } from '@/lib/route-access';
import WorkspaceSettingsPageClient from './workspace-settings-page-client';

interface WorkspaceSettingsPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceSettingsPage({ params }: WorkspaceSettingsPageProps) {
  const { workspaceId } = await params;

  await requireWorkspaceAccessOrRedirect({
    workspaceId,
    intent: 'manage',
  });

  return <WorkspaceSettingsPageClient workspaceId={workspaceId} />;
}
