'use client';
import { useState } from 'react';
import { Share2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
type Pending = { id: string; email: string; role: string };
export function ContentAccessControls({
  projectId,
  folderId,
  videoId,
  contentName,
  share = false,
}: {
  projectId: string;
  folderId?: string | null;
  videoId?: string;
  contentName?: string;
  share?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('COMMENTATOR');
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Pending[]>([]);
  const [invitationUrl, setInvitationUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [accessMode, setAccessMode] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    confirmationToken: string;
    body: Record<string, unknown>;
  } | null>(null);
  const selectedMode = confirmation?.body.accessMode ?? accessMode;
  const accessDescription =
    selectedMode === 'RESTRICTED'
      ? 'Account access is limited to invited members. Project and workspace managers retain access.'
      : 'Members with access to the parent can access this area.';
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
      if (payload.data.accessMode) setAccessMode(payload.data.accessMode);
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
          setConfirmation(null);
          setAccessMode(null);
          void run({ action: 'members' });
        }}
      >
        {share && <Share2 className="h-4 w-4 mr-2" />}
        {share ? 'Share' : 'Manage access'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {contentName ? `Share folder: ${contentName}` : 'Content access'}
            </DialogTitle>
            <DialogDescription>Choose who can access this area.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button
              disabled={busy || !accessMode}
              variant={selectedMode === 'INHERIT' ? 'default' : 'outline'}
              aria-pressed={selectedMode === 'INHERIT'}
              onClick={() =>
                accessMode === 'INHERIT'
                  ? setConfirmation(null)
                  : void run({ action: 'access', accessMode: 'INHERIT' })
              }
            >
              Inherit parent access
            </Button>
            <Button
              disabled={busy || !accessMode}
              variant={selectedMode === 'RESTRICTED' ? 'default' : 'outline'}
              aria-pressed={selectedMode === 'RESTRICTED'}
              onClick={() =>
                accessMode === 'RESTRICTED'
                  ? setConfirmation(null)
                  : void run({ action: 'access', accessMode: 'RESTRICTED' })
              }
            >
              Restrict access
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {accessMode ? (confirmation?.message ?? accessDescription) : 'Loading access...'}
          </p>
          {confirmation && (
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
          )}
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
            <Select value={role} onValueChange={setRole} disabled={busy}>
              <SelectTrigger aria-label="Invitation role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="COMMENTATOR">Commentator: view and comment</SelectItem>
                <SelectItem value="ADMIN">Admin: manage this area</SelectItem>
              </SelectContent>
            </Select>
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
        </DialogContent>
      </Dialog>
    </>
  );
}
