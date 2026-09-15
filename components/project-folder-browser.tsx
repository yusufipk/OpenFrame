'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ChevronRight, Folder, FolderPlus, Lock, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ContentAccessControls } from '@/components/content-access-controls';

export type FolderEntry = {
  id: string;
  name: string;
  parentId: string | null;
  accessMode: string;
  canEdit: boolean;
};

export function ProjectFolderCard({
  projectId,
  folder,
}: {
  projectId: string;
  folder: FolderEntry;
}) {
  return (
    <Card className="min-w-0 gap-0 py-0 transition-colors hover:bg-accent/10">
      <CardContent className="flex items-center gap-3 p-4">
        <Link
          href={`/projects/${projectId}?folderId=${folder.id}`}
          aria-label={folder.name}
          className="flex min-w-0 flex-1 items-center gap-3 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Folder className="h-8 w-8 shrink-0 text-primary" strokeWidth={1.5} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="font-medium truncate">{folder.name}</h3>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>Folder</span>
              {folder.accessMode === 'RESTRICTED' && (
                <span className="inline-flex items-center gap-1">
                  <Lock className="h-3 w-3" /> Restricted
                </span>
              )}
            </div>
          </div>
        </Link>
        {folder.canEdit && (
          <ContentAccessControls
            projectId={projectId}
            folderId={folder.id}
            contentName={folder.name}
            share
          />
        )}
      </CardContent>
    </Card>
  );
}

export function AddFolderButton({
  projectId,
  folderId,
}: {
  projectId: string;
  folderId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          setName('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FolderPlus className="h-4 w-4 mr-2" />
          Add Folder
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add folder</DialogTitle>
          <DialogDescription>
            Create a folder in the current location. It inherits access from its parent.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !name.trim()) return;
            setBusy(true);
            try {
              const response = await fetch(`/api/projects/${projectId}/folders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create', folderId, name: name.trim() }),
              });
              const payload = await response.json();
              if (!response.ok)
                throw new Error(
                  payload.error?.message ?? payload.error ?? 'Could not create folder'
                );
              setOpen(false);
              setName('');
              router.refresh();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Could not create folder');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-folder-name">Folder name</Label>
            <Input
              id="new-folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating...' : 'Create folder'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  const searchParams = useSearchParams();
  const viewParams = new URLSearchParams(searchParams.toString());
  viewParams.delete('page');
  viewParams.delete('view');
  const folderViewUrl = `/projects/${projectId}${viewParams.size ? `?${viewParams}` : ''}`;
  viewParams.set('view', 'all');
  const allVideosUrl = `/projects/${projectId}?${viewParams}`;
  const current = folders.find((f) => f.id === folderId);
  const [name, setName] = useState(current?.name ?? '');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    confirmationToken: string;
    body: Record<string, unknown>;
  } | null>(null);
  const ancestors: FolderEntry[] = [];
  let ancestor = current;
  while (ancestor && ancestors.length < 10) {
    ancestors.unshift(ancestor);
    ancestor = folders.find((f) => f.id === ancestor?.parentId);
  }
  const destinations = folders.filter((f) => f.canEdit && f.id !== folderId);
  const destinationId = destination || (canSeeRoot ? null : destinations[0]?.id);
  async function run(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, ...body }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error?.message ?? payload.error ?? 'Folder operation failed');
      if (payload.data.needsConfirmation) {
        setConfirmation({ ...payload.data, body });
        return;
      }
      setConfirmation(null);
      setOptionsOpen(false);
      if (body.action === 'delete') router.push(canSeeRoot ? `/projects/${projectId}` : '/shared');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Folder operation failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <nav
        className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground"
        aria-label="Folder breadcrumb"
      >
        {canSeeRoot && (
          <Link className="hover:text-foreground" href={`/projects/${projectId}`}>
            Project root
          </Link>
        )}
        {all && (
          <span className="inline-flex items-center gap-2" aria-current="page">
            {canSeeRoot && <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
            All project videos
          </span>
        )}
        {!all &&
          ancestors.map((a, index) => (
            <span className="inline-flex items-center gap-2" key={a.id}>
              {(canSeeRoot || index > 0) && (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <Link
                className="hover:text-foreground"
                href={`/projects/${projectId}?folderId=${a.id}`}
              >
                {a.name}
              </Link>
            </span>
          ))}
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex items-center border p-0.5"
          role="group"
          aria-label="Content view"
        >
          <Button asChild variant={!all ? 'secondary' : 'ghost'} size="sm">
            <Link href={folderViewUrl} aria-current={!all ? 'page' : undefined}>
              Folder view
            </Link>
          </Button>
          <Button asChild variant={all ? 'secondary' : 'ghost'} size="sm">
            <Link href={all ? folderViewUrl : allVideosUrl} aria-current={all ? 'page' : undefined}>
              All project videos
            </Link>
          </Button>
        </div>
        {current && canEdit && !all && (
          <>
            <Dialog
              open={optionsOpen}
              onOpenChange={(open) => {
                if (!busy) {
                  setOptionsOpen(open);
                  setConfirmation(null);
                  setName(current.name);
                }
              }}
            >
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Folder options">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Folder options</DialogTitle>
                  <DialogDescription>
                    Manage {current.name}. Only empty folders can be deleted.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="rename-folder">Folder name</Label>
                  <div className="flex gap-2">
                    <Input
                      id="rename-folder"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={100}
                      disabled={busy}
                    />
                    <Button
                      variant="outline"
                      disabled={busy || !name.trim()}
                      onClick={() => void run({ action: 'rename', name })}
                    >
                      Rename
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="folder-destination">Move folder destination</Label>
                  <div className="flex gap-2">
                    <Select
                      value={destinationId === null ? '__project_root__' : (destinationId ?? '')}
                      onValueChange={(value) =>
                        setDestination(value === '__project_root__' ? '' : value)
                      }
                      disabled={busy || destinationId === undefined}
                    >
                      <SelectTrigger id="folder-destination" className="min-w-0 flex-1">
                        <SelectValue placeholder="Select a destination" />
                      </SelectTrigger>
                      <SelectContent>
                        {canSeeRoot && (
                          <SelectItem value="__project_root__">Project root</SelectItem>
                        )}
                        {destinations.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      disabled={busy || destinationId === undefined}
                      onClick={() => void run({ action: 'move', parentId: destinationId })}
                    >
                      Move folder
                    </Button>
                  </div>
                </div>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void run({ action: 'delete' })}
                >
                  Delete empty folder
                </Button>
                {confirmation && (
                  <div className="border p-3 space-y-3">
                    <p className="text-sm">{confirmation.message}</p>
                    <div className="flex gap-2">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run({
                            ...confirmation.body,
                            confirmationToken: confirmation.confirmationToken,
                          })
                        }
                      >
                        Confirm move
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmation(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
    </div>
  );
}
