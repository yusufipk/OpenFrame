import { auth } from '@/lib/auth';
import { buildBillingAccessWhereInput, getBillingOverview } from '@/lib/billing';
import { db } from '@/lib/db';
import { redirect } from 'next/navigation';
import { OnboardingWizard } from './onboarding-wizard';

export default async function OnboardingPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const [user, billing, creatableWorkspaces] = await Promise.all([
    db.user.findUnique({
      where: { id: session.user.id },
      select: { onboardingCompletedAt: true, name: true, email: true },
    }),
    getBillingOverview(session.user.id),
    db.workspace.findMany({
      where: {
        owner: buildBillingAccessWhereInput(),
        OR: [
          { ownerId: session.user.id },
          { members: { some: { userId: session.user.id, role: 'ADMIN' } } },
        ],
      },
      select: {
        id: true,
        name: true,
        ownerId: true,
      },
      orderBy: { name: 'asc' },
    }),
  ]);

  if (user?.onboardingCompletedAt) {
    redirect('/dashboard');
  }

  const userName = user?.name || user?.email?.split('@')[0] || 'there';

  return (
    <OnboardingWizard
      userName={userName}
      canCreateWorkspace={billing.workspaceCreation.canCreateWorkspace}
      availableWorkspaces={creatableWorkspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        isOwner: workspace.ownerId === session.user.id,
      }))}
    />
  );
}
