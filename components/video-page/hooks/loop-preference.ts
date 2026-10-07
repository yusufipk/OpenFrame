/** Looping is remembered per review video in this browser, across its versions. */
export function readStoredLoopPreference(videoId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(`openframe:loop:${videoId}`) === 'true';
  } catch {
    return false;
  }
}

export function writeStoredLoopPreference(videoId: string, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`openframe:loop:${videoId}`, String(enabled));
  } catch {
    // Storage-disabled browsers can loop for this visit but cannot remember the choice.
  }
}
