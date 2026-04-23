import { Header } from '@/components/layout';
import { auth } from '@/lib/auth';
import { hasAppNavigationAccess } from '@/lib/route-access';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const showAppNavigation = session?.user?.id
    ? await hasAppNavigationAccess(session.user.id)
    : false;

  return (
    <div className="relative flex min-h-screen flex-col">
      <Header user={session?.user ?? null} showAppNavigation={showAppNavigation} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
