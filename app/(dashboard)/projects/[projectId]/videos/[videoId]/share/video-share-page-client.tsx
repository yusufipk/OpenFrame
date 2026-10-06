'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  Copy,
  Link2,
  Loader2,
  RefreshCcw,
  ShieldOff,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ContentAccessControls } from '@/components/content-access-controls';

interface VideoSharePageProps {
  projectId: string;
  videoId: string;
}

interface ShareLinkData {
  id: string;
  token: string;
  allowGuests: boolean;
  allowDownloads: boolean;
  hasPassword: boolean;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
}

interface ShareResponse {
  data: {
    link: ShareLinkData | null;
    shareUrl: string | null;
  };
  error?: string;
}

export default function VideoSharePageClient({ projectId, videoId }: VideoSharePageProps) {
  const [accessRevision, setAccessRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [allowDownloads, setAllowDownloads] = useState(false);
  const [linkActivity, setLinkActivity] = useState<ShareLinkData | null>(null);

  const linkMutationRevisionRef = useRef(0);

  const invalidateLinkLoads = () => {
    linkMutationRevisionRef.current += 1;
    setLoading(false);
  };

  useEffect(() => {
    if (!projectId || !videoId) return;
    let cancelled = false;
    const revision = linkMutationRevisionRef.current;
    const isCurrent = () => !cancelled && revision === linkMutationRevisionRef.current;

    async function loadShareLink() {
      setLoading(true);
      setError('');

      try {
        const response = await fetch(`/api/projects/${projectId}/videos/${videoId}/share`, {
          cache: 'no-store',
        });
        const payload = (await response.json()) as ShareResponse;
        if (!isCurrent()) return;

        if (!response.ok || payload.error) {
          setError(payload.error || 'Failed to load share link');
          setShareUrl(null);
          setLinkActivity(null);
          return;
        }

        setShareUrl(payload.data.shareUrl);
        setLinkActivity(payload.data.link);
        setHasPassword(!!payload.data.link?.hasPassword);
        setAllowDownloads(!!payload.data.link?.allowDownloads);
      } catch {
        if (!isCurrent()) return;
        setError('Failed to load share link');
        setShareUrl(null);
        setLinkActivity(null);
        setHasPassword(false);
        setAllowDownloads(false);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }

    void loadShareLink();
    return () => {
      cancelled = true;
    };
  }, [projectId, videoId, accessRevision]);

  const copyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const createShareLink = async () => {
    if (!projectId || !videoId) return;

    invalidateLinkLoads();
    setSubmitting(true);
    setError('');

    try {
      const response = await fetch(`/api/projects/${projectId}/videos/${videoId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowGuests: true, allowDownloads }),
      });

      const payload = (await response.json()) as ShareResponse;
      if (!response.ok || payload.error) {
        setError(payload.error || 'Failed to create share link');
        return;
      }

      setShareUrl(payload.data.shareUrl);
      setLinkActivity(payload.data.link);
      setHasPassword(!!payload.data.link?.hasPassword);
      setAllowDownloads(!!payload.data.link?.allowDownloads);
      setPassword('');
    } catch {
      setError('Failed to create share link');
    } finally {
      invalidateLinkLoads();
      setSubmitting(false);
    }
  };

  const revokeShareLink = async () => {
    if (!projectId || !videoId) return;

    invalidateLinkLoads();
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
      setLinkActivity(null);
      setHasPassword(false);
      setAllowDownloads(false);
      setPassword('');
    } catch {
      setError('Failed to revoke share link');
    } finally {
      invalidateLinkLoads();
      setSubmitting(false);
    }
  };

  const updateSecuritySettings = async (clearPassword = false) => {
    if (!projectId || !videoId || !shareUrl) return;

    invalidateLinkLoads();
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

      const payload = (await response.json().catch(() => null)) as
        | ShareResponse
        | { error?: string }
        | null;
      if (!response.ok || ('error' in (payload || {}) && payload?.error)) {
        setError((payload as { error?: string } | null)?.error || 'Failed to update link security');
        return;
      }

      const data = (payload as ShareResponse).data;
      setShareUrl(data.shareUrl);
      setLinkActivity(data.link);
      setHasPassword(!!data.link?.hasPassword);
      setAllowDownloads(!!data.link?.allowDownloads);
      setPassword('');
    } catch {
      setError('Failed to update link security');
    } finally {
      invalidateLinkLoads();
      setSubmitting(false);
    }
  };

  const updateDownloadSetting = async (nextAllowDownloads: boolean) => {
    if (!projectId || !videoId || !shareUrl) return;

    invalidateLinkLoads();
    setSubmitting(true);
    setError('');

    try {
      const response = await fetch(`/api/projects/${projectId}/videos/${videoId}/share`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowDownloads: nextAllowDownloads }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ShareResponse
        | { error?: string }
        | null;
      if (!response.ok || ('error' in (payload || {}) && payload?.error)) {
        setError(
          (payload as { error?: string } | null)?.error || 'Failed to update download setting'
        );
        return;
      }
      const data = (payload as ShareResponse).data;
      setShareUrl(data.shareUrl);
      setLinkActivity(data.link);
      setAllowDownloads(!!data.link?.allowDownloads);
      setHasPassword(!!data.link?.hasPassword);
    } catch {
      setError('Failed to update download setting');
    } finally {
      invalidateLinkLoads();
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100dvh-4rem)] flex items-start justify-center py-12 px-4">
      <div className="w-full max-w-xl space-y-6">
        <Link
          href={`/projects/${projectId}/videos/${videoId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Review
        </Link>

        <Card className="border-border/50 shadow-lg">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-2xl">Share for Review</CardTitle>
              <ContentAccessControls
                projectId={projectId}
                videoId={videoId}
                showMembers
                onAccessChanged={() => setAccessRevision((revision) => revision + 1)}
              />
            </div>
            <CardDescription>
              Create a private link so reviewers can view and comment on this file.
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
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={shareUrl}
                    readOnly
                    className="min-w-0 flex-1 font-mono text-sm h-11 bg-muted/50"
                  />
                  <Button
                    variant={copied ? 'default' : 'outline'}
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={copyLink}
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">Link activity</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={submitting}
                      onClick={() => setAccessRevision((revision) => revision + 1)}
                    >
                      Refresh activity
                    </Button>
                  </div>
                  {linkActivity?.firstOpenedAt ? (
                    <dl className="text-sm space-y-1">
                      <div className="flex flex-wrap justify-between gap-x-3">
                        <dt className="text-muted-foreground">First recorded open</dt>
                        <dd>
                          <time dateTime={linkActivity.firstOpenedAt}>
                            {new Date(linkActivity.firstOpenedAt).toLocaleString()}
                          </time>
                        </dd>
                      </div>
                      {linkActivity.lastOpenedAt && (
                        <div className="flex flex-wrap justify-between gap-x-3">
                          <dt className="text-muted-foreground">Last recorded open</dt>
                          <dd>
                            <time dateTime={linkActivity.lastOpenedAt}>
                              {new Date(linkActivity.lastOpenedAt).toLocaleString()}
                            </time>
                          </dd>
                        </div>
                      )}
                    </dl>
                  ) : (
                    <p className="text-sm text-muted-foreground">No opens recorded yet</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Shows recorded page opens, not who opened the link or whether they watched.
                    Earlier opens are not included. Editor previews are excluded.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={createShareLink} disabled={submitting} variant="outline">
                    {submitting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCcw className="h-4 w-4 mr-2" />
                    )}
                    Regenerate Link
                  </Button>
                  <Button onClick={revokeShareLink} disabled={submitting} variant="destructive">
                    {submitting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <ShieldOff className="h-4 w-4 mr-2" />
                    )}
                    Revoke Link
                  </Button>
                </div>
                <div className="rounded-lg border p-3 space-y-2">
                  <div>
                    <p className="text-sm font-medium">Video download</p>
                    <p className="text-xs text-muted-foreground">
                      Allow viewers with this link to download
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={allowDownloads ? 'default' : 'outline'}
                      disabled={submitting || allowDownloads}
                      onClick={() => updateDownloadSetting(true)}
                    >
                      Allow Download
                    </Button>
                    <Button
                      variant={!allowDownloads ? 'default' : 'outline'}
                      disabled={submitting || !allowDownloads}
                      onClick={() => updateDownloadSetting(false)}
                    >
                      Block Download
                    </Button>
                  </div>
                </div>

                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {hasPassword ? (
                      <ShieldCheck className="h-4 w-4 text-green-600" />
                    ) : (
                      <Lock className="h-4 w-4" />
                    )}
                    Link password
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      className="min-w-0 flex-1"
                      type="password"
                      placeholder={
                        hasPassword ? 'Enter new password to replace current one' : 'Set a password'
                      }
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
                {submitting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4 mr-2" />
                )}
                Create Review Link
              </Button>
            )}

            <p className="text-xs text-muted-foreground">
              Anyone with this link can watch this video and its versions and comment without an
              account, even when member access is restricted. Other videos and folders stay private.
              You can add a password above. Restricting access or moving the video revokes its
              existing link after confirmation.
            </p>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
