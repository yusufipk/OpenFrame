'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

type Member = { id: string; role: string; user: { name: string | null; email: string | null } };
type Pending = { id: string; email: string; role: string };
export function ContentAccessControls({
  projectId,
  folderId,
  videoId,
}: {
  projectId: string;
  folderId?: string | null;
  videoId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('COMMENTATOR');
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Pending[]>([]);
  const [invitationUrl, setInvitationUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    confirmationToken: string;
    body: Record<string, unknown>;
  } | null>(null);
  async function run(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, folderId, videoId }),
      });
      const payload = await res.json();
      if (!res.ok)
        throw new Error(payload.error?.message ?? payload.error ?? 'Could not update access');
      if (payload.data.needsConfirmation) {
        setConfirmation({ ...payload.data, body });
        return;
      }
      setConfirmation(null);
      if (payload.data.members) {
        setMembers(payload.data.members);
        setInvitations(payload.data.invitations);
      } else if (payload.data.invitationUrl) setInvitationUrl(payload.data.invitationUrl);
      else {
        toast.success('Access updated');
        router.refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update access');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          void run({ action: 'members' });
        }}
      >
        Manage access
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Content access</DialogTitle>
            <DialogDescription>
              Project and workspace managers can access this content. Invitations grant access only
              to this area, never project or workspace membership.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void run({ action: 'access', accessMode: 'INHERIT' })}
            >
              Inherit parent access
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void run({ action: 'access', accessMode: 'RESTRICTED' })}
            >
              Restrict access
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Restriction cuts off normal parent members. Existing video links are revoked after
            confirmation. A new video link grants separate access to that video and its versions.
          </p>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ action: 'invite', email, role });
            }}
          >
            <Input
              type="email"
              aria-label="Invitation email"
              placeholder="Email address"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select
              aria-label="Invitation role"
              className="w-full rounded-md border bg-background p-2"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="COMMENTATOR">Commentator: view and comment</option>
              <option value="ADMIN">Admin: manage this area</option>
            </select>
            <Button disabled={busy}>Create account invitation</Button>
          </form>
          {invitationUrl && (
            <div>
              <p className="text-sm">
                Send this invitation to the invited email address. It expires in 7 days.
              </p>
              <Input aria-label="Invitation link" readOnly value={invitationUrl} />
            </div>
          )}
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
            <div className="flex justify-between gap-2" key={i.id}>
              <span>{i.email} (pending)</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  await run({ action: 'revokeInvitation', invitationId: i.id });
                  await run({ action: 'members' });
                }}
              >
                Cancel
              </Button>
            </div>
          ))}
          {confirmation && (
            <div className="rounded border p-3 space-y-2">
              <p>{confirmation.message}</p>
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
              <Button variant="ghost" onClick={() => setConfirmation(null)}>
                Cancel
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
