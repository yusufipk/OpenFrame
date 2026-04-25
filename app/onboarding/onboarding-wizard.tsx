'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Video,
  Building2,
  FolderPlus,
  PlayCircle,
  Bell,
  ChevronRight,
  Loader2,
  Lock,
  UserPlus,
  Globe,
  Youtube,
  Upload,
  Mail,
  AlertCircle,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

type Visibility = 'PRIVATE' | 'INVITE' | 'PUBLIC';

const TOTAL_STEPS = 5;

const visibilityOptions: {
  value: Visibility;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'PRIVATE',
    label: 'Private',
    description: 'Only workspace members and project members can access',
    icon: <Lock className="h-5 w-5" />,
  },
  {
    value: 'INVITE',
    label: 'Invite Only',
    description: 'Share with specific people via email',
    icon: <UserPlus className="h-5 w-5" />,
  },
  {
    value: 'PUBLIC',
    label: 'Public',
    description: 'Anyone with the link can view',
    icon: <Globe className="h-5 w-5" />,
  },
];

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
        'flex items-center justify-between w-full px-3 py-2 rounded-lg border transition-colors text-left',
        enabled ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-accent/50'
      )}
    >
      <div className="flex-1 min-w-0 pr-4">
        <span className="text-sm font-medium">{label}</span>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
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

// ─── Step 1: Welcome ───────────────────────────────────────────────────────────

function StepWelcome({ userName, onNext }: { userName: string; onNext: () => void }) {
  return (
    <div className="text-center space-y-8">
      <div className="mx-auto w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center">
        <Video className="h-12 w-12 text-primary" />
      </div>
      <div className="space-y-3">
        <h2 className="text-3xl font-bold tracking-tight">
          Welcome to OpenFrame, {userName.split(' ')[0]}!
        </h2>
        <p className="text-base text-muted-foreground max-w-md mx-auto">
          OpenFrame is your collaborative video review platform. Collect timestamped feedback,
          manage versions, and streamline approvals — all in one place.
        </p>
      </div>
      <Button onClick={onNext} size="lg" className="w-full sm:w-auto px-10 h-12 text-base">
        Get Started
        <ChevronRight className="h-5 w-5 ml-1" />
      </Button>
    </div>
  );
}

// ─── Step 2: Create Workspace ──────────────────────────────────────────────────

