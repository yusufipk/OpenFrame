'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, Copy, Download, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type EditorPlugin = 'premiere' | 'resolve';

// The panel and the script need exactly these two permissions and nothing more.
const PLUGIN_TOKEN_SCOPES = ['read', 'comments:read'];

const COPY: Record<
  EditorPlugin,
  {
    app: string;
    plugin: string;
    downloadHref: string;
    tokenName: string;
    open: string;
    guide: string;
  }
> = {
  premiere: {
    app: 'Premiere Pro',
    plugin: 'panel',
    downloadHref: '/api/integrations/premiere-panel',
    tokenName: 'Premiere panel',
    open: 'Window → UXP Plugins → OpenFrame Comments',
    guide: '/guides/editor-markers#premiere',
  },
  resolve: {
    app: 'DaVinci Resolve',
    plugin: 'script',
    downloadHref: '/api/integrations/resolve-script',
    tokenName: 'Resolve script',
    open: 'Workspace → Scripts → OpenFrame Comments',
    guide: '/guides/editor-markers#resolve',
  },
};

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium leading-6">{title}</p>
        {children}
      </div>
    </li>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} className="h-8 font-mono text-xs" aria-label={label} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

export function EditorSyncDialog({
  editor,
  projectId,
  videoId,
  onClose,
}: {
  editor: EditorPlugin | null;
  projectId: string;
  videoId: string;
  onClose: () => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const copy = editor ? COPY[editor] : null;
  const videoLink =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(videoId)}`;

  const createToken = async () => {
    if (!copy) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/settings/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: copy.tokenName, scopes: PLUGIN_TOKEN_SCOPES }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'Could not create a token');
      setToken(payload.data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a token');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open) {
          // A token is shown once; closing the dialog drops it from the page.
          setToken(null);
          setError('');
          onClose();
        }
      }}
    >
      {copy && (
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add comments to {copy.app}</DialogTitle>
            <DialogDescription>
              They appear as colored markers on the timeline you are editing.
            </DialogDescription>
          </DialogHeader>

          <ol className="space-y-5">
            <Step number={1} title={`Install the ${copy.plugin} (first time only)`}>
              <Button asChild variant="outline" size="sm">
                <a href={copy.downloadHref} download>
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </a>
              </Button>
            </Step>

            <Step number={2} title="Copy this video's link">
              <CopyField value={videoLink} label="Video link" />
            </Step>

            <Step number={3} title="Get a token (first time only)">
              {token ? (
                <>
                  <CopyField value={token} label="Token" />
                  <p className="text-xs text-muted-foreground">Copy it now, it is shown once.</p>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={creating}
                  onClick={createToken}
                >
                  {creating ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4 mr-2" />
                  )}
                  Create token
                </Button>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </Step>

            <Step number={4} title={`Paste both in ${copy.app}`}>
              <p className="text-xs text-muted-foreground">{copy.open}</p>
            </Step>
          </ol>

          <Link
            href={copy.guide}
            target="_blank"
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            Setup guide with screenshots
          </Link>
        </DialogContent>
      )}
    </Dialog>
  );
}
