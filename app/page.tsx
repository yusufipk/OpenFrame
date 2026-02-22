import { LandingPage } from '@/components/LandingPage';
import { auth } from '@/lib/auth';

export default async function HomePage() {
  const session = await auth();

  return <LandingPage isLoggedIn={Boolean(session?.user)} />;
}
