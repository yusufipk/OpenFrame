import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { requireProjectAccessOrRedirect } from '@/lib/route-access';
import ProjectSettingsPageClient from './project-settings-page-client';

interface ProjectSettingsPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectSettingsPage({ params }: ProjectSettingsPageProps) {
  const { projectId } = await params;
  const session = await auth();

  await requireProjectAccessOrRedirect({
    projectId,
    userId: session?.user?.id,
    intent: 'manage',
  });

  const preferences = session?.user?.id
    ? await db.user.findUnique({
        where: { id: session.user.id },
        select: { requireProjectDeleteNameConfirmation: true },
      })
    : null;

  return (
    <ProjectSettingsPageClient
      projectId={projectId}
      requireDeleteNameConfirmation={preferences?.requireProjectDeleteNameConfirmation ?? true}
    />
  );
}
