import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Header } from '@/components/layout';
import Link from 'next/link';
import { LayoutDashboard, MessageSquareQuote, Users } from 'lucide-react';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user?.isAdmin) {
    redirect('/');
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <Header user={session.user} showAppNavigation />
      <div className="w-full px-4 md:px-8 flex-1 items-start md:grid md:grid-cols-[220px_minmax(0,1fr)] md:gap-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-10">
        {/* Mobile Nav */}
        <div className="md:hidden py-4 border-b mb-4">
          <nav className="flex items-center gap-4 overflow-x-auto">
            <Link
              href="/admin"
              className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/50"
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </Link>
            <Link
              href="/admin/users"
              className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/50"
            >
              <Users className="h-4 w-4" />
              Users
            </Link>
            <Link
              href="/admin/feedback"
              className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/50"
            >
              <MessageSquareQuote className="h-4 w-4" />
              Feedback
            </Link>
          </nav>
        </div>
        {/* Desktop Nav */}
        <aside className="fixed top-14 z-30 -ml-2 hidden h-[calc(100vh-3.5rem)] w-full shrink-0 md:sticky md:block">
          <div className="h-full py-6 pr-6 lg:py-8">
            <nav className="flex flex-col gap-2">
              <Link
                href="/admin"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </Link>
              <Link
                href="/admin/users"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                <Users className="h-4 w-4" />
                Users
              </Link>
              <Link
                href="/admin/feedback"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                <MessageSquareQuote className="h-4 w-4" />
                Feedback
              </Link>
            </nav>
          </div>
        </aside>
        <main className="flex w-full flex-col overflow-hidden py-0 md:py-6 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
