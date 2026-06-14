import Image from 'next/image';
import { CheckCircle, Link as LinkIcon, MessageSquare, Mic, PenTool } from 'lucide-react';
import type { VisualVariant } from '@/lib/marketing/comparison-types';

interface ProductVisualProps {
  variant: VisualVariant;
}

export function ProductVisual({ variant }: ProductVisualProps) {
  if (variant === 'landing-compare') {
    return (
      <div className="relative aspect-[16/10] overflow-hidden border border-border bg-card">
        <Image
          src="/landing/compare-v2.webp"
          alt="OpenFrame side-by-side version compare"
          fill
          className="object-cover object-top"
          sizes="(max-width: 768px) 100vw, 540px"
          priority
        />
      </div>
    );
  }

  if (variant === 'landing-dashboard') {
    return (
      <div className="relative aspect-[16/10] overflow-hidden border border-border bg-card">
        <Image
          src="/landing/deep-dive-dashboard-2.webp"
          alt="OpenFrame video review dashboard"
          fill
          className="object-cover object-top"
          sizes="(max-width: 768px) 100vw, 540px"
          priority
        />
      </div>
    );
  }

  if (variant === 'version-compare') {
    return (
      <div className="border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-2">
          {['V2', 'V3'].map((version) => (
            <div key={version} className="border border-border/60 bg-background p-3">
              <div className="mb-3 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                <span>{version}</span>
                <span className="text-primary">Compare mode</span>
              </div>
              <div className="aspect-video bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900" />
              <div className="mt-3 space-y-2">
                <div className="h-1.5 w-full rounded-full bg-border">
                  <div
                    className={`h-1.5 rounded-full bg-primary ${version === 'V2' ? 'w-1/3' : 'w-2/3'}`}
                  />
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {version === 'V2' ? '00:01:12 color too cool' : '00:01:12 warmed up +2'}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant === 'approval-workflow') {
    return (
      <div className="border border-border bg-card p-5">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Client Cut V3
            </p>
            <p className="mt-1 text-lg font-semibold">Approval requests</p>
          </div>
          <span className="inline-flex items-center gap-2 border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
            <CheckCircle className="h-3.5 w-3.5" />2 of 3 approved
          </span>
        </div>
        <div className="mt-4 space-y-3">
          {[
            { name: 'Client Producer', status: 'Approved', tone: 'text-emerald-300' },
            { name: 'Brand Manager', status: 'Approved', tone: 'text-emerald-300' },
            { name: 'Legal Review', status: 'Pending', tone: 'text-amber-300' },
          ].map((item) => (
            <div
              key={item.name}
              className="flex items-center justify-between border border-border/60 bg-background px-4 py-3"
            >
              <span className="text-sm">{item.name}</span>
              <span className={`text-xs uppercase tracking-[0.12em] ${item.tone}`}>
                {item.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant === 'guest-review') {
    return (
      <div className="border border-border bg-card p-5">
        <div className="flex items-start gap-3 border border-primary/30 bg-primary/5 p-4">
          <LinkIcon className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <p className="text-sm font-medium">open-frame.net/watch/share-7f3a</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Client opens the link, enters a name, and reviews in the browser. No account required.
            </p>
          </div>
        </div>
        <div className="mt-4 aspect-video border border-border/60 bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-950" />
        <div className="mt-4 flex items-center gap-3 border border-border/60 bg-background p-3">
          <MessageSquare className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-medium">Client note at 00:02:14</p>
            <p className="text-xs text-muted-foreground">Lower the music under the VO here.</p>
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'voice-notes') {
    return (
      <div className="border border-border bg-card p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center bg-secondary font-mono text-xs">
              C
            </div>
            <div>
              <p className="font-mono text-[11px] font-medium">Client</p>
              <p className="font-mono text-[10px] text-muted-foreground">00:03:45</p>
            </div>
          </div>
          <Mic className="h-4 w-4 text-primary" />
        </div>
        <div className="mt-6 flex h-16 items-center gap-1 overflow-hidden">
          {Array.from({ length: 36 }).map((_, index) => (
            <span
              key={index}
              className="w-full flex-1 bg-primary/60"
              style={{
                height: `${[30, 80, 50, 90, 40, 70, 60, 45, 85, 55][index % 10]}%`,
              }}
            />
          ))}
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Voice note pinned to the exact frame—no more typing long explanations.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-border bg-card p-5">
      <div className="aspect-video border border-border/60 bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-950" />
      <div className="relative mt-4 border border-border/60 bg-background p-4">
        <div className="absolute right-4 top-4 rounded-full border border-primary/40 p-2 text-primary">
          <PenTool className="h-4 w-4" />
        </div>
        <p className="font-mono text-[10px] text-muted-foreground">00:01:48</p>
        <p className="mt-2 text-sm">Move the lower third up one line so it clears the subject.</p>
        <div className="mt-4 h-1.5 w-full rounded-full bg-border">
          <div className="h-1.5 w-[42%] rounded-full bg-primary" />
        </div>
      </div>
    </div>
  );
}
