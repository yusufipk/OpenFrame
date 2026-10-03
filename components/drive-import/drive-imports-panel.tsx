'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useGoogleDriveAvailable } from '@/lib/client/google-drive-picker';

type DriveImportItem = {
  id: string;
  fileName: string;
  title: string;
  status: 'TRANSFERRING' | 'FINALIZING' | 'DONE' | 'FAILED';
  error: string | null;
  targetVideoId: string | null;
  assetVideoId: string | null;
  createdAt: string;
};

const POLL_INTERVAL_MS = 8000;
// Rows the project panel shows before "Show all".
const COLLAPSED_ROWS = 3;
// After a failed poll (a deploy restart, a network blip) polling carries on,
// just more slowly, as long as something was in flight.
const RETRY_INTERVAL_MS = 20000;

/** Dispatched on window after an import starts, so a mounted watcher polls at once. */
export const DRIVE_IMPORT_STARTED_EVENT = 'openframe:drive-import-started';

function isActive(item: DriveImportItem): boolean {
  return item.status === 'TRANSFERRING' || item.status === 'FINALIZING';
}

/**
 * Polls the uploader's Google Drive imports into a project. Each poll is also
 * what moves them forward on the server, so polling continues while anything
 * is in flight, and `onLanded` runs when an import turned into a video.
 */
function useDriveImports(projectId: string, onLanded: (landed: DriveImportItem[]) => void) {
  const enabled = useGoogleDriveAvailable();
  const [items, setItems] = useState<DriveImportItem[]>([]);
  const seenActive = useRef<Set<string>>(new Set());
  const onLandedRef = useRef(onLanded);

  useEffect(() => {
    onLandedRef.current = onLanded;
  }, [onLanded]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hadActive = false;
    // Until one poll succeeds nothing is known, so a failed first poll retries too.
    let everLoaded = false;
    let inFlight = false;
    let rerun = false;

    const tick = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      // One poll at a time; a start event during a poll asks for one more after it.
      if (inFlight) {
        rerun = true;
        return;
      }
      inFlight = true;
      const response = await fetch(`/api/projects/${projectId}/drive-imports`, {
        cache: 'no-store',
      }).catch(() => null);
      const payload = response?.ok
        ? ((await response.json().catch(() => null)) as {
            data?: { imports?: DriveImportItem[]; landed?: string[] };
          } | null)
        : null;
      inFlight = false;
      if (cancelled) return;
      if (rerun) {
        rerun = false;
        void tick();
        return;
      }

      const imports = payload?.data?.imports;
      if (!imports) {
        if (hadActive || !everLoaded) timer = setTimeout(() => void tick(), RETRY_INTERVAL_MS);
        return;
      }

      everLoaded = true;
      // A video that landed while this page was open, whether the server
      // finalized it on this very poll or an earlier one this page saw in flight.
      const landedIds = new Set(payload?.data?.landed ?? []);
      const landed = imports.filter(
        (item) =>
          item.status === 'DONE' && (landedIds.has(item.id) || seenActive.current.has(item.id))
      );
      for (const item of imports) {
        if (isActive(item)) seenActive.current.add(item.id);
        else seenActive.current.delete(item.id);
      }
      setItems(imports);
      if (landed.length > 0) onLandedRef.current(landed);

      hadActive = imports.some(isActive);
      if (hadActive) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    const restart = () => void tick();
    window.addEventListener(DRIVE_IMPORT_STARTED_EVENT, restart);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener(DRIVE_IMPORT_STARTED_EVENT, restart);
    };
  }, [enabled, projectId]);

  return { enabled, items };
}

// Failed imports stay in the server's list for a day, so a dismissal has to
// outlive the page. Per browser is enough for a notice that expires anyway.
const DISMISSED_STORAGE_PREFIX = 'openframe:drive-imports-dismissed:';
const MAX_REMEMBERED_DISMISSALS = 100;

function readDismissed(projectId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_PREFIX + projectId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    );
  } catch {
    return new Set();
  }
}

function rememberDismissed(projectId: string, ids: Set<string>): void {
  try {
    // Merged with what is stored, so another tab's dismissals are not overwritten.
    const merged = new Set([...readDismissed(projectId), ...ids]);
    window.localStorage.setItem(
      DISMISSED_STORAGE_PREFIX + projectId,
      JSON.stringify([...merged].slice(-MAX_REMEMBERED_DISMISSALS))
    );
  } catch {
    // Private mode or blocked storage: the dismissal lasts for this page only.
  }
}

