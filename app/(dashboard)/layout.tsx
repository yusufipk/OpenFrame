import { Header, TrialBanner } from '@/components/layout';
import { auth } from '@/lib/auth';
import { hasAppNavigationAccess } from '@/lib/route-access';
import { getTrialNotice } from '@/lib/billing';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const userId = session?.user?.id;
  const [showAppNavigation, trialNotice] = await Promise.all([
    userId ? hasAppNavigationAccess(userId) : false,
    userId ? getTrialNotice(userId) : null,
  ]);

  return (
    <div className="relative flex min-h-screen flex-col">
      <Header user={session?.user ?? null} showAppNavigation={showAppNavigation} />
      {trialNotice ? <TrialBanner notice={trialNotice} /> : null}
      <main className="flex-1">{children}</main>
    </div>
  );
}
