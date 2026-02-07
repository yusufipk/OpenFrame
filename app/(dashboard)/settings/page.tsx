'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bell, Send, Mail, CheckCircle2, AlertCircle, Loader2, ExternalLink, Globe } from 'lucide-react';
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
  telegramBotToken: string | null;
  telegramChatId: string | null;
  telegramEnabled: boolean;
  emailEnabled: boolean;
  onNewVideo: boolean;
  onNewComment: boolean;
  onNewReply: boolean;
  timezone: string;
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
      <div>
        <span className="text-sm font-medium">{label}</span>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div
        className={cn(
          'w-10 h-6 rounded-full relative transition-colors',
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

export default function SettingsPage() {
  const [settings, setSettings] = useState<NotificationSettings>({
    telegramBotToken: null,
    telegramChatId: null,
    telegramEnabled: false,
    emailEnabled: false,
    onNewVideo: true,
    onNewComment: true,
    onNewReply: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form state for Telegram fields (separate from saved settings for editing)
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');

  useEffect(() => {
    async function fetchSettings() {
      try {
        const res = await fetch('/api/settings/notifications');
        if (res.ok) {
          const data = await res.json();
          setSettings(data);
          setTelegramToken(data.telegramBotToken || '');
          setTelegramChatId(data.telegramChatId || '');
        }
      } catch {
        console.error('Failed to fetch notification settings');
      } finally {
        setLoading(false);
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
          telegramBotToken: telegramToken || null,
          telegramChatId: telegramChatId || null,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setSettings(data);
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
  }, [settings, telegramToken, telegramChatId, showMessage]);

  const handleTest = useCallback(
    async (channel: 'telegram' | 'email') => {
      setTesting(channel);
      try {
        const res = await fetch('/api/settings/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            telegramBotToken: telegramToken,
            telegramChatId,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          showMessage('success', data.message);
        } else {
          showMessage('error', data.error || 'Test failed');
        }
      } catch {
        showMessage('error', 'Test failed');
      } finally {
        setTesting(null);
      }
    },
    [telegramToken, telegramChatId, showMessage]
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
          Manage your notification preferences
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
        <CardContent className="space-y-2">
          <ToggleButton
            enabled={settings.onNewVideo}
            onToggle={() =>
              setSettings((s) => ({ ...s, onNewVideo: !s.onNewVideo }))
            }
            label="New Video Added"
            description="When a new video is added to one of your projects"
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
            Get instant notifications via a Telegram bot
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div>
              <Label htmlFor="telegram-token">Bot Token</Label>
              <Input
                id="telegram-token"
                type="password"
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <Label htmlFor="telegram-chat-id">Chat ID</Label>
              <Input
                id="telegram-chat-id"
                placeholder="-1001234567890"
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                className="mt-1 font-mono text-sm"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ToggleButton
              enabled={settings.telegramEnabled}
              onToggle={() =>
                setSettings((s) => ({ ...s, telegramEnabled: !s.telegramEnabled }))
              }
              label="Enable Telegram notifications"
            />
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTest('telegram')}
            disabled={!telegramToken || !telegramChatId || testing === 'telegram'}
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
    </div>
  );
}
