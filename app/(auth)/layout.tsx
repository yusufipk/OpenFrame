import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  // If already logged in, redirect to dashboard
  if (session?.user) {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
