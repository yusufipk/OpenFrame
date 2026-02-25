'use client';

import { useParams } from 'next/navigation';
import { MembersManagementPage } from '@/components/members-management-page';

export default function ProjectMembersPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <MembersManagementPage
      apiBasePath={`/api/projects/${projectId}`}
      backHref={`/projects/${projectId}`}
      backLabel="Back to Project"
      title="Project Members"
      subtitle="Manage who has access to this project. Admins can manage settings and delete content. Commentators can only view and leave comments."
      membersDescription={
        <>
          <strong>Admin</strong> - can manage project settings, members, and delete content.{' '}
          <strong>Commentator</strong> - can view and comment only.
        </>
      }
      forbiddenRedirect="/dashboard"
    />
  );
}
