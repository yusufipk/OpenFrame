'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bell, Send, Mail, CheckCircle2, AlertCircle, Loader2, Globe, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface NotificationSettings {
  telegramChatId: string | null;
  telegramEnabled: boolean;
  emailEnabled: boolean;
  onNewVideo: boolean;
  onNewVersion: boolean;
  onNewComment: boolean;
  onNewReply: boolean;
  onApprovalEvents: boolean;
  timezone: string;
}

interface BillingOverview {
  isEnabled: boolean;
  isConfigured: boolean;
  status: 'disabled' | 'ready' | 'misconfigured';
  checkoutAvailable: boolean;
  portalAvailable: boolean;
  subscription: {
    status: string;
    label: string;
    hasActiveSubscription: boolean;
    hasActiveTrial: boolean;
    hasBillingAccess: boolean;
    priceId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    cancelAt: string | null;
    trialEndsAt: string | null;
    billingAccessEndedAt: string | null;
    storageCleanupEligibleAt: string | null;
  };
  workspaceCreation: {
    canCreateWorkspace: boolean;
    reason: string | null;
    ownedWorkspaceCount: number;
    invitedWorkspaceCount: number;
  };
}

function ToggleButton({
  enabled,
  onToggle,
  label,
  description,
}: {
  enabled: boolean;
  onToggle: () => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center justify-between w-full p-3 rounded-lg border transition-colors text-left',
        enabled
          ? 'border-primary/50 bg-primary/5'
          : 'border-border hover:bg-accent/50'
      )}
    >
      <div className="flex-1 min-w-0 pr-4">
        <span className="text-sm font-medium">{label}</span>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div
        className={cn(
          'w-10 h-6 shrink-0 rounded-full relative transition-colors',
          enabled ? 'bg-primary' : 'bg-muted'
        )}
      >
        <div
          className={cn(
            'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
            enabled ? 'translate-x-5' : 'translate-x-1'
          )}
        />
      </div>
    </button>
  );
}

