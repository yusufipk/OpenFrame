'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Clock3,
  Crown,
  Loader2,
  MailX,
  MessageSquare,
  Plus,
  Shield,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEditorLimitDialog } from '@/components/editor-limit-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  parseInvitationEmails,
  sendInvitationBatch,
  invitationDeliveryMessage,
  type InvitationResult,
} from '@/lib/invitation-batch';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Member {
  id: string;
  role: 'ADMIN' | 'COMMENTATOR';
  userId: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
  };
}

interface Owner {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

interface PendingInvitation {
  id: string;
  email: string;
  role: 'ADMIN' | 'COMMENTATOR';
  createdAt: string;
  expiresAt: string;
  invitationUrl: string;
  invitedBy: {
    id: string;
    name: string | null;
    email: string | null;
  };
}

interface MembersManagementPageProps {
  apiBasePath: string;
  backHref: string;
  backLabel: string;
  title: string;
  subtitle: string;
  membersDescription: ReactNode;
}

export function MembersManagementPage({
  apiBasePath,
  backHref,
  backLabel,
  title,
  subtitle,
  membersDescription,
}: MembersManagementPageProps) {
  const router = useRouter();

  const [members, setMembers] = useState<Member[]>([]);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'COMMENTATOR'>('COMMENTATOR');
  const [isInviting, setIsInviting] = useState(false);
  const [cancelingInvitationId, setCancelingInvitationId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [returnedInvitations, setReturnedInvitations] = useState<InvitationResult[]>([]);
  const editorLimit = useEditorLimitDialog();

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(`${apiBasePath}/members`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        if (res.status === 401) {
          router.push('/login');
          return;
        }
        if (res.status === 403) {
          router.push('/dashboard');
          return;
        }
        // Any other status has to say so. Returning silently rendered "No members yet"
        // and "No pending invitations" on a workspace that has both, and the user's next
        // move was to re-invite somebody who is already a member, which answers 409 and
        // reads as a second, unrelated bug.
        setError('Failed to load members. Please refresh to try again.');
        return;
      }
      const data = await res.json();
      setMembers(data.data.members);
      setOwner(data.data.owner);
      setPendingInvitations(data.data.pendingInvitations || []);
      setReturnedInvitations((previous) =>
        previous.filter(
          (result) =>
            !data.data.pendingInvitations?.some(
              (invitation: PendingInvitation) => invitation.invitationUrl === result.invitationUrl
            )
        )
      );
    } catch {
      setError('Failed to load members');
    } finally {
      setIsLoading(false);
    }
  }, [apiBasePath, router]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void fetchMembers();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [fetchMembers]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsInviting(true);
    setError('');
    setSuccess('');

