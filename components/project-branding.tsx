/* eslint-disable @next/next/no-img-element -- branding images come from an authenticated proxy route */
import { Video } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ProjectBrandBanner({ src, className }: { src: string; className?: string }) {
  return (
    <div className={cn('w-full aspect-[4/1] max-h-44 overflow-hidden border bg-muted', className)}>
      <img src={src} alt="" className="h-full w-full object-cover" />
    </div>
  );
}

export function ProjectBrandLogo({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      className={cn('h-10 w-10 shrink-0 border bg-background object-contain', className)}
    />
  );
}

export function PoweredByOpenFrame({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-1.5 text-xs text-muted-foreground',
        className
      )}
    >
      <Video className="h-3.5 w-3.5" />
      Powered by <span className="font-medium text-foreground">OpenFrame</span>
    </div>
  );
}
