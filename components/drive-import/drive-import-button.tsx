'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiRequestError, toastApiError } from '@/lib/client/api-error';
import {
  forgetDriveAccessToken,
  DRIVE_VIDEO_MIME_TYPES,
  pickDriveFiles,
  preloadGoogleDrive,
  useGoogleDriveAvailable,
} from '@/lib/client/google-drive-picker';
import { DRIVE_IMPORT_STARTED_EVENT } from '@/components/drive-import/drive-imports-panel';

type StartedImports = {
  imports: Array<{ id: string; fileName: string }>;
  /** Images added as image reviews within the request. */
  images: Array<{ driveFileId: string; videoId: string }>;
  errors: Array<{ driveFileId: string; error: string }>;
};

function GoogleDriveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 87.3 78" className={className} aria-hidden="true">
      <path
        d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z"
        fill="#0066da"
      />
      <path
        d="M43.65 25 29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44A9.06 9.06 0 0 0 0 53h27.5z"
        fill="#00ac47"
      />
      <path
        d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.5z"
        fill="#ea4335"
      />
      <path
        d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z"
        fill="#00832d"
      />
      <path
        d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        fill="#2684fc"
      />
      <path
        d="M73.4 26.5 60.7 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </svg>
  );
}

// Shared by every mounted button. A dialog that closes before the Picker opens
// unmounts its button, and with it any per-button busy state, so a second pick
// could otherwise start while the first import is still being posted.
let importInFlight = false;

// What an image review accepts; GIFs can only be attached as assets.
const IMAGE_REVIEW_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Picks videos (and, for a new file, images) in Google Drive and adds them to
 * the project. A video copy runs on the server side (Bunny or our own storage),
 * so the caller only learns that it started and the project page shows how it
 * goes; an image is already an image review when the request returns.
 */
export function DriveImportButton({
  projectId,
  folderId = null,
  targetVideoId = null,
  disabled = false,
  onBeforePick,
  onStarted,
}: {
  projectId: string;
  folderId?: string | null;
  targetVideoId?: string | null;
  disabled?: boolean;
  /**
   * Runs right before the Picker opens. A modal dialog has to close here: it
   * makes the rest of the page, the Picker included, ignore the pointer.
   */
  onBeforePick?: () => void;
  onStarted: (started: StartedImports) => void;
}) {
  const enabled = useGoogleDriveAvailable();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (enabled) preloadGoogleDrive();
  }, [enabled]);

  if (!enabled) return null;

  const handleClick = async () => {
    if (importInFlight) return;
    importInFlight = true;
    setBusy(true);
    try {
      onBeforePick?.();
      // A new file can be a video or an image review; a new version stays a video.
      const picked = await pickDriveFiles({
        multiple: !targetVideoId,
        mimeTypes: targetVideoId
          ? DRIVE_VIDEO_MIME_TYPES
          : [...DRIVE_VIDEO_MIME_TYPES, ...IMAGE_REVIEW_MIME_TYPES],
        title: targetVideoId ? 'Choose a video to import' : 'Choose videos or images to import',
      });
      if (!picked || picked.files.length === 0) return;

      const response = await fetch(`/api/projects/${projectId}/drive-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileIds: picked.files.map((file) => file.id),
          accessToken: picked.accessToken,
          folderId,
          targetVideoId,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: StartedImports;
        error?: string;
        code?: string;
      } | null;
      if (!response.ok || !payload?.data) {
        if (response.status === 403) forgetDriveAccessToken();
        throw apiRequestError(payload, 'Could not start the import');
      }

      const names = new Map(picked.files.map((file) => [file.id, file.name]));
      for (const failure of payload.data.errors) {
        toast.error(`${names.get(failure.driveFileId) ?? 'A file'}: ${failure.error}`);
      }
      window.dispatchEvent(new Event(DRIVE_IMPORT_STARTED_EVENT));
      onStarted(payload.data);
    } catch (error) {
      toastApiError(error, 'Could not import from Google Drive');
    } finally {
      importInFlight = false;
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={disabled || busy}
      onClick={() => void handleClick()}
    >
      {busy ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <GoogleDriveIcon className="mr-2 h-4 w-4" />
      )}
      {targetVideoId ? 'Import new version from Google Drive' : 'Import from Google Drive'}
    </Button>
  );
}

// Everything an asset can be. The server checks each file's type and bytes.
const ASSET_MIME_TYPES: readonly string[] = [
  ...DRIVE_VIDEO_MIME_TYPES,
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
];

type StartedAssetImports = {
  imports: Array<{ id: string; fileName: string }>;
  assetIds: string[];
  errors: Array<{ driveFileId: string; error: string }>;
};

/**
 * Picks files in Google Drive and attaches them to a video as assets, each as
 * the kind its Drive type says. Images and audio arrive with the response;
 * videos keep copying afterwards and the assets pane picks them up when they land.
 */
export function DriveAssetImportButton({
  videoId,
  disabled = false,
  onImported,
}: {
  videoId: string;
  disabled?: boolean;
  /** Runs when at least one asset was created by the request itself. */
  onImported: () => void;
}) {
  const enabled = useGoogleDriveAvailable();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (enabled) preloadGoogleDrive();
  }, [enabled]);

  if (!enabled) return null;

  const handleClick = async () => {
    if (importInFlight) return;
    importInFlight = true;
    setBusy(true);
    try {
      const picked = await pickDriveFiles({
        multiple: true,
        mimeTypes: ASSET_MIME_TYPES,
        title: 'Choose files to attach',
      });
      if (!picked || picked.files.length === 0) return;

      const response = await fetch(`/api/videos/${videoId}/assets/drive-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileIds: picked.files.map((file) => file.id),
          accessToken: picked.accessToken,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: StartedAssetImports;
        error?: string;
        code?: string;
      } | null;
      if (!response.ok || !payload?.data) {
        if (response.status === 403) forgetDriveAccessToken();
        throw apiRequestError(payload, 'Could not import from Google Drive');
      }

      const names = new Map(picked.files.map((file) => [file.id, file.name]));
      for (const failure of payload.data.errors) {
        toast.error(`${names.get(failure.driveFileId) ?? 'A file'}: ${failure.error}`);
      }
      if (payload.data.assetIds.length > 0) onImported();
      if (payload.data.imports.length > 0) {
        window.dispatchEvent(new Event(DRIVE_IMPORT_STARTED_EVENT));
        toast.success(
          payload.data.imports.length === 1
            ? 'Copying the video from Google Drive. It appears here when it is ready.'
            : `Copying ${payload.data.imports.length} videos from Google Drive. They appear here when they are ready.`
        );
      }
    } catch (error) {
      toastApiError(error, 'Could not import from Google Drive');
      // A long batch can be cut off by a proxy after some files were already
      // attached; reload the list so those show up anyway.
      onImported();
    } finally {
      importInFlight = false;
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={disabled || busy}
      onClick={() => void handleClick()}
    >
      {busy ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <GoogleDriveIcon className="mr-2 h-4 w-4" />
      )}
      Import from Google Drive
    </Button>
  );
}