/** The project page's list of the uploader's imports in flight or failed. */
export function DriveImportsPanel({ projectId }: { projectId: string }) {
  const router = useRouter();
  // Attachments show up on their video's assets pane, not in the project.
  const { enabled, items } = useDriveImports(projectId, (landed) => {
    if (landed.some((item) => !item.assetVideoId)) router.refresh();
  });
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Read after mount: the server render has no storage to read.
    setDismissed(readDismissed(projectId));
  }, [projectId]);

  const dismiss = (ids: string[]) => {
    setDismissed((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      rememberDismissed(projectId, next);
      return next;
    });
  };
  const [expanded, setExpanded] = useState(false);

  const visible = items.filter(
    (item) => item.status !== 'DONE' && !item.assetVideoId && !dismissed.has(item.id)
  );
  if (!enabled || visible.length === 0) return null;

  // In flight first, so a long list of old failures never hides what is running.
  const active = visible.filter(isActive);
  const failed = visible.filter((item) => item.status === 'FAILED');
  const ordered = [...active, ...failed];
  const shown = expanded ? ordered : ordered.slice(0, COLLAPSED_ROWS);
  const hiddenCount = ordered.length - shown.length;

  const summary = [
    active.length > 0 ? `${active.length} copying` : null,
    failed.length > 0 ? `${failed.length} failed` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="mb-5 space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        {active.length > 0 ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          Google Drive imports
          <span className="ml-2 font-normal text-muted-foreground">{summary}</span>
        </p>
        {failed.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => dismiss(failed.map((item) => item.id))}
          >
            Dismiss failed
          </Button>
        )}
      </div>
      {active.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Videos appear here as they finish copying. You can leave this page; they keep copying and
          finish the next time you open the project.
        </p>
      )}
      <ul className={cn('space-y-1.5', expanded && 'max-h-72 overflow-y-auto pr-1')}>
        {shown.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-sm">
            {item.status === 'FAILED' ? (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            ) : item.status === 'FINALIZING' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            ) : (
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate">{item.fileName}</p>
              {item.status === 'FAILED' && (
                <p className="text-xs text-muted-foreground">
                  {item.error || 'The import failed. Pick the file again.'}
                </p>
              )}
            </div>
            {item.status === 'FAILED' && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label="Dismiss"
                onClick={() => dismiss([item.id])}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {(hiddenCount > 0 || expanded) && ordered.length > COLLAPSED_ROWS && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : `Show all ${ordered.length}`}
        </Button>
      )}
    </div>
  );
}

/**
 * The video page's compact version: a spinner while a new version is coming
 * from Drive, a reload when it lands, and a toast if one this page watched fails.
 */
export function DriveVersionImportIndicator({
  projectId,
  videoId,
}: {
  projectId: string;
  videoId: string;
}) {
  // The video page keeps its versions in client state, which a router refresh
  // does not reset, so a landed version needs a real reload to show up.
  const { enabled, items } = useDriveImports(projectId, (landed) => {
    // Only a version of this video is worth a reload; the uploader may have other
    // imports into the project landing while they work here.
    if (landed.some((item) => item.targetVideoId === videoId)) window.location.reload();
  });
  const watched = useRef<Set<string>>(new Set());

  const forThisVideo = items.filter((item) => item.targetVideoId === videoId);

  useEffect(() => {
    for (const item of forThisVideo) {
      if (isActive(item)) {
        watched.current.add(item.id);
      } else if (item.status === 'FAILED' && watched.current.delete(item.id)) {
        toast.error(`${item.fileName}: ${item.error || 'The import from Google Drive failed.'}`);
      }
    }
  }, [forThisVideo]);

  if (!enabled || !forThisVideo.some(isActive)) return null;

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Importing from Drive
    </span>
  );
}

/**
 * The assets pane's view of video attachments coming from Drive: a line while
 * any is copying, `onLanded` when one became an asset, a toast if one failed.
 */
export function DriveAssetImportIndicator({
  projectId,
  videoId,
  onLanded,
}: {
  projectId: string;
  videoId: string;
  onLanded: () => void;
}) {
  const { enabled, items } = useDriveImports(projectId, (landed) => {
    if (landed.some((item) => item.assetVideoId === videoId)) onLanded();
  });
  const watched = useRef<Set<string>>(new Set());

  const forThisVideo = items.filter((item) => item.assetVideoId === videoId);

  useEffect(() => {
    for (const item of forThisVideo) {
      if (isActive(item)) {
        watched.current.add(item.id);
      } else if (item.status === 'FAILED' && watched.current.delete(item.id)) {
        toast.error(`${item.fileName}: ${item.error || 'The import from Google Drive failed.'}`);
      }
    }
  }, [forThisVideo]);

  const active = forThisVideo.filter(isActive);
  if (!enabled || active.length === 0) return null;

  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {active.length === 1
        ? `Copying ${active[0]!.fileName} from Google Drive`
        : `Copying ${active.length} videos from Google Drive`}
    </p>
  );
}
