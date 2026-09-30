'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  API_TOKEN_SCOPE_DETAILS,
  API_TOKEN_SCOPES,
  DEFAULT_API_TOKEN_SCOPES,
  MAX_API_TOKEN_NAME_LENGTH,
  type ApiTokenScope,
} from '@/lib/api-token-scopes';

interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

const API_DOCS_URL = 'https://github.com/yusufipk/OpenFrame/blob/master/docs/api.md';

function formatDate(value: string | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ApiTokensCard() {
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiTokenScope[]>([...DEFAULT_API_TOKEN_SCOPES]);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ id: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/api-tokens');
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'Failed to load API tokens');
      setTokens(payload.data.tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API tokens');
      setLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || scopes.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, scopes }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || 'Failed to create API token');
      const { token, ...row } = payload.data as ApiTokenRow & { token: string };
      setTokens((current) => [row, ...current]);
      setNewToken({ id: row.id, token });
      // A create that works means the list can be loaded too; try again rather
      // than leave the tokens hidden behind the earlier failure.
      if (loadFailed) {
        setLoadFailed(false);
        void load();
      }
      setCopied(false);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API token');
    } finally {
      setCreating(false);
    }
  };

  const toggleScope = (scope: ApiTokenScope) => {
    setScopes((current) =>
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope]
    );
  };

  const handleRevoke = async (token: ApiTokenRow) => {
    if (!window.confirm(`Revoke "${token.name}"? Scripts using it will stop working.`)) return;
    const { id } = token;
    setRevokingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/settings/api-tokens/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || 'Failed to revoke API token');
      }
      setTokens((current) => current.filter((token) => token.id !== id));
      // A revoked secret must not stay on screen to be copied.
      setNewToken((current) => (current?.id === id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke API token');
    } finally {
      setRevokingId(null);
    }
  };

  const handleCopy = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken.token);
      setCopied(true);
    } catch {
      setError('Could not copy. Select the token and copy it by hand.');
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          API Tokens
        </CardTitle>
        <CardDescription>
          Let a script or an AI agent work in OpenFrame for you, with only the permissions you
          choose.{' '}
          <a
            href={API_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            How to use them
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Token name, e.g. Render machine"
              maxLength={MAX_API_TOKEN_NAME_LENGTH}
              aria-label="Token name"
            />
            <Button type="submit" disabled={creating || !name.trim() || scopes.length === 0}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
            </Button>
          </div>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">Permissions</legend>
            {API_TOKEN_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span>
                  <span className="font-medium">{API_TOKEN_SCOPE_DETAILS[scope].label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {API_TOKEN_SCOPE_DETAILS[scope].description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            A token never goes beyond what you can do yourself, and it never reaches billing,
            settings or other tokens.
          </p>
        </form>

        {newToken && (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-2">
            <p className="text-sm font-medium">Copy this token now. It will not be shown again.</p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={newToken.token}
                className="font-mono text-xs"
                aria-label="New token"
              />
              <Button type="button" variant="outline" onClick={handleCopy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              It acts as you with the permissions you chose. Keep it out of shared files and
              repositories, and revoke it here if it leaks.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {loadFailed ? null : !loaded ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tokens yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {tokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{token.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">{token.prefix}…</span> · Last used{' '}
                    {formatDate(token.lastUsedAt)}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(token.scopes ?? []).map((scope) => (
                      <Badge key={scope} variant="secondary" className="text-[10px]">
                        {API_TOKEN_SCOPE_DETAILS[scope as ApiTokenScope]?.label ?? scope}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRevoke(token)}
                  disabled={revokingId === token.id}
                  aria-label={`Revoke ${token.name}`}
                >
                  {revokingId === token.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
