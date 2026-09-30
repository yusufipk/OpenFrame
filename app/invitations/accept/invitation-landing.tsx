import Link from 'next/link';
import { Video, UserPlus, LogIn, MailWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { InvitationPreview } from '@/lib/invitations';

interface InvitationLandingProps {
  token: string;
  preview: InvitationPreview | null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center justify-center gap-2 mb-8">
          <Video className="h-8 w-8 text-primary" />
          <span className="font-bold text-2xl">OpenFrame</span>
        </Link>
        {children}
      </div>
    </div>
  );
}

function UnusableInvitation({ title, message }: { title: string; message: string }) {
  return (
    <Shell>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="flex items-center justify-center gap-2">
            <MailWarning className="h-5 w-5 text-amber-500" />
            {title}
          </CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild className="w-full">
            <Link href="/login">Sign in</Link>
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Ask whoever invited you to send a new invitation link.
          </p>
        </CardContent>
      </Card>
    </Shell>
  );
}

/** Too many unauthenticated invitation lookups from this client — nothing was queried. */
export function InvitationRateLimited() {
  return (
    <UnusableInvitation
      title="Too many attempts"
      message="We couldn't check this invitation right now. Please wait a few minutes and open the link again."
    />
  );
}

/** Signed in, but with an account whose address the invitation was not issued to. */
export function InvitationAccountMismatch({
  invitedEmail,
  signedInEmail,
}: {
  invitedEmail: string;
  signedInEmail: string;
}) {
  return (
    <Shell>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="flex items-center justify-center gap-2">
            <MailWarning className="h-5 w-5 text-amber-500" />
            Wrong account
          </CardTitle>
          <CardDescription>
            This invitation was sent to <strong>{invitedEmail}</strong>, but you are signed in as{' '}
            <strong>{signedInEmail}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild className="w-full">
            <Link href="/signout">Sign out and switch account</Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            After signing out, open the invitation link from your email again.
          </p>
        </CardContent>
      </Card>
    </Shell>
  );
}

export function InvitationLanding({ token, preview }: InvitationLandingProps) {
  const acceptPath = `/invitations/accept?token=${encodeURIComponent(token)}`;
  const loginHref = `/login?callbackUrl=${encodeURIComponent(acceptPath)}`;

  if (!preview) {
    return (
      <UnusableInvitation
        title="Invitation not found"
        message="This invitation link is invalid. It may have been revoked or replaced by a newer one."
      />
    );
  }

  if (preview.status === 'CANCELED') {
    return (
      <UnusableInvitation
        title="Invitation revoked"
        message="This invitation is no longer valid."
      />
    );
  }

  if (preview.status === 'EXPIRED' || preview.isExpired) {
    return (
      <UnusableInvitation
        title="Invitation expired"
        message={`The invitation sent to ${preview.email} has expired.`}
      />
    );
  }

  const registerHref =
    `/register?invitationToken=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(preview.email)}` +
    `&callbackUrl=${encodeURIComponent(acceptPath)}`;

  const alreadyAccepted = preview.status === 'ACCEPTED';
  const targetLabel = preview.targetName
    ? `${preview.targetName} (${preview.scopeLabel})`
    : `a ${preview.scopeLabel}`;

  return (
    <Shell>
      <Card>
        <CardHeader className="text-center">
          <CardTitle>You&apos;ve been invited</CardTitle>
          <CardDescription>
            {preview.inviterName} invited you to join <strong>{targetLabel}</strong> on OpenFrame as{' '}
            {preview.roleLabel}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="text-muted-foreground">
              This invitation was sent to{' '}
              <strong className="text-foreground">{preview.email}</strong>.{' '}
              {preview.hasAccount || alreadyAccepted ? 'Sign in with' : 'Use'} that address to
              accept it.
            </p>
          </div>

          {preview.hasAccount || alreadyAccepted ? (
            <>
              <Button asChild className="w-full">
                <Link href={loginHref}>
                  <LogIn className="h-4 w-4 mr-2" />
                  Sign in to accept
                </Link>
              </Button>
              {!alreadyAccepted && (
                <p className="text-center text-sm text-muted-foreground">
                  Wrong address?{' '}
                  <Link href={registerHref} className="text-primary hover:underline">
                    Create an account instead
                  </Link>
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                You don&apos;t have an OpenFrame account yet. Create one to open this{' '}
                {preview.scopeLabel} — we&apos;ll bring you right back here once you&apos;re signed
                in.
              </p>
              <Button asChild className="w-full">
                <Link href={registerHref}>
                  <UserPlus className="h-4 w-4 mr-2" />
                  Create your account
                </Link>
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <Link href={loginHref} className="text-primary hover:underline">
                  Sign in
                </Link>
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}
