import { MembersManagementPage } from '@/components/members-management-page';
import { requireProjectAccessOrRedirect } from '@/lib/route-access';

interface ProjectMembersPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectMembersPage({ params }: ProjectMembersPageProps) {
  const { projectId } = await params;

  await requireProjectAccessOrRedirect({
    projectId,
    intent: 'manage',
  });

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
    />
  );
}
