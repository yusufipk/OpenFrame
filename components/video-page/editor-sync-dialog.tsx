'use client';

import { useState } from 'react';
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
    title: string;
    download: string;
    downloadHref: string;
    tokenName: string;
    install: string;
    run: string;
    guide: string;
  }
> = {
  premiere: {
    title: 'Send comments to Premiere Pro',
    download: 'Download the panel',
    downloadHref: '/api/integrations/premiere-panel',
    tokenName: 'Premiere panel',
    install:
      'Double-click the downloaded file; Creative Cloud installs it. Then open Window → UXP Plugins → OpenFrame Comments. Needs Premiere 25.6 or later.',
    run: 'Open your sequence, paste the link and the token into the panel, load the versions, pick one and add the comments.',
    guide: '/guides/editor-markers#premiere',
  },
  resolve: {
    title: 'Send comments to DaVinci Resolve',
    download: 'Download the script',
    downloadHref: '/api/integrations/resolve-script',
    tokenName: 'Resolve script',
    install:
      "Put the file in Resolve's Fusion/Scripts/Utility folder (the guide lists it for Windows, macOS and Linux) and restart Resolve. It then sits under Workspace → Scripts.",
    run: 'Open your timeline, run Workspace → Scripts → OpenFrame Comments, paste the link and the token, load the versions, pick one and add the comments.',
    guide: '/guides/editor-markers#resolve',
  },
};

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} className="font-mono text-xs" aria-label={label} />
      <Button
        type="button"
        variant="outline"
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>
              Adds this video&apos;s comments as colored markers on the timeline you have open, at
              its own frame rate. Run it again after new feedback: it replaces its own markers and
              leaves yours alone.
            </DialogDescription>
          </DialogHeader>

          <ol className="space-y-5 text-sm">
            <li className="space-y-2">
              <p className="font-medium">1. Install it once</p>
              <p className="text-muted-foreground">{copy.install}</p>
              <Button asChild variant="outline" size="sm">
                <a href={copy.downloadHref} download>
                  <Download className="h-4 w-4 mr-2" />
                  {copy.download}
                </a>
              </Button>
            </li>

            <li className="space-y-2">
              <p className="font-medium">2. Connect it to this video</p>
              <CopyField value={videoLink} label="Video link" />
              {token ? (
                <div className="space-y-1">
                  <CopyField value={token} label="API token" />
                  <p className="text-xs text-muted-foreground">
                    Shown only now. It can read projects and comments and nothing else; revoke it
                    any time in Settings → API Tokens.
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
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
                    Create a read-only token
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Already pasted one into {editor === 'premiere' ? 'the panel' : 'the script'}? It
                    remembers it; you only need the link.
                  </p>
                </div>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </li>

            <li className="space-y-2">
              <p className="font-medium">3. Add the markers</p>
              <p className="text-muted-foreground">{copy.run}</p>
            </li>
          </ol>

          <p className="text-xs text-muted-foreground">
            <Link href={copy.guide} target="_blank" className="underline underline-offset-4">
              Step-by-step guide with screenshots
            </Link>
          </p>
        </DialogContent>
      )}
    </Dialog>
  );
}
