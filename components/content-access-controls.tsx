'use client';
import { useId, useState } from 'react';
import { Share2, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useEditorLimitDialog } from '@/components/editor-limit-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ACCESS_MODE_LABELS, accessModeDescription } from '@/lib/content-access-copy';
import {
  parseInvitationEmails,
  sendInvitationBatch,
  invitationDeliveryMessage,
  type InvitationResult,
} from '@/lib/invitation-batch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

type Member = { id: string; role: string; user: { name: string | null; email: string | null } };
type Pending = { id: string; email: string; role: string; invitationUrl: string };
export function ContentAccessControls({
  projectId,
  folderId,
  videoId,
  contentName,
  share = false,
  showMembers = false,
  onAccessChanged,
}: {
  projectId: string;
  folderId?: string | null;
  videoId?: string;
  contentName?: string;
  share?: boolean;
  showMembers?: boolean;
  onAccessChanged?: () => void;
}) {
  const invitationFormId = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('COMMENTATOR');
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Pending[]>([]);
  const [delivery, setDelivery] = useState<string[]>([]);
  const [returnedInvitations, setReturnedInvitations] = useState<InvitationResult[]>([]);
  const [busy, setBusy] = useState(false);
  const editorLimit = useEditorLimitDialog();
  const [accessMode, setAccessMode] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    confirmationToken: string;
    body: Record<string, unknown>;
  } | null>(null);
  const selectedMode = confirmation?.body.accessMode ?? accessMode;
  const contentKind = videoId ? 'video' : 'folder';
  async function run(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, folderId, videoId }),
      });
      const payload = await res.json();
      if (!res.ok && editorLimit.handle(payload)) return;
      if (!res.ok)
        throw new Error(payload.error?.message ?? payload.error ?? 'Could not update access');
      if (payload.data.needsConfirmation) {
        setConfirmation({ ...payload.data, body });
        return;
      }
      setConfirmation(null);
      if (payload.data.accessMode) setAccessMode(payload.data.accessMode);
      if (payload.data.members) {
        setMembers(payload.data.members);
        setInvitations(payload.data.invitations);
        setReturnedInvitations((previous) =>
          previous.filter(
            (result) =>
              !payload.data.invitations.some(
                (invitation: Pending) => invitation.invitationUrl === result.invitationUrl
              )
          )
        );
      } else {
        onAccessChanged?.();
        toast.success('Access updated');
        router.refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update access');
    } finally {
      setBusy(false);
    }
  }
  async function invite(input: string, inviteRole: string, resend = false) {
    try {
      const emails = parseInvitationEmails(input);
      setBusy(true);
      setDelivery([]);
      const results = await sendInvitationBatch(`/api/projects/${projectId}/folders`, emails, {
        action: 'invite',
        folderId,
        videoId,
        role: inviteRole,
      });
      const failures = results.filter((result) => result.error);
      for (const result of failures) {
        if (!editorLimit.handle(result.errorPayload))
          toast.error(`${result.email}: ${result.error}`);
      }
      setDelivery(results.filter((result) => !result.error).map(invitationDeliveryMessage));
      setReturnedInvitations((previous) => [
        ...previous.filter(
          (old) => !results.some((result) => !result.error && result.email === old.email)
        ),
        ...results.filter((result) => !result.error && result.invitationUrl),
      ]);
      if (!resend) setEmail(failures.map((result) => result.email).join('\n'));
      await run({ action: 'members' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send invitation');
    } finally {
      setBusy(false);
    }
  }
  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Invitation link copied');
    } catch {
      toast.error('Could not copy. Select the invitation link and copy it manually.');
    }
  }
  return (
    <>
      {editorLimit.dialog}
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          setConfirmation(null);
          setAccessMode(null);
          void run({ action: 'members' });
        }}
      >
        {showMembers ? (
          <Users className="h-4 w-4 mr-2" />
        ) : (
          share && <Share2 className="h-4 w-4 mr-2" />
        )}
        {showMembers ? 'Members' : share ? 'Share' : 'Manage access'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden">
          <DialogHeader className="pr-6">
            <DialogTitle>
              {contentName
                ? `${showMembers ? 'Folder members' : 'Share folder'}: ${contentName}`
                : 'Content access'}
            </DialogTitle>
            <DialogDescription>Choose who can open this {contentKind}.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto">
            {accessMode ? (
              <RadioGroup
                aria-label="Access"
                value={typeof selectedMode === 'string' ? selectedMode : accessMode}
                onValueChange={(mode) => {
                  // The group stays enabled while a request runs so keyboard focus is kept.
                  if (busy) return;
                  if (accessMode === mode) setConfirmation(null);
                  else void run({ action: 'access', accessMode: mode });
                }}
              >
                {(['INHERIT', 'RESTRICTED'] as const).map((mode) => (
                  <Label
                    key={mode}
                    htmlFor={`${invitationFormId}-access-${mode}`}
                    className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary"
                  >
                    <RadioGroupItem
                      id={`${invitationFormId}-access-${mode}`}
                      value={mode}
                      aria-labelledby={`${invitationFormId}-access-${mode}-label`}
                      aria-describedby={`${invitationFormId}-access-${mode}-help`}
                      className="mt-0.5"
                    />
                    <span className="space-y-1">
                      <span
                        id={`${invitationFormId}-access-${mode}-label`}
                        className="block font-medium"
                      >
                        {ACCESS_MODE_LABELS[mode]}
                      </span>
                      <span
                        id={`${invitationFormId}-access-${mode}-help`}
                        className="block text-sm text-muted-foreground"
                      >
                        {accessModeDescription(mode, contentKind)}
                      </span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            ) : (
              <p className="text-sm text-muted-foreground">Loading access...</p>
            )}
            {confirmation && (
              <div className="space-y-2">
                <p role="status" className="text-sm">
                  {confirmation.message}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run({
                        ...confirmation.body,
                        confirmationToken: confirmation.confirmationToken,
                      })
                    }
                  >
                    Confirm access change
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void invite(email, role);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor={`${invitationFormId}-email`}>Email Addresses</Label>
                <Textarea
                  id={`${invitationFormId}-email`}
                  aria-label="Invitation email"
                  aria-describedby={`${invitationFormId}-help`}
                  placeholder="Email addresses, separated by commas or new lines"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                />
                <p id={`${invitationFormId}-help`} className="text-xs text-muted-foreground">
                  Invite up to 20 people at a time.
                </p>
              </div>
              <Label htmlFor={`${invitationFormId}-role`}>Role</Label>
              <Select value={role} onValueChange={setRole} disabled={busy}>
                <SelectTrigger
                  id={`${invitationFormId}-role`}
                  aria-label="Invitation role"
                  className="w-full data-[size=default]:h-10"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="COMMENTATOR">Commentator: view and comment</SelectItem>
                  <SelectItem value="ADMIN">Admin: manage this area</SelectItem>
                </SelectContent>
              </Select>
              <Button disabled={busy} className="h-10 w-full">
                Send invitations
              </Button>
            </form>
            {delivery.length > 0 && (
              <div role="status" className="space-y-1 break-words text-sm">
                {delivery.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            )}
            {returnedInvitations
              .filter(
                (result) =>
                  !invitations.some(
                    (invitation) => invitation.invitationUrl === result.invitationUrl
                  )
              )
              .map((result) => (
                <div key={result.email} className="space-y-2 rounded-md border p-3">
                  <p className="break-all text-sm">{result.email}</p>
                  <Input
                    readOnly
                    aria-label={`Invitation link for ${result.email}`}
                    value={result.invitationUrl}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copyLink(result.invitationUrl!)}
                  >
                    Copy link
                  </Button>
                </div>
              ))}
            {members.map((m) => (
              <div className="flex justify-between gap-2" key={m.id}>
                <span>
                  {m.user.name ?? m.user.email} ({m.role})
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    await run({ action: 'revokeMember', memberId: m.id });
                    await run({ action: 'members' });
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
            {invitations.map((i) => (
              <div className="space-y-2 rounded-md border p-3" key={i.id}>
                <span className="block break-all text-sm">{i.email} (pending)</span>
                <Input
                  aria-label={
                    invitations.length === 1 ? 'Invitation link' : `Invitation link for ${i.email}`
                  }
                  readOnly
                  value={i.invitationUrl}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void copyLink(i.invitationUrl)}
                  >
                    Copy link
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void invite(i.email, i.role, true)}
                  >
                    Resend
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      await run({ action: 'revokeInvitation', invitationId: i.id });
                      setDelivery([]);
                      await run({ action: 'members' });
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
