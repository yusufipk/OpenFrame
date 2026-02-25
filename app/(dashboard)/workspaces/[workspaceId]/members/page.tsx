import { MembersManagementPage } from '@/components/members-management-page';
import { requireWorkspaceAccessOrRedirect } from '@/lib/route-access';

interface WorkspaceMembersPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceMembersPage({ params }: WorkspaceMembersPageProps) {
  const { workspaceId } = await params;

  await requireWorkspaceAccessOrRedirect({
    workspaceId,
    intent: 'manage',
  });

  return (
    <MembersManagementPage
      apiBasePath={`/api/workspaces/${workspaceId}`}
      backHref={`/workspaces/${workspaceId}`}
      backLabel="Back to Workspace"
      title="Members"
      subtitle="Manage who has access to this workspace and all its projects"
      membersDescription="Admins can manage projects and members. Commentators can view and comment only."
    />
  );
}
