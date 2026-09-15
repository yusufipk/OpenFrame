'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Folder, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ContentAccessControls } from '@/components/content-access-controls';
export type FolderEntry = {
  id: string;
  name: string;
  parentId: string | null;
  accessMode: string;
  canEdit: boolean;
};
export function ProjectFolderBrowser({
  projectId,
  folderId,
  folders,
  canEdit,
  canSeeRoot,
  all,
}: {
  projectId: string;
  folderId: string | null;
  folders: FolderEntry[];
  canEdit: boolean;
  canSeeRoot: boolean;
  all: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    confirmationToken: string;
    body: Record<string, unknown>;
  } | null>(null);
  const current = folders.find((f) => f.id === folderId);
  const ancestors: FolderEntry[] = [];
  let ancestor = current;
  while (ancestor && ancestors.length < 10) {
    ancestors.unshift(ancestor);
    ancestor = folders.find((f) => f.id === ancestor?.parentId);
  }
  const children = folders.filter((f) => f.parentId === folderId);
  async function run(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, ...body }),
      });
      const payload = await res.json();
      if (!res.ok)
        throw new Error(payload.error?.message ?? payload.error ?? 'Folder operation failed');
      if (payload.data.needsConfirmation) {
        setConfirmation({ ...payload.data, body });
        return;
      }
      setConfirmation(null);
      setName('');
      if (body.action === 'delete') router.push(canSeeRoot ? `/projects/${projectId}` : '/shared');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Folder operation failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mb-6 space-y-4" aria-label="Project folders">
      <nav className="flex flex-wrap gap-3 text-sm" aria-label="Folder breadcrumb">
        <Link href="/shared">Shared with me</Link>
        {canSeeRoot && <Link href={`/projects/${projectId}`}>Project root</Link>}
        {ancestors.map((a) => (
          <Link key={a.id} href={`/projects/${projectId}?folderId=${a.id}`}>
            {a.name}
          </Link>
        ))}
        <Link href={`/projects/${projectId}?view=all${folderId ? `&folderId=${folderId}` : ''}`}>
          All accessible videos
        </Link>
        {all && <span>(all folders)</span>}
      </nav>
      <div className="grid gap-3 sm:grid-cols-3">
        {children.map((f) => (
          <Link
            className="flex items-center gap-3 rounded-lg border p-4 hover:bg-muted"
            key={f.id}
            href={`/projects/${projectId}?folderId=${f.id}`}
          >
            <Folder className="h-5 w-5" />
            <span>{f.name}</span>
            {f.accessMode === 'RESTRICTED' && <Lock className="h-4 w-4" aria-label="Restricted" />}
          </Link>
        ))}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-xs"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Folder name"
            placeholder="Folder name"
            maxLength={100}
          />
          <Button
            disabled={busy || !name.trim()}
            onClick={() => void run({ action: 'create', name })}
          >
            New folder
          </Button>
          {current && (
            <>
              <Button
                variant="outline"
                disabled={busy || !name.trim()}
                onClick={() => void run({ action: 'rename', name })}
              >
                Rename current folder
              </Button>
              <ContentAccessControls projectId={projectId} folderId={folderId} />
              <select
                className="rounded border bg-background p-2"
                aria-label="Move folder destination"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                {canSeeRoot && <option value="">Project root</option>}
                {folders
                  .filter((f) => f.canEdit && f.id !== folderId)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ action: 'move', parentId: destination || null })}
              >
                Move folder
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ action: 'delete' })}
              >
                Delete empty folder
              </Button>
            </>
          )}
        </div>
      )}
      {confirmation && (
        <div className="rounded border p-4 space-y-2">
          <p>{confirmation.message}</p>
          <Button
            disabled={busy}
            onClick={() =>
              void run({ ...confirmation.body, confirmationToken: confirmation.confirmationToken })
            }
          >
            Confirm move
          </Button>
          <Button variant="ghost" onClick={() => setConfirmation(null)}>
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}
