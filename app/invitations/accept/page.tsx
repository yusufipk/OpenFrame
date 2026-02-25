import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { acceptInvitationTokenForUser } from '@/lib/invitations';

interface InvitationAcceptPageProps {
  searchParams: Promise<{
    token?: string;
    email?: string;
  }>;
}

export default async function InvitationAcceptPage({ searchParams }: InvitationAcceptPageProps) {
  const resolvedSearchParams = await searchParams;
  const token = resolvedSearchParams.token?.trim();

  if (!token) {
    redirect('/login?error=invalid_invitation');
  }

  const session = await auth();
  if (!session?.user?.id) {
    const callbackUrl = `/invitations/accept?token=${encodeURIComponent(token)}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const userEmail = session.user.email?.toLowerCase().trim();
  if (!userEmail) {
    redirect('/dashboard?invite=invalid_email');
  }

  const result = await acceptInvitationTokenForUser({
    token,
    userId: session.user.id,
    email: userEmail,
  });

  if (result === 'accepted') {
    redirect('/dashboard?invite=accepted');
  }
  if (result === 'expired') {
    redirect('/dashboard?invite=expired');
  }
  if (result === 'forbidden') {
    redirect('/dashboard?invite=wrong_account');
  }
  redirect('/dashboard?invite=not_found');
}
