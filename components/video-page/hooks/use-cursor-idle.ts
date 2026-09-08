import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the cursor has to sit still over the player before it and the overlay hide. */
export const CURSOR_IDLE_DELAY_MS = 1000;

/**
 * Tracks whether the cursor has rested over the player long enough to hide it
 * and the play/pause overlay. Playback can start without the cursor moving (a
 * click, a key, the resume after a scrub), so the countdown is re-armed on
 * every playback change. Only pointer activity wakes the cursor: a pause/play
 * pair the element emits on its own (rebuffering, a source switch) leaves the
 * idle state alone, so the chrome does not flash back for a second.
 */
export function useCursorIdle(isPlaying: boolean) {
  const [cursorIdle, setCursorIdle] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCursorOverPlayerRef = useRef(false);

  // Restart the countdown. It only runs while the cursor is over the player
  // and playback is running; otherwise nothing is pending.
  const armTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;

    if (!isCursorOverPlayerRef.current || !isPlaying) return;

    timerRef.current = setTimeout(() => {
      setCursorIdle(true);
    }, CURSOR_IDLE_DELAY_MS);
  }, [isPlaying]);

  const handleVideoMouseMove = useCallback(() => {
    isCursorOverPlayerRef.current = true;
    setCursorIdle(false);
    armTimer();
  }, [armTimer]);

  const handleVideoMouseLeave = useCallback(() => {
    isCursorOverPlayerRef.current = false;
    setCursorIdle(false);
    armTimer();
  }, [armTimer]);

  useEffect(() => {
    armTimer();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [armTimer]);

  return { cursorIdle, handleVideoMouseMove, handleVideoMouseLeave };
}