export default function SettingsPage({ billingOnly = false }: { billingOnly?: boolean }) {
  const [settings, setSettings] = useState<NotificationSettings>({
    telegramChatId: null,
    telegramEnabled: false,
    emailEnabled: false,
    onNewVideo: true,
    onNewVersion: true,
    onNewComment: true,
    onNewReply: true,
    onApprovalEvents: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [billingAction, setBillingAction] = useState<'checkout' | 'portal' | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form state for Telegram chat ID (separate from saved settings for editing)
  const [telegramChatId, setTelegramChatId] = useState('');

  const hasScheduledCancellation = Boolean(
    billing?.subscription.cancelAtPeriodEnd || billing?.subscription.cancelAt
  );

  useEffect(() => {
    async function fetchSettings() {
      try {
        const [settingsRes, billingRes] = await Promise.all([
          fetch('/api/settings/notifications'),
          fetch('/api/billing'),
        ]);

        if (settingsRes.ok) {
          const data = await settingsRes.json();
          setSettings(data.data);
          setTelegramChatId(data.data.telegramChatId || '');
        }

        if (billingRes.ok) {
          const data = await billingRes.json();
          setBilling(data.data);
        }
      } catch {
        console.error('Failed to fetch settings');
      } finally {
        setLoading(false);
        setBillingLoading(false);
      }
    }
    fetchSettings();
  }, []);

  const showMessage = useCallback((type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settings,
          telegramChatId: telegramChatId || null,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setSettings(data.data);
        showMessage('success', 'Settings saved');
      } else {
        const data = await res.json();
        showMessage('error', data.error || 'Failed to save');
      }
    } catch {
      showMessage('error', 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [settings, telegramChatId, showMessage]);

  const handleTest = useCallback(
    async (channel: 'telegram' | 'email') => {
      setTesting(channel);
      try {
        const res = await fetch('/api/settings/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            telegramChatId,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          showMessage('success', data.data.message);
        } else {
          showMessage('error', data.error || 'Test failed');
        }
      } catch {
        showMessage('error', 'Test failed');
      } finally {
        setTesting(null);
      }
    },
    [telegramChatId, showMessage]
  );

  const handleBillingRedirect = useCallback(
    async (endpoint: '/api/billing/checkout' | '/api/billing/portal') => {
      setBillingAction(endpoint.endsWith('checkout') ? 'checkout' : 'portal');
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();

        if (!res.ok) {
          showMessage('error', data.error || 'Failed to open billing flow');
          return;
        }

        window.location.href = data.data.url;
      } catch {
        showMessage('error', 'Failed to open billing flow');
      } finally {
        setBillingAction(null);
      }
    },
    [showMessage]
  );

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
        <div>
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-80 mt-2" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64 mt-1" />
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-5 w-10 rounded-full" />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
        <div className="flex justify-end">
          <Skeleton className="h-10 w-32 rounded-md" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">
          {billingOnly ? 'Manage your billing access' : 'Manage your notification preferences'}
        </p>
      </div>

      {/* Status message */}
      {message && (
        <div
          className={cn(
            'flex items-center gap-2 p-3 rounded-lg mb-6 text-sm',
            message.type === 'success'
              ? 'bg-green-500/10 text-green-700 dark:text-green-400'
              : 'bg-destructive/10 text-destructive'
          )}
        >
          {message.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          {message.text}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Billing
          </CardTitle>
          <CardDescription>
            Manage your paid plan and workspace creation access
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {billingLoading || !billing ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-10 w-44 rounded-md" />
            </div>
          ) : !billing.isEnabled ? (
            <div className="rounded-md border border-muted bg-muted/40 p-4 text-sm text-muted-foreground">
              Stripe billing is disabled by this host. Workspace creation is unrestricted in this environment.
            </div>
          ) : !billing.isConfigured ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
              Stripe is not configured yet. Add your Stripe environment variables before using billing.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <p className="text-sm font-medium">Current plan</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {billing.subscription.hasActiveSubscription
                      ? hasScheduledCancellation
                        ? billing.subscription.hasActiveTrial
                          ? 'Trial canceled. Access remains active until the trial ends.'
                          : 'Subscription canceled. Access remains active until the end of the current billing period.'
                        : 'Paid account with workspace creation unlocked.'
                      : billing.subscription.hasActiveTrial
                        ? 'Trial access is active.'
                        : 'Billing access has ended.'}
                  </p>
                </div>
                <Badge
                  variant={billing.subscription.hasActiveSubscription ? 'default' : 'secondary'}
                >
                  {billing.subscription.label}
                </Badge>
              </div>

              {billing.subscription.hasActiveTrial
              && billing.subscription.trialEndsAt
              && hasScheduledCancellation ? (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
                >
                  Access ends on {' '}
                  {new Date(billing.subscription.trialEndsAt).toLocaleDateString()}.
                </p>
              ) : null}

              {billing.subscription.currentPeriodEnd ? (
                <p className="text-sm text-muted-foreground">
                  {hasScheduledCancellation ? 'Your subscription ends on ' : 'Current billing period ends on '}
                  {new Date(billing.subscription.currentPeriodEnd).toLocaleDateString()}.
                </p>
              ) : null}

              {hasScheduledCancellation && billing.subscription.cancelAt ? (
                <p className="text-sm text-muted-foreground">
                  Cancellation was scheduled on {new Date(billing.subscription.cancelAt).toLocaleDateString()}.
                </p>
              ) : null}

              {!billing.subscription.hasBillingAccess
              && billing.subscription.billingAccessEndedAt
              && billing.subscription.storageCleanupEligibleAt ? (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Stored media cleanup is scheduled after {new Date(billing.subscription.storageCleanupEligibleAt).toLocaleDateString()} unless billing is restored first.
                </p>
              ) : null}

              <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                <p className="text-sm font-medium">Workspace creation</p>
                <p className="text-sm text-muted-foreground">
                  {billing.workspaceCreation.canCreateWorkspace
                    ? 'This account can create workspaces.'
                    : billing.workspaceCreation.reason || 'Upgrade to create another workspace.'}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                {billing.subscription.hasActiveSubscription && billing.portalAvailable ? (
                  <Button
                    onClick={() => handleBillingRedirect('/api/billing/portal')}
                    disabled={billingAction !== null}
                  >
                    {billingAction === 'portal' ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Opening Portal...
                      </>
                    ) : (
                      'Manage Subscription'
                    )}
                  </Button>
                ) : (
                  <Button
                    onClick={() => handleBillingRedirect('/api/billing/checkout')}
                    disabled={!billing.checkoutAvailable || billingAction !== null}
                  >
                    {billingAction === 'checkout' ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Redirecting...
                      </>
                    ) : (
                      'Upgrade with Stripe'
                    )}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {!billingOnly && (
        <>
      {/* Event Subscriptions */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Notification Events
          </CardTitle>
          <CardDescription>
            Choose which events trigger notifications
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleButton
            enabled={settings.onNewVideo}
            onToggle={() =>
              setSettings((s) => ({ ...s, onNewVideo: !s.onNewVideo }))
            }
            label="New Video Added"
            description="When a new video is added to one of your projects"
          />
          <ToggleButton
            enabled={settings.onNewVersion}
            onToggle={() =>
              setSettings((s) => ({ ...s, onNewVersion: !s.onNewVersion }))
            }
            label="New Version Added"
            description="When a new version is added to an existing video"
          />
          <ToggleButton
            enabled={settings.onNewComment}
            onToggle={() =>
              setSettings((s) => ({ ...s, onNewComment: !s.onNewComment }))
            }
            label="New Comment"
            description="When someone leaves a comment on your videos"
          />
          <ToggleButton
            enabled={settings.onNewReply}
            onToggle={() =>
              setSettings((s) => ({ ...s, onNewReply: !s.onNewReply }))
            }
            label="New Reply"
            description="When someone replies to a comment thread"
          />
          <ToggleButton
            enabled={settings.onApprovalEvents}
            onToggle={() =>
              setSettings((s) => ({ ...s, onApprovalEvents: !s.onApprovalEvents }))
            }
            label="Approval Workflow"
            description="When approval requests are created, responded to, or finalized"
          />
        </CardContent>
      </Card>

      {/* Telegram */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Telegram
            </CardTitle>
            <Badge variant={settings.telegramEnabled ? 'default' : 'secondary'}>
              {settings.telegramEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <CardDescription>
            Get instant notifications via Telegram
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-3 space-y-2 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Setup instructions</p>
            <ol className="space-y-1.5 list-decimal list-inside">
              <li>
                Message{' '}
                <a
                  href="https://t.me/UserInfeBot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  @UserInfeBot
                </a>
                {' '}on Telegram and send <code className="bg-muted px-1 rounded text-xs">/start</code> to get your Chat ID
              </li>
              <li>
                Start{' '}
                <a
                  href="https://t.me/openframe_bot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  @openframe_bot
                </a>
                {' '}and send <code className="bg-muted px-1 rounded text-xs">/start</code> so it can message you
              </li>
              <li>Paste your Chat ID below and enable notifications</li>
            </ol>
          </div>

          <div>
            <Label htmlFor="telegram-chat-id">Your Chat ID</Label>
            <Input
              id="telegram-chat-id"
              placeholder="123456789"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>

          <ToggleButton
            enabled={settings.telegramEnabled}
            onToggle={() =>
              setSettings((s) => ({ ...s, telegramEnabled: !s.telegramEnabled }))
            }
            label="Enable Telegram notifications"
          />

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTest('telegram')}
            disabled={!telegramChatId || testing === 'telegram'}
          >
            {testing === 'telegram' ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Send Test Message
          </Button>
        </CardContent>
      </Card>

      {/* Email */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Email
            </CardTitle>
            <Badge variant={settings.emailEnabled ? 'default' : 'secondary'}>
              {settings.emailEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <CardDescription>
            Receive notification emails to your account email address
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleButton
            enabled={settings.emailEnabled}
            onToggle={() =>
              setSettings((s) => ({ ...s, emailEnabled: !s.emailEnabled }))
            }
            label="Enable email notifications"
          />

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTest('email')}
            disabled={!settings.emailEnabled || testing === 'email'}
          >
            {testing === 'email' ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Mail className="h-4 w-4 mr-2" />
            )}
            Send Test Email
          </Button>
        </CardContent>
      </Card>

      {/* Timezone */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Timezone
          </CardTitle>
          <CardDescription>
            Timestamps in notifications will use this timezone
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={settings.timezone}
            onValueChange={(value) =>
              setSettings((s) => ({ ...s, timezone: value }))
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select timezone" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Americas</SelectLabel>
                <SelectItem value="America/New_York">Eastern Time (New York)</SelectItem>
                <SelectItem value="America/Chicago">Central Time (Chicago)</SelectItem>
                <SelectItem value="America/Denver">Mountain Time (Denver)</SelectItem>
                <SelectItem value="America/Los_Angeles">Pacific Time (Los Angeles)</SelectItem>
                <SelectItem value="America/Anchorage">Alaska (Anchorage)</SelectItem>
                <SelectItem value="Pacific/Honolulu">Hawaii (Honolulu)</SelectItem>
                <SelectItem value="America/Toronto">Toronto</SelectItem>
                <SelectItem value="America/Vancouver">Vancouver</SelectItem>
                <SelectItem value="America/Mexico_City">Mexico City</SelectItem>
                <SelectItem value="America/Sao_Paulo">São Paulo</SelectItem>
                <SelectItem value="America/Argentina/Buenos_Aires">Buenos Aires</SelectItem>
                <SelectItem value="America/Bogota">Bogotá</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Europe</SelectLabel>
                <SelectItem value="Europe/London">London (GMT/BST)</SelectItem>
                <SelectItem value="Europe/Paris">Paris (CET)</SelectItem>
                <SelectItem value="Europe/Berlin">Berlin (CET)</SelectItem>
                <SelectItem value="Europe/Amsterdam">Amsterdam (CET)</SelectItem>
                <SelectItem value="Europe/Madrid">Madrid (CET)</SelectItem>
                <SelectItem value="Europe/Rome">Rome (CET)</SelectItem>
                <SelectItem value="Europe/Zurich">Zurich (CET)</SelectItem>
                <SelectItem value="Europe/Stockholm">Stockholm (CET)</SelectItem>
                <SelectItem value="Europe/Helsinki">Helsinki (EET)</SelectItem>
                <SelectItem value="Europe/Athens">Athens (EET)</SelectItem>
                <SelectItem value="Europe/Istanbul">Istanbul (TRT)</SelectItem>
                <SelectItem value="Europe/Moscow">Moscow (MSK)</SelectItem>
                <SelectItem value="Europe/Kiev">Kyiv (EET)</SelectItem>
                <SelectItem value="Europe/Warsaw">Warsaw (CET)</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Asia & Pacific</SelectLabel>
                <SelectItem value="Asia/Dubai">Dubai (GST)</SelectItem>
                <SelectItem value="Asia/Kolkata">India (IST)</SelectItem>
                <SelectItem value="Asia/Bangkok">Bangkok (ICT)</SelectItem>
                <SelectItem value="Asia/Singapore">Singapore (SGT)</SelectItem>
                <SelectItem value="Asia/Hong_Kong">Hong Kong (HKT)</SelectItem>
                <SelectItem value="Asia/Shanghai">Shanghai (CST)</SelectItem>
                <SelectItem value="Asia/Tokyo">Tokyo (JST)</SelectItem>
                <SelectItem value="Asia/Seoul">Seoul (KST)</SelectItem>
                <SelectItem value="Asia/Taipei">Taipei (CST)</SelectItem>
                <SelectItem value="Asia/Jakarta">Jakarta (WIB)</SelectItem>
                <SelectItem value="Australia/Sydney">Sydney (AEST)</SelectItem>
                <SelectItem value="Australia/Melbourne">Melbourne (AEST)</SelectItem>
                <SelectItem value="Australia/Perth">Perth (AWST)</SelectItem>
                <SelectItem value="Pacific/Auckland">Auckland (NZST)</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Africa & Middle East</SelectLabel>
                <SelectItem value="Africa/Cairo">Cairo (EET)</SelectItem>
                <SelectItem value="Africa/Lagos">Lagos (WAT)</SelectItem>
                <SelectItem value="Africa/Johannesburg">Johannesburg (SAST)</SelectItem>
                <SelectItem value="Africa/Nairobi">Nairobi (EAT)</SelectItem>
                <SelectItem value="Asia/Riyadh">Riyadh (AST)</SelectItem>
                <SelectItem value="Asia/Tehran">Tehran (IRST)</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Other</SelectLabel>
                <SelectItem value="UTC">UTC</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Separator className="my-6" />

      {/* Save button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Saving...
            </>
          ) : (
            'Save Settings'
          )}
        </Button>
      </div>
        </>
      )}
    </div>
  );
}