function StepWorkspace({
  canCreateWorkspace,
  availableWorkspaces,
  selectedWorkspaceId,
  onWorkspaceSelected,
  onNext,
  onWorkspaceCreated,
}: {
  canCreateWorkspace: boolean;
  availableWorkspaces: Array<{ id: string; name: string; isOwner: boolean }>;
  selectedWorkspaceId: string | null;
  onWorkspaceSelected: (workspaceId: string) => void;
  onNext: () => void;
  onWorkspaceCreated: (id: string) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({ name: '', description: '' });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create workspace');
        return;
      }
      onWorkspaceCreated(data.data.id);
      onNext();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (!canCreateWorkspace) {
    return (
      <div className="space-y-7">
        <div className="text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-3">
            <Building2 className="h-8 w-8 text-primary" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">Workspace access</h2>
          <p className="text-base text-muted-foreground">
            Your account can&apos;t create a new workspace right now.
          </p>
        </div>

        {availableWorkspaces.length > 0 ? (
          <div className="space-y-5">
            <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                You can still create projects inside workspaces where you already have admin access.
              </span>
            </div>

            <div className="space-y-2">
              <Label htmlFor="onboarding-workspace">Choose a workspace</Label>
              <Select value={selectedWorkspaceId ?? undefined} onValueChange={onWorkspaceSelected}>
                <SelectTrigger id="onboarding-workspace" className="w-full">
                  <SelectValue placeholder="Select a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {availableWorkspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                      {workspace.isOwner ? ' (Owner)' : ' (Admin)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button onClick={onNext} className="w-full h-11" disabled={!selectedWorkspaceId}>
              Continue
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                You don&apos;t currently have a workspace where you can create projects. Ask a
                workspace owner to invite you as an admin, or upgrade later to create your own
                workspace.
              </span>
            </div>
            <Button onClick={onNext} className="w-full h-11">
              Continue
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div className="text-center space-y-3">
        <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-3">
          <Building2 className="h-8 w-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight">Create your workspace</h2>
        <p className="text-base text-muted-foreground">
          Workspaces organize your projects and team members.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="ws-name" className="text-sm font-medium">
            Workspace Name
          </Label>
          <Input
            id="ws-name"
            placeholder="e.g., My Studio"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
            disabled={isLoading}
            className="h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ws-desc" className="text-sm font-medium">
            Description <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Textarea
            id="ws-desc"
            placeholder="What is this workspace for?"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            rows={3}
            disabled={isLoading}
            className="resize-none"
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <Button
            type="submit"
            className="w-full h-11"
            disabled={isLoading || !formData.name.trim()}
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Workspace'
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onNext}
            disabled={isLoading}
            className="w-full text-muted-foreground"
          >
            Skip this step
          </Button>
        </div>
      </form>
    </div>
  );
}

// ─── Step 3: Create Project ────────────────────────────────────────────────────

function StepProject({
  workspaceId,
  availableWorkspaces,
  canCreateWorkspace,
  onNext,
  onProjectCreated,
}: {
  workspaceId: string | null;
  availableWorkspaces: Array<{ id: string; name: string; isOwner: boolean }>;
  canCreateWorkspace: boolean;
  onNext: () => void;
  onProjectCreated: (id: string) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    visibility: 'PRIVATE' as Visibility,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create project');
        return;
      }
      onProjectCreated(data.data.id);
      onNext();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-7">
      <div className="text-center space-y-3">
        <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-3">
          <FolderPlus className="h-8 w-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight">Create your first project</h2>
        <p className="text-base text-muted-foreground">
          Projects hold your videos and collected feedback.
        </p>
      </div>

      {!workspaceId ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              {canCreateWorkspace
                ? 'You skipped workspace creation. Projects require a workspace — you can create both from the dashboard later.'
                : availableWorkspaces.length === 0
                  ? 'You do not currently have permission to create projects in any workspace.'
                  : 'Pick a workspace in the previous step to create a project here.'}
            </span>
          </div>
          <Button onClick={onNext} className="w-full h-11">
            Continue
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="proj-name" className="text-sm font-medium">
              Project Name
            </Label>
            <Input
              id="proj-name"
              placeholder="e.g., Product Demo Q1"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
              disabled={isLoading}
              className="h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proj-desc" className="text-sm font-medium">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id="proj-desc"
              placeholder="Brief description of what this project is about..."
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              rows={3}
              disabled={isLoading}
              className="resize-none"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Who can access?</Label>
            <div className="grid gap-2.5">
              {visibilityOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFormData({ ...formData, visibility: option.value })}
                  disabled={isLoading}
                  className={cn(
                    'w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all',
                    formData.visibility === option.value
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border hover:border-border/80 hover:bg-accent/50'
                  )}
                >
                  <div
                    className={cn(
                      'shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
                      formData.visibility === option.value
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {option.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{option.label}</div>
                    <div className="text-sm text-muted-foreground">{option.description}</div>
                  </div>
                  <div
                    className={cn(
                      'shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center',
                      formData.visibility === option.value
                        ? 'border-primary bg-primary'
                        : 'border-muted-foreground/30'
                    )}
                  >
                    {formData.visibility === option.value && (
                      <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2 pt-1">
            <Button
              type="submit"
              className="w-full h-11"
              disabled={isLoading || !formData.name.trim()}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Project'
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onNext}
              disabled={isLoading}
              className="w-full text-muted-foreground"
            >
              Skip this step
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── Step 4: Add First Video (informational) ───────────────────────────────────

function StepVideo({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-7">
      <div className="text-center space-y-3">
        <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-3">
          <PlayCircle className="h-8 w-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight">Adding videos</h2>
        <p className="text-base text-muted-foreground">
          OpenFrame supports two ways to add video content to your projects.
        </p>
      </div>

      <div className="grid gap-4">
        <div className="rounded-xl border p-5 space-y-2">
          <div className="flex items-center gap-2.5 font-semibold">
            <Youtube className="h-5 w-5 text-red-500" />
            YouTube link
          </div>
          <p className="text-sm text-muted-foreground">
            Paste a link to any YouTube video. OpenFrame will pull in the title, thumbnail, and
            duration automatically — no file upload needed.
          </p>
        </div>
        <div className="rounded-xl border p-5 space-y-2">
          <div className="flex items-center gap-2.5 font-semibold">
            <Upload className="h-5 w-5 text-primary" />
            Direct upload
          </div>
          <p className="text-sm text-muted-foreground">
            Upload video files directly from your device. Files are processed and delivered via CDN
            for fast, reliable playback worldwide.
          </p>
        </div>
      </div>

      <Button onClick={onNext} className="w-full h-11">
        Got it, continue
        <ChevronRight className="h-4 w-4 ml-1" />
      </Button>
    </div>
  );
}

// ─── Step 5: Notification Preferences ─────────────────────────────────────────

function StepNotifications({ onFinish }: { onFinish: () => Promise<void> }) {
  const [isSaving, setIsSaving] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [events, setEvents] = useState({
    onNewVideo: true,
    onNewVersion: true,
    onNewComment: true,
    onNewReply: true,
    onApprovalEvents: true,
  });

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailEnabled,
          telegramEnabled: false,
          telegramBotToken: null,
          telegramChatId: null,
          onNewVideo: events.onNewVideo,
          onNewVersion: events.onNewVersion,
          onNewComment: events.onNewComment,
          onNewReply: events.onNewReply,
          onApprovalEvents: events.onApprovalEvents,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      });
    } catch {
      // best-effort; don't block finishing
    }
    await onFinish();
  };

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
          <Bell className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-xl font-bold tracking-tight">Notification preferences</h2>
        <p className="text-sm text-muted-foreground">
          Choose when you want to be notified. Email and Telegram are both supported — you can
          configure Telegram anytime in Settings.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Mail className="h-4 w-4" />
            Channels
          </div>
          <ToggleButton
            enabled={emailEnabled}
            onToggle={() => setEmailEnabled((v) => !v)}
            label="Email notifications"
            description="Receive emails to your account address"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Bell className="h-4 w-4" />
            Events
          </div>
          <ToggleButton
            enabled={events.onNewVideo}
            onToggle={() => setEvents((e) => ({ ...e, onNewVideo: !e.onNewVideo }))}
            label="New Video Added"
            description="When a new video is added to one of your projects"
          />
          <ToggleButton
            enabled={events.onNewVersion}
            onToggle={() => setEvents((e) => ({ ...e, onNewVersion: !e.onNewVersion }))}
            label="New Version Added"
            description="When a new version is added to an existing video"
          />
          <ToggleButton
            enabled={events.onNewComment}
            onToggle={() => setEvents((e) => ({ ...e, onNewComment: !e.onNewComment }))}
            label="New Comment"
            description="When someone leaves a comment on your videos"
          />
          <ToggleButton
            enabled={events.onNewReply}
            onToggle={() => setEvents((e) => ({ ...e, onNewReply: !e.onNewReply }))}
            label="New Reply"
            description="When someone replies to a comment thread"
          />
          <ToggleButton
            enabled={events.onApprovalEvents}
            onToggle={() => setEvents((e) => ({ ...e, onApprovalEvents: !e.onApprovalEvents }))}
            label="Approval Workflow"
            description="When approval requests are created, responded to, or finalized"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Button onClick={handleSave} className="w-full h-11" disabled={isSaving}>
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            'Save & finish'
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onFinish}
          disabled={isSaving}
          className="w-full text-muted-foreground"
        >
          Skip
        </Button>
      </div>
    </div>
  );
}

// ─── Wizard Shell ──────────────────────────────────────────────────────────────

export function OnboardingWizard({
  userName,
  canCreateWorkspace,
  availableWorkspaces,
}: {
  userName: string;
  canCreateWorkspace: boolean;
  availableWorkspaces: Array<{ id: string; name: string; isOwner: boolean }>;
}) {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(1);
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(
    availableWorkspaces[0]?.id ?? null
  );
  const [isCompleting, setIsCompleting] = useState(false);

  const goNext = () => setCurrentStep((s) => Math.min(s + 1, TOTAL_STEPS));

  const completeOnboarding = async () => {
    setIsCompleting(true);
    try {
      const res = await fetch('/api/onboarding/complete', { method: 'POST' });
      if (!res.ok) {
        toast.error('Failed to complete setup. Please try again.');
        setIsCompleting(false);
        return;
      }
    } catch {
      toast.error('Something went wrong. Please try again.');
      setIsCompleting(false);
      return;
    }
    router.push('/dashboard');
  };

  return (
    <div className="w-full max-w-2xl">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-8">
        {/* Step dots */}
        <div className="flex items-center gap-2.5">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((step) => (
            <div
              key={step}
              className={cn(
                'rounded-full transition-all',
                step === currentStep
                  ? 'w-7 h-3 bg-primary'
                  : step < currentStep
                    ? 'w-3 h-3 bg-primary/40'
                    : 'w-3 h-3 bg-muted'
              )}
            />
          ))}
        </div>

        {/* Skip button */}
        {currentStep > 1 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={completeOnboarding}
            disabled={isCompleting}
            className="text-muted-foreground text-sm"
          >
            {isCompleting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Skip setup
          </Button>
        )}
      </div>

      {/* Step content */}
      <Card className="border-border/50 shadow-lg">
        <CardContent className="pt-10 pb-10 px-10">
          {currentStep === 1 && <StepWelcome userName={userName} onNext={goNext} />}
          {currentStep === 2 && (
            <StepWorkspace
              canCreateWorkspace={canCreateWorkspace}
              availableWorkspaces={availableWorkspaces}
              selectedWorkspaceId={createdWorkspaceId}
              onWorkspaceSelected={setCreatedWorkspaceId}
              onNext={goNext}
              onWorkspaceCreated={setCreatedWorkspaceId}
            />
          )}
          {currentStep === 3 && (
            <StepProject
              workspaceId={createdWorkspaceId}
              availableWorkspaces={availableWorkspaces}
              canCreateWorkspace={canCreateWorkspace}
              onNext={goNext}
              onProjectCreated={() => {}}
            />
          )}
          {currentStep === 4 && <StepVideo onNext={goNext} />}
          {currentStep === 5 && <StepNotifications onFinish={completeOnboarding} />}
        </CardContent>
      </Card>

      {/* Step label */}
      <p className="text-center text-sm text-muted-foreground mt-5">
        Step {currentStep} of {TOTAL_STEPS}
      </p>
    </div>
  );
}
