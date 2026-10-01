'use client';

import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  hasSeenQualityHint,
  markQualityHintSeen,
} from '@/components/video-page/hooks/quality-preference';

/**
 * A one-time pointer at the Quality menu, shown the first time a viewer opens a Bunny video
 * in this browser. It goes away for good once they dismiss it or open the menu.
 */
export function useQualityHint(enabled: boolean) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    // Storage is only readable after mount; reading it during render would not match the
    // server-rendered markup.
    const timer = setTimeout(() => setVisible(!hasSeenQualityHint()), 0);
    return () => clearTimeout(timer);
  }, [enabled]);

  const dismiss = useCallback(() => {
    markQualityHintSeen();
    setVisible(false);
  }, []);

  return { visible: enabled && visible, dismiss };
}

export function QualityHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="note"
      className="absolute bottom-full right-0 z-30 mb-2 w-64 rounded-md border bg-popover p-3 text-xs text-popover-foreground shadow-md"
    >
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <p className="pr-4 font-medium">Playback quality</p>
      <p className="mt-1 text-muted-foreground">
        Auto starts at the best available quality, and short clips play from the original file. Pick
        a quality here and this browser will remember it.
      </p>
    </div>
  );
}
