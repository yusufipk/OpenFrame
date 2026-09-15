import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { acceptInvitationTokenForUser, getInvitationPreviewByToken } from '@/lib/invitations';
import { isInvitationPreviewAllowed } from '@/lib/invitation-preview-limit';
import {
  InvitationAccountMismatch,
  InvitationLanding,
  InvitationRateLimited,
} from './invitation-landing';

interface InvitationAcceptPageProps {
  searchParams: Promise<{
    token?: string;
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
    // Signed-out visitors get the invitation itself instead of a bare login form:
    // most of them have no account yet and need to be told to create one. This is the
    // only unauthenticated read of invitation data, so it is IP-throttled.
    if (!(await isInvitationPreviewAllowed(token))) {
      return <InvitationRateLimited />;
    }

    const preview = await getInvitationPreviewByToken(token);
    return <InvitationLanding token={token} preview={preview} />;
  }

  const invitation = await db.invitation.findUnique({
    where: { token },
    select: {
      id: true,
      email: true,
      status: true,
      scope: true,
      workspaceId: true,
      projectId: true,
      folderId: true,
      videoId: true,
    },
  });

  function redirectToInvitationTarget(inviteStatus: string) {
    if (invitation?.scope === 'VIDEO' && invitation.videoId)
      redirect(`/projects/${invitation.projectId}/videos/${invitation.videoId}`);
    if (invitation?.scope === 'FOLDER' && invitation.folderId && invitation.projectId)
      redirect(`/projects/${invitation.projectId}?folderId=${invitation.folderId}`);
    if (invitation?.scope === 'WORKSPACE' && invitation.workspaceId) {
      redirect(`/workspaces/${invitation.workspaceId}?invite=${inviteStatus}`);
    }
    if (invitation?.scope === 'PROJECT' && invitation.projectId) {
      redirect(`/projects/${invitation.projectId}?invite=${inviteStatus}`);
    }
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
    redirectToInvitationTarget('accepted');
    redirect('/dashboard?invite=accepted');
  }
  if (result === 'expired') {
    redirectToInvitationTarget('expired');
    redirect('/dashboard?invite=expired');
  }
  if (result === 'forbidden') {
    // Signed in with a different address than the one invited , say so instead of
    // dropping the user on the dashboard with no explanation.
    return (
      <InvitationAccountMismatch
        invitedEmail={invitation?.email ?? 'another address'}
        signedInEmail={userEmail}
      />
    );
  }

  if (result === 'not_found' && invitation?.status === 'ACCEPTED') {
    redirectToInvitationTarget('already_accepted');
  }

  redirect('/dashboard?invite=not_found');
}
