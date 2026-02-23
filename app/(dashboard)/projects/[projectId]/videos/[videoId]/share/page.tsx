'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Copy, Link2, Loader2, RefreshCcw, ShieldOff, Lock, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type RouteParams = Promise<{ projectId: string; videoId: string }>;

interface VideoSharePageProps {
  params: RouteParams;
}

interface ShareLinkData {
  id: string;
  token: string;
  allowGuests: boolean;
  hasPassword: boolean;
}

interface ShareResponse {
  data: {
    link: ShareLinkData | null;
    shareUrl: string | null;
  };
  error?: string;
}

export default function VideoSharePage({ params }: VideoSharePageProps) {
  const [projectId, setProjectId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    params.then(({ projectId: nextProjectId, videoId: nextVideoId }) => {
      setProjectId(nextProjectId);
      setVideoId(nextVideoId);
    });
  }, [params]);

  useEffect(() => {
    if (!projectId || !videoId) return;

    async function loadShareLink() {
      setLoading(true);
      setError('');

      try {
        const response = await fetch(`/api/projects/${projectId}/videos/${videoId}/share`, { cache: 'no-store' });
        const payload = (await response.json()) as ShareResponse;

        if (!response.ok || payload.error) {
          setError(payload.error || 'Failed to load share link');
          setShareUrl(null);
          return;
        }

        setShareUrl(payload.data.shareUrl);
        setHasPassword(!!payload.data.link?.hasPassword);
      } catch {
        setError('Failed to load share link');
        setShareUrl(null);
        setHasPassword(false);
      } finally {
        setLoading(false);
      }
    }

    loadShareLink();
  }, [projectId, videoId]);

  const copyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const createShareLink = async () => {
    if (!projectId || !videoId) return;

    setSubmitting(true);
    setError('');

    try {
      const response = await fetch(`/api/projects/${projectId}/videos/${videoId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowGuests: true }),
      });

      const payload = (await response.json()) as ShareResponse;
      if (!response.ok || payload.error) {
        setError(payload.error || 'Failed to create share link');
        return;
      }

      setShareUrl(payload.data.shareUrl);
      setHasPassword(!!payload.data.link?.hasPassword);
      setPassword('');
    } catch {
      setError('Failed to create share link');
    } finally {
      setSubmitting(false);
    }
  };

  const revokeShareLink = async () => {
    if (!projectId || !videoId) return;

    setSubmitting(true);
    setError('');

    try {
      const response = await fetch(`/api/projects/${projectId}/videos/${videoId}/share`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error || 'Failed to revoke share link');
        return;
      }

      setShareUrl(null);
      setHasPassword(false);
      setPassword('');
    } catch {
      setError('Failed to revoke share link');
    } finally {
      setSubmitting(false);
    }
  };

  const updateSecuritySettings = async (clearPassword = false) => {
    if (!projectId || !videoId || !shareUrl) return;

    setSubmitting(true);
    setError('');

    try {
      const response = await fetch(`/api/projects/${projectId}/videos/${videoId}/share`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(clearPassword ? { clearPassword: true } : {}),
          ...(!clearPassword ? { password } : {}),
        }),
      });

      const payload = (await response.json().catch(() => null)) as ShareResponse | { error?: string } | null;
      if (!response.ok || ('error' in (payload || {}) && payload?.error)) {
        setError((payload as { error?: string } | null)?.error || 'Failed to update link security');
        return;
      }

      const data = (payload as ShareResponse).data;
      setShareUrl(data.shareUrl);
      setHasPassword(!!data.link?.hasPassword);
      setPassword('');
    } catch {
      setError('Failed to update link security');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-start justify-center py-12 px-4">
      <div className="w-full max-w-xl space-y-6">
        <Link
          href={`/projects/${projectId}/videos/${videoId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Video
        </Link>

        <Card className="border-border/50 shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl">Share Video For Review</CardTitle>
            <CardDescription>
              Create a private link so reviewers can watch and comment on this single video.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <div className="flex items-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading link settings...
              </div>
            ) : shareUrl ? (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Input value={shareUrl} readOnly className="font-mono text-sm h-11 bg-muted/50" />
                  <Button
                    variant={copied ? 'default' : 'outline'}
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={copyLink}
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button onClick={createShareLink} disabled={submitting} variant="outline">
                    {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCcw className="h-4 w-4 mr-2" />}
                    Regenerate Link
                  </Button>
                  <Button onClick={revokeShareLink} disabled={submitting} variant="destructive">
                    {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ShieldOff className="h-4 w-4 mr-2" />}
                    Revoke Link
                  </Button>
                </div>
                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {hasPassword ? <ShieldCheck className="h-4 w-4 text-green-600" /> : <Lock className="h-4 w-4" />}
                    Link password
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder={hasPassword ? 'Enter new password to replace current one' : 'Set a password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={submitting}
                    />
                    <Button
                      onClick={() => updateSecuritySettings(false)}
                      disabled={submitting || !password.trim()}
                      variant="outline"
                    >
                      Save
                    </Button>
                    {hasPassword && (
                      <Button
                        onClick={() => updateSecuritySettings(true)}
                        disabled={submitting}
                        variant="outline"
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <Button onClick={createShareLink} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />}
                Create Review Link
              </Button>
            )}

            <p className="text-xs text-muted-foreground">
              This link allows guests to leave comments without an account. You can optionally protect it with a password.
            </p>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