    try {
      const results = await sendInvitationBatch(
        `${apiBasePath}/members`,
        parseInvitationEmails(inviteEmail),
        { role: inviteRole }
      );
      const failures = results.filter((result) => result.error);
      setReturnedInvitations((previous) => [
        ...previous.filter(
          (old) => !results.some((result) => !result.error && result.email === old.email)
        ),
        ...results.filter((result) => !result.error && result.invitationUrl),
      ]);
      setError(
        failures
          .filter((result) => !editorLimit.handle(result.errorPayload))
          .map((result) => `${result.email}: ${result.error}`)
          .join(' ')
      );
      setSuccess(
        results
          .filter((result) => !result.error)
          .map(invitationDeliveryMessage)
          .join(' ')
      );
      setInviteEmail(failures.map((result) => result.email).join('\n'));
      await fetchMembers();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not send invitations');
    } finally {
      setIsInviting(false);
    }
  };

  const handleResend = async (invitation: PendingInvitation) => {
    setIsInviting(true);
    setError('');
    setSuccess('');
    try {
      const [result] = await sendInvitationBatch(`${apiBasePath}/members`, [invitation.email], {
        role: invitation.role,
      });
      if (result.error) {
        if (!editorLimit.handle(result.errorPayload)) setError(result.error);
      } else {
        setSuccess(invitationDeliveryMessage(result));
        setReturnedInvitations((previous) => [
          ...previous.filter((old) => old.email !== result.email),
          result,
        ]);
      }
      await fetchMembers();
    } finally {
      setIsInviting(false);
    }
  };

  const handleCopyLink = async (invitation: { email: string; invitationUrl: string }) => {
    try {
      await navigator.clipboard.writeText(invitation.invitationUrl);
      setSuccess(`Invitation link copied for ${invitation.email}.`);
    } catch {
      setError('Could not copy. Select the invitation link and copy it manually.');
    }
  };

  const handleRoleChange = async (memberId: string, newRole: string) => {
    try {
      const res = await fetch(`${apiBasePath}/members/${memberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const data = await res.json();
        if (!editorLimit.handle(data)) setError(data.error || 'Failed to update role');
        return;
      }

      fetchMembers();
    } catch {
      setError('Failed to update role');
    }
  };

  const handleRemove = async (memberId: string) => {
    if (!confirm('Are you sure you want to remove this member?')) return;

    try {
      const res = await fetch(`${apiBasePath}/members/${memberId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to remove member');
        return;
      }

      fetchMembers();
    } catch {
      setError('Failed to remove member');
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    setCancelingInvitationId(invitationId);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`${apiBasePath}/members/invitations/${invitationId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to cancel invitation');
        return;
      }

      setSuccess('Invitation canceled');
      fetchMembers();
    } catch {
      setError('Failed to cancel invitation');
    } finally {
      setCancelingInvitationId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50dvh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="px-6 lg:px-8 py-8 w-full max-w-4xl mx-auto">
      {editorLimit.dialog}
      <div className="mb-6">
        <Link
          href={backHref}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          {backLabel}
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-1">{subtitle}</p>
      </div>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Invite Member
          </CardTitle>
          <CardDescription>
            Invite someone by email. They must have an account to be added.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="w-full sm:flex-1">
              <Label htmlFor="email" className="mb-2 block">
                Email Addresses
              </Label>
              <Textarea
                id="email"
                placeholder="Email addresses, separated by commas or new lines"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
                disabled={isInviting}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Invite up to 20 people at a time.
              </p>
            </div>
            <div className="w-full sm:w-40">
              <Label className="mb-2 block">Role</Label>
              <Select
                value={inviteRole}
                disabled={isInviting}
                onValueChange={(v) => setInviteRole(v as 'ADMIN' | 'COMMENTATOR')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                  <SelectItem value="COMMENTATOR">Commentator</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={isInviting} className="w-full sm:w-auto">
              {isInviting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1" />
                  Invite
                </>
              )}
            </Button>
          </form>

          {error && (
            <div className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          {success && (
            <div className="mt-3 rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">
              {success}
            </div>
          )}
          {returnedInvitations
            .filter(
              (result) =>
                !pendingInvitations.some(
                  (invitation) => invitation.invitationUrl === result.invitationUrl
                )
            )
            .map((result) => (
              <div key={result.email} className="mt-3 space-y-2 rounded-md border p-3">
                <p className="break-all text-sm">{result.email}</p>
                <Input
                  readOnly
                  aria-label={`Invitation link for ${result.email}`}
                  value={result.invitationUrl}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void handleCopyLink({
                      email: result.email,
                      invitationUrl: result.invitationUrl!,
                    })
                  }
                >
                  Copy link
                </Button>
              </div>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current Members</CardTitle>
          <CardDescription>{membersDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {owner && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 sm:gap-0 p-3 rounded-lg bg-accent/30">
              <div className="flex items-center gap-3">
                <Avatar className="h-9 w-9">
                  <AvatarImage src={owner.image ?? undefined} />
                  <AvatarFallback>{owner.name?.charAt(0).toUpperCase() ?? 'U'}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium">{owner.name || 'Unnamed'}</p>
                  <p className="text-xs text-muted-foreground">{owner.email}</p>
                </div>
              </div>
              <Badge variant="default" className="flex items-center gap-1">
                <Crown className="h-3 w-3" />
                Owner
              </Badge>
            </div>
          )}

          {members.map((member) => (
            <div
              key={member.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 sm:gap-0 p-3 rounded-lg border"
            >
              <div className="flex items-center gap-3">
                <Avatar className="h-9 w-9">
                  <AvatarImage src={member.user.image ?? undefined} />
                  <AvatarFallback>
                    {member.user.name?.charAt(0).toUpperCase() ?? 'U'}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium">{member.user.name || 'Unnamed'}</p>
                  <p className="text-xs text-muted-foreground">{member.user.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <Select value={member.role} onValueChange={(v) => handleRoleChange(member.id, v)}>
                  <SelectTrigger className="w-full sm:w-36 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADMIN">
                      <span className="flex items-center gap-1.5">
                        <Shield className="h-3.5 w-3.5" />
                        Admin
                      </span>
                    </SelectItem>
                    <SelectItem value="COMMENTATOR">
                      <span className="flex items-center gap-1.5">
                        <MessageSquare className="h-3.5 w-3.5" />
                        Commentator
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleRemove(member.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}

          {members.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No members yet. Invite someone above.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock3 className="h-5 w-5" />
            Pending Invitations
          </CardTitle>
          <CardDescription>
            Invitations awaiting acceptance. Copy a link or resend the email.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pendingInvitations.map((invitation) => (
            <div
              key={invitation.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-3 rounded-lg border"
            >
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm font-medium">{invitation.email}</p>
                <p className="text-xs text-muted-foreground">
                  {invitation.role === 'ADMIN' ? 'Admin' : 'Commentator'} · Sent by{' '}
                  {invitation.invitedBy.name || invitation.invitedBy.email || 'Unknown'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Expires {new Date(invitation.expiresAt).toLocaleString()}
                </p>
                <Input
                  className="mt-2"
                  readOnly
                  aria-label={`Invitation link for ${invitation.email}`}
                  value={invitation.invitationUrl}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isInviting || cancelingInvitationId !== null}
                  onClick={() => void handleCopyLink(invitation)}
                >
                  Copy link
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isInviting || cancelingInvitationId !== null}
                  onClick={() => void handleResend(invitation)}
                >
                  Resend
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleCancelInvitation(invitation.id)}
                  disabled={isInviting || cancelingInvitationId !== null}
                >
                  {cancelingInvitationId === invitation.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <MailX className="h-4 w-4 mr-2" />
                      Cancel
                    </>
                  )}
                </Button>
              </div>
            </div>
          ))}

          {pendingInvitations.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No pending invitations.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
