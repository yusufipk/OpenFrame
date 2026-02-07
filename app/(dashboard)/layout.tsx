import { Header } from '@/components/layout';
import { auth } from '@/lib/auth';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <div className="relative flex min-h-screen flex-col">
      <Header user={session?.user ?? null} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
