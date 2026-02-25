'use client';

import { useParams } from 'next/navigation';
import { MembersManagementPage } from '@/components/members-management-page';

export default function WorkspaceMembersPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <MembersManagementPage
      apiBasePath={`/api/workspaces/${workspaceId}`}
      backHref={`/workspaces/${workspaceId}`}
      backLabel="Back to Workspace"
      title="Members"
      subtitle="Manage who has access to this workspace and all its projects"
      membersDescription="Admins can manage projects and members. Commentators can view and comment only."
      forbiddenRedirect="/workspaces"
    />
  );
}
