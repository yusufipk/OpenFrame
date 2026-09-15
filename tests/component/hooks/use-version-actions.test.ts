import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { useVersionActions } from '@/components/video-page/hooks/use-version-actions';
import type { Comment, Version, VideoData } from '@/components/video-page/types';

const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

interface FakeTusOptions {
  endpoint: string;
  headers: Record<string, string>;
  metadata: Record<string, string>;
  onError: (error: Error) => void;
  onProgress: (bytesUploaded: number, bytesTotal: number) => void;
  onSuccess: () => void;
}

/** Every tus upload the hook constructed, and how the fake client behaves. */
const tusUploads: { fileName: string; options: FakeTusOptions }[] = [];
let tusFailure: string | null = null;

// tus-js-client talks to Bunny over the network. The fake keeps the callback
// contract (onProgress then onSuccess, or onError) and nothing else.
vi.mock('tus-js-client', () => ({
  Upload: class FakeUpload {
    private options: FakeTusOptions;

    constructor(file: File, options: FakeTusOptions) {
      this.options = options;
      tusUploads.push({ fileName: file.name, options });
    }

    start() {
      if (tusFailure) {
        this.options.onError(new Error(tusFailure));
        return;
      }
      this.options.onProgress(512, 1024);
      this.options.onSuccess();
    }
  },
}));

const uploadVideoToR2 = vi.fn();
const cleanupPendingR2VideoUpload = vi.fn();

// The R2 client does presigning and multipart PUTs over XHR: a boundary, not a
// helper of this hook.
vi.mock('@/lib/client/r2-video-upload', () => ({
  uploadVideoToR2: (...args: unknown[]) => uploadVideoToR2(...args),
  cleanupPendingR2VideoUpload: (...args: unknown[]) => cleanupPendingR2VideoUpload(...args),
}));

type Params = Parameters<typeof useVersionActions>[0];
type HookParams = Omit<Params, 'setVideo' | 'activeVersionId' | 'setActiveVersionId'>;

const PROJECT_ID = 'proj1';
const VIDEO_ID = 'vid1';
const VERSIONS_URL = `/api/projects/${PROJECT_ID}/videos/${VIDEO_ID}/versions`;
const BUNNY_INIT_URL = `/api/projects/${PROJECT_ID}/videos/bunny-init`;
const DIRECT_URL = 'https://files.example.test/clip.mp4';

function makeVersion(overrides: Partial<Version> = {}): Version & { comments: Comment[] } {
  return {
    id: 'ver1',
    versionNumber: 1,
    versionLabel: null,
    providerId: 'direct',
    videoId: VIDEO_ID,
    originalUrl: 'https://files.example.test/v1.mp4',
    title: null,
    thumbnailUrl: null,
    duration: 600,
    isActive: true,
    _count: { comments: 0 },
    comments: [],
    ...overrides,
  };
}

function makeVideo(): VideoData {
  return {
    id: VIDEO_ID,
    title: 'Cut 3',
    description: null,
    projectId: PROJECT_ID,
    project: { name: 'Ad campaign', ownerId: 'user1' },
    isAuthenticated: true,
    currentUserId: 'user1',
    currentUserName: 'Ada',
    // ver1 is the one on screen; ver3 is the row the server has flagged active.
    versions: [
      makeVersion({ isActive: false }),
      makeVersion({ id: 'ver2', versionNumber: 2, isActive: false }),
      makeVersion({ id: 'ver3', versionNumber: 3, isActive: true }),
    ],
  };
}

/** What the versions POST answers with on success. */
const createdVersion = {
  id: 'ver-new',
  versionNumber: 4,
  versionLabel: null,
  providerId: 'direct',
  videoId: VIDEO_ID,
  originalUrl: DIRECT_URL,
  title: null,
  thumbnailUrl: '/placeholder-video-thumbnail.png',
  duration: null,
  isActive: true,
  _count: { comments: 0 },
};

function ok(payload: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

function fail(status: number, payload: unknown = {}) {
  return { ok: false, status, json: () => Promise.resolve(payload) };
}

let fetchMock: ReturnType<typeof vi.fn>;

function callsTo(url: string, method?: string) {
  return fetchMock.mock.calls.filter(
    (call) => call[0] === url && (call[1]?.method ?? undefined) === method
  );
}

function bodyOf(call: unknown[]): unknown {
  return JSON.parse((call[1] as { body: string }).body);
}

function useHarness(overrides: Partial<HookParams>) {
  const [video, setVideo] = useState<VideoData | null>(makeVideo());
  const [activeVersionId, setActiveVersionId] = useState<string | null>('ver1');
  const actions = useVersionActions({
    projectId: PROJECT_ID,
    videoId: VIDEO_ID,
    setVideo,
    activeVersionId,
    setActiveVersionId,
    ...overrides,
  });
  return { video, activeVersionId, actions };
}

type Harness = RenderHookResult<ReturnType<typeof useHarness>, Partial<HookParams>>;

function renderVersionActions(overrides: Partial<HookParams> = {}): Harness {
  return renderHook((props: Partial<HookParams>) => useHarness(props), {
    initialProps: overrides,
  });
}

function versionIds(harness: Harness): string[] {
  return (harness.result.current.video?.versions ?? []).map((v) => v.id);
}

function makeFile(name = 'my clip.mp4') {
  return new File(['0123456789'], name, { type: 'video/mp4' });
}

beforeEach(() => {
  tusUploads.length = 0;
  tusFailure = null;
  // The runtime resolver reads BUNNY_CDN_URL first, so pin it rather than
  // inheriting the value a developer has in .env.
  vi.stubEnv('BUNNY_CDN_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://cdn.example.test');
  fetchMock = vi.fn((url: string) => {
    if (url === BUNNY_INIT_URL) {
      return Promise.resolve(
        ok({
          data: {
            videoId: 'bunny-vid',
            libraryId: '1234',
            signature: 'sig',
            expirationTime: 1800000000,
            uploadToken: 'upload-token',
          },
        })
      );
    }
    if (url === VERSIONS_URL) {
      return Promise.resolve(ok({ data: createdVersion }));
    }
    return Promise.resolve(ok({ data: {} }));
  });
  vi.stubGlobal('fetch', fetchMock);
  uploadVideoToR2.mockResolvedValue({
    proxyUrl: '/api/upload/video/proj1/clip.mp4',
    objectKey: 'proj1/clip.mp4',
    uploadToken: 'r2-upload-token',
    reservationId: 'res1',
    thumbnailObjectKey: 'proj1/clip.jpg',
    thumbnailUrl: '/api/upload/image/proj1/clip.jpg',
    duration: 42,
  });
  cleanupPendingR2VideoUpload.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toastError.mockReset();
  toastSuccess.mockReset();
  uploadVideoToR2.mockReset();
  cleanupPendingR2VideoUpload.mockReset();
});

describe('useVersionActions typing a URL', () => {
  it('recognises a supported URL and clears any earlier complaint', () => {
    const harness = renderVersionActions();

    act(() => harness.result.current.actions.handleNewVersionUrlChange(DIRECT_URL));

    expect(harness.result.current.actions.newVersionUrl).toBe(DIRECT_URL);
    expect(harness.result.current.actions.newVersionSource).toEqual({
      providerId: 'direct',
      videoId: DIRECT_URL,
      originalUrl: DIRECT_URL,
    });
    expect(harness.result.current.actions.newVersionUrlError).toBe('');
  });

  it('complains once the unrecognised URL is long enough to be a real attempt', () => {
    const harness = renderVersionActions();

    act(() =>
      harness.result.current.actions.handleNewVersionUrlChange('https://example.test/not-a-video')
    );

    expect(harness.result.current.actions.newVersionSource).toBeNull();
    expect(harness.result.current.actions.newVersionUrlError).toBe('Unsupported URL');
  });

  it('stays quiet while the field holds fewer than eleven characters', () => {
    const harness = renderVersionActions();

    act(() => harness.result.current.actions.handleNewVersionUrlChange('https://ex'));

    expect(harness.result.current.actions.newVersionUrlError).toBe('');
    expect(harness.result.current.actions.newVersionSource).toBeNull();
  });

  it('resets the source when the field is emptied again', () => {
    const harness = renderVersionActions();

    act(() => harness.result.current.actions.handleNewVersionUrlChange(DIRECT_URL));
    act(() => harness.result.current.actions.handleNewVersionUrlChange('   '));

    expect(harness.result.current.actions.newVersionSource).toBeNull();
    expect(harness.result.current.actions.newVersionUrlError).toBe('');
  });
});

describe('useVersionActions creating a version from a URL', () => {
  async function createFromUrl(harness: Harness, url = DIRECT_URL) {
    act(() => harness.result.current.actions.handleNewVersionUrlChange(url));
    await act(async () => {
      await harness.result.current.actions.handleCreateVersion();
    });
  }

  it('posts the parsed source and the derived thumbnail to the versions route', async () => {
    const harness = renderVersionActions();

    await createFromUrl(harness);

    const post = callsTo(VERSIONS_URL, 'POST')[0];
    expect(bodyOf(post)).toEqual({
      videoUrl: DIRECT_URL,
      providerId: 'direct',
      providerVideoId: DIRECT_URL,
      uploadToken: null,
      objectKey: null,
      reservationId: null,
      versionLabel: null,
      thumbnailUrl: '/placeholder-video-thumbnail.png',
      duration: null,
      setActive: true,
    });
  });

  it('puts the new version first and demotes every other one', async () => {
    const harness = renderVersionActions();

    await createFromUrl(harness);

    expect(versionIds(harness)).toEqual(['ver-new', 'ver1', 'ver2', 'ver3']);
    const versions = harness.result.current.video?.versions ?? [];
    expect(versions.map((v) => v.isActive)).toEqual([true, false, false, false]);
    expect(versions[0].comments).toEqual([]);
    expect(harness.result.current.activeVersionId).toBe('ver-new');
  });

  it('closes the dialog and empties the form once the version exists', async () => {
    const harness = renderVersionActions();
    act(() => harness.result.current.actions.setShowVersionDialog(true));
    act(() => harness.result.current.actions.setNewVersionLabel('Client cut'));

    await createFromUrl(harness);

    expect(harness.result.current.actions.showVersionDialog).toBe(false);
    expect(harness.result.current.actions.newVersionUrl).toBe('');
    expect(harness.result.current.actions.newVersionLabel).toBe('');
    expect(harness.result.current.actions.newVersionSource).toBeNull();
    expect(harness.result.current.actions.newVersionFile).toBeNull();
    expect(harness.result.current.actions.isCreatingVersion).toBe(false);
  });

  it('sends a trimmed label when the editor typed one', async () => {
    const harness = renderVersionActions();
    act(() => harness.result.current.actions.setNewVersionLabel('  Client cut  '));

    await createFromUrl(harness);

    expect(bodyOf(callsTo(VERSIONS_URL, 'POST')[0])).toMatchObject({
      versionLabel: 'Client cut',
    });
  });

  it('does nothing at all without a project', async () => {
    const harness = renderVersionActions({ projectId: undefined });

    await createFromUrl(harness);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.result.current.actions.isCreatingVersion).toBe(false);
  });

  it('refuses a URL no provider recognised', async () => {
    const harness = renderVersionActions();

    await createFromUrl(harness, 'https://example.test/not-a-video');

    expect(callsTo(VERSIONS_URL, 'POST')).toHaveLength(0);
    expect(toastError).toHaveBeenCalledWith('Invalid URL');
  });

  it('leaves the version list and the dialog untouched when the server refuses', async () => {
    fetchMock.mockResolvedValue(fail(403, { error: 'Only editors can add versions' }));
    const harness = renderVersionActions();
    act(() => harness.result.current.actions.setShowVersionDialog(true));

    await createFromUrl(harness);

    expect(versionIds(harness)).toEqual(['ver1', 'ver2', 'ver3']);
    expect(harness.result.current.activeVersionId).toBe('ver1');
    expect(harness.result.current.actions.showVersionDialog).toBe(true);
    expect(toastError).toHaveBeenCalledWith('Only editors can add versions');
    expect(harness.result.current.actions.isCreatingVersion).toBe(false);
  });

  it('falls back to a generic message when the failure body says nothing', async () => {
    fetchMock.mockResolvedValue(fail(500, {}));
    const harness = renderVersionActions();

    await createFromUrl(harness);

    expect(toastError).toHaveBeenCalledWith('Failed to create version');
  });

  it('reports a network failure without leaving the dialog spinning', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderVersionActions();

    await createFromUrl(harness);

    expect(toastError).toHaveBeenCalledWith('offline');
    expect(harness.result.current.actions.isCreatingVersion).toBe(false);
    expect(versionIds(harness)).toEqual(['ver1', 'ver2', 'ver3']);
  });
});

describe('useVersionActions uploading a file to Bunny', () => {
  async function createFromFile(harness: Harness, file = makeFile()) {
    act(() => {
      harness.result.current.actions.setNewVersionMode('file');
      harness.result.current.actions.setNewVersionFile(file);
    });
    await act(async () => {
      await harness.result.current.actions.handleCreateVersion();
    });
  }

  it('refuses the file tab when the host has direct uploads switched off', async () => {
    const harness = renderVersionActions({ directUploadsEnabled: false });

    await createFromFile(harness);

    expect(toastError).toHaveBeenCalledWith('Direct uploads are disabled by this host');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to upload nothing', async () => {
    const harness = renderVersionActions({ directUploadsEnabled: true });
    act(() => harness.result.current.actions.setNewVersionMode('file'));

    await act(async () => {
      await harness.result.current.actions.handleCreateVersion();
    });

    expect(toastError).toHaveBeenCalledWith('No file selected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('initialises the Bunny upload with the filename minus its extension', async () => {
    const harness = renderVersionActions({ directUploadsEnabled: true });

    await createFromFile(harness);

    // The size goes with the title: the server checks it against the quota and
    // reserves it before Bunny is asked for anything, so an upload that cannot
    // fit is refused here rather than after it has been sent.
    expect(bodyOf(callsTo(BUNNY_INIT_URL, 'POST')[0])).toEqual({
      targetVideoId: 'vid1',
      title: 'my clip',
      sizeBytes: '10',
    });
    expect(tusUploads[0].options.endpoint).toBe('https://video.bunnycdn.com/tusupload');
    expect(tusUploads[0].options.headers).toEqual({
      AuthorizationSignature: 'sig',
      AuthorizationExpire: '1800000000',
      VideoId: 'bunny-vid',
      LibraryId: '1234',
    });
    expect(tusUploads[0].options.metadata).toEqual({ filetype: 'video/mp4', title: 'my clip' });
  });

  it('prefers the version label over the filename as the Bunny title', async () => {
    const harness = renderVersionActions({ directUploadsEnabled: true });
    act(() => harness.result.current.actions.setNewVersionLabel('  Client cut  '));

    await createFromFile(harness);

    expect(bodyOf(callsTo(BUNNY_INIT_URL, 'POST')[0])).toEqual({
      targetVideoId: 'vid1',
      title: 'Client cut',
      sizeBytes: '10',
    });
  });

  it('registers the version against the Bunny embed and CDN thumbnail', async () => {
    const harness = renderVersionActions({ directUploadsEnabled: true });

    await createFromFile(harness);

    expect(bodyOf(callsTo(VERSIONS_URL, 'POST')[0])).toEqual({
      videoUrl: 'https://iframe.mediadelivery.net/embed/1234/bunny-vid',
      providerId: 'bunny',
      providerVideoId: 'bunny-vid',
      uploadToken: 'upload-token',
      objectKey: null,
      reservationId: null,
      versionLabel: null,
      thumbnailUrl: 'https://cdn.example.test/bunny-vid/thumbnail.jpg',
      duration: null,
      setActive: true,
    });
  });

  it('sends no thumbnail when no CDN hostname is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', '');
    const harness = renderVersionActions({ directUploadsEnabled: true });

    await createFromFile(harness);

    expect(bodyOf(callsTo(VERSIONS_URL, 'POST')[0])).toMatchObject({ thumbnailUrl: null });
  });

  it('reports upload progress and then resets it', async () => {
    const harness = renderVersionActions({ directUploadsEnabled: true });

    await createFromFile(harness);

    expect(harness.result.current.actions.newVersionUploadProgress).toBe(0);
    expect(harness.result.current.actions.newVersionUploadStatus).toBe('');
  });

  it('surfaces a failed initialisation and never starts a tus upload', async () => {
    fetchMock.mockResolvedValueOnce(fail(500, {}));
    const harness = renderVersionActions({ directUploadsEnabled: true });

    await createFromFile(harness);

    expect(tusUploads).toHaveLength(0);
    expect(toastError).toHaveBeenCalledWith('Failed to initialize upload');
    expect(callsTo(BUNNY_INIT_URL, 'DELETE')).toHaveLength(0);
  });

  // This is the rollback path: the bytes are already on Bunny when the versions
  // route rejects, so the pending video has to be handed back.
  it('deletes the pending Bunny video when the version cannot be registered', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === VERSIONS_URL) return Promise.resolve(fail(507, { error: 'Storage full' }));
      return Promise.resolve(
        ok({
          data: {
            videoId: 'bunny-vid',
            libraryId: '1234',
            signature: 'sig',
            expirationTime: 1800000000,
            uploadToken: 'upload-token',
          },
        })
      );
    });
    const harness = renderVersionActions({ directUploadsEnabled: true });

    await createFromFile(harness);

    const cleanup = callsTo(BUNNY_INIT_URL, 'DELETE')[0];
    expect(bodyOf(cleanup)).toEqual({ videoId: 'bunny-vid', uploadToken: 'upload-token' });
    expect(toastError).toHaveBeenCalledWith('Storage full');
    expect(versionIds(harness)).toEqual(['ver1', 'ver2', 'ver3']);
  });

  it('does not delete anything after a version was created successfully', async () => {
    const harness = renderVersionActions({ directUploadsEnabled: true });

    await createFromFile(harness);

    expect(callsTo(BUNNY_INIT_URL, 'DELETE')).toHaveLength(0);
  });

  // bunny-init has already created a video on Bunny by the time tus runs. `pendingCleanup`
  // used to be assigned only after uploadNewVersionFile returned, so a tus failure threw
  // past the assignment and left that video behind: billed, and invisible in the app. It
  // is registered as soon as bunny-init answers now.
  it('deletes the Bunny video when the tus upload itself fails', async () => {
    tusFailure = 'connection reset';
    const harness = renderVersionActions({ directUploadsEnabled: true });

    await createFromFile(harness);

    expect(toastError).toHaveBeenCalledWith('Upload failed: connection reset');
    expect(callsTo(BUNNY_INIT_URL, 'DELETE')).toHaveLength(1);
  });
});

describe('useVersionActions uploading a file to R2', () => {
  async function createFromFile(harness: Harness) {
    act(() => {
      harness.result.current.actions.setNewVersionMode('file');
      harness.result.current.actions.setNewVersionFile(makeFile());
    });
    await act(async () => {
      await harness.result.current.actions.handleCreateVersion();
    });
  }

  it('registers the version against the proxy URL and object key', async () => {
    const harness = renderVersionActions({
      directUploadsEnabled: true,
      directUploadProvider: 'r2',
    });

    await createFromFile(harness);

    expect(uploadVideoToR2).toHaveBeenCalledWith(PROJECT_ID, expect.any(File), expect.anything());
    expect(bodyOf(callsTo(VERSIONS_URL, 'POST')[0])).toEqual({
      videoUrl: '/api/upload/video/proj1/clip.mp4',
      providerId: 'r2',
      providerVideoId: 'proj1/clip.mp4',
      uploadToken: 'r2-upload-token',
      objectKey: 'proj1/clip.mp4',
      reservationId: 'res1',
      versionLabel: null,
      thumbnailUrl: '/api/upload/image/proj1/clip.jpg',
      duration: 42,
      setActive: true,
    });
    expect(tusUploads).toHaveLength(0);
  });

  it('falls back to the placeholder thumbnail when none was captured', async () => {
    uploadVideoToR2.mockResolvedValue({
      proxyUrl: '/api/upload/video/proj1/clip.mp4',
      objectKey: 'proj1/clip.mp4',
      uploadToken: 'r2-upload-token',
      reservationId: null,
      thumbnailObjectKey: null,
      thumbnailUrl: null,
      duration: null,
    });
    const harness = renderVersionActions({
      directUploadsEnabled: true,
      directUploadProvider: 'r2',
    });

    await createFromFile(harness);

    expect(bodyOf(callsTo(VERSIONS_URL, 'POST')[0])).toMatchObject({
      thumbnailUrl: '/placeholder-video-thumbnail.png',
    });
  });

  // The rollback path for R2: the object is in the bucket before the version
  // row exists, so a rejected POST has to release it and its reservation.
  it('releases the uploaded object when the version cannot be registered', async () => {
    fetchMock.mockResolvedValue(fail(500, { error: 'Database unavailable' }));
    const harness = renderVersionActions({
      directUploadsEnabled: true,
      directUploadProvider: 'r2',
    });

    await createFromFile(harness);

    expect(cleanupPendingR2VideoUpload).toHaveBeenCalledWith(PROJECT_ID, {
      objectKey: 'proj1/clip.mp4',
      uploadToken: 'r2-upload-token',
      reservationId: 'res1',
      thumbnailObjectKey: 'proj1/clip.jpg',
    });
    expect(toastError).toHaveBeenCalledWith('Database unavailable');
    expect(versionIds(harness)).toEqual(['ver1', 'ver2', 'ver3']);
  });

  it('releases nothing when the upload itself never finished', async () => {
    uploadVideoToR2.mockRejectedValue(new Error('Upload aborted'));
    const harness = renderVersionActions({
      directUploadsEnabled: true,
      directUploadProvider: 'r2',
    });

    await createFromFile(harness);

    expect(cleanupPendingR2VideoUpload).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Upload aborted');
  });

  it('surfaces the upload progress the client reports', async () => {
    let report: ((progress: number) => void) | undefined;
    uploadVideoToR2.mockImplementation(
      (_projectId: string, _file: File, options: { onProgress: (p: number) => void }) => {
        report = options.onProgress;
        return new Promise(() => {});
      }
    );
    const harness = renderVersionActions({
      directUploadsEnabled: true,
      directUploadProvider: 'r2',
    });

    act(() => {
      harness.result.current.actions.setNewVersionMode('file');
      harness.result.current.actions.setNewVersionFile(makeFile());
    });
    act(() => {
      void harness.result.current.actions.handleCreateVersion();
    });
    act(() => report?.(37));

    expect(harness.result.current.actions.newVersionUploadProgress).toBe(37);
    expect(harness.result.current.actions.newVersionUploadStatus).toBe('Uploading... 37%');
  });
});

describe('useVersionActions deleting a version', () => {
  async function deleteVersion(harness: Harness, versionId: string) {
    act(() => {
      harness.result.current.actions.setVersionToDelete(versionId);
      harness.result.current.actions.setShowDeleteVersionDialog(true);
    });
    await act(async () => {
      await harness.result.current.actions.handleDeleteVersion();
    });
  }

  it('does nothing when no version was picked', async () => {
    const harness = renderVersionActions();

    await act(async () => {
      await harness.result.current.actions.handleDeleteVersion();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing without a project', async () => {
    const harness = renderVersionActions({ projectId: undefined });

    await deleteVersion(harness, 'ver2');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes through the project-scoped route and drops the version', async () => {
    const harness = renderVersionActions();

    await deleteVersion(harness, 'ver2');

    expect(callsTo(`${VERSIONS_URL}/ver2`, 'DELETE')).toHaveLength(1);
    expect(versionIds(harness)).toEqual(['ver1', 'ver3']);
    expect(harness.result.current.actions.showDeleteVersionDialog).toBe(false);
    expect(toastSuccess).toHaveBeenCalledWith('Version deleted');
    expect(harness.result.current.actions.isDeletingVersion).toBe(false);
  });

  it('leaves the selection alone when a version other than the open one goes', async () => {
    const harness = renderVersionActions();

    await deleteVersion(harness, 'ver2');

    expect(harness.result.current.activeVersionId).toBe('ver1');
  });

  it('moves to the version flagged active when the open one is deleted', async () => {
    const harness = renderVersionActions();

    await deleteVersion(harness, 'ver1');

    expect(versionIds(harness)).toEqual(['ver2', 'ver3']);
    expect(harness.result.current.activeVersionId).toBe('ver3');
  });

  it('falls back to the first remaining version when none is flagged active', async () => {
    const harness = renderVersionActions();

    await deleteVersion(harness, 'ver3');
    await deleteVersion(harness, 'ver1');

    expect(versionIds(harness)).toEqual(['ver2']);
    expect(harness.result.current.activeVersionId).toBe('ver2');
  });

  it('keeps the version when the server refuses to delete it', async () => {
    fetchMock.mockResolvedValue(fail(403, { error: 'Cannot delete the only version' }));
    const harness = renderVersionActions();

    await deleteVersion(harness, 'ver2');

    expect(versionIds(harness)).toEqual(['ver1', 'ver2', 'ver3']);
    expect(harness.result.current.actions.showDeleteVersionDialog).toBe(true);
    expect(toastError).toHaveBeenCalledWith('Cannot delete the only version');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(harness.result.current.actions.isDeletingVersion).toBe(false);
  });

  it('falls back to a generic message when the refusal body says nothing', async () => {
    fetchMock.mockResolvedValue(fail(500, {}));
    const harness = renderVersionActions();

    await deleteVersion(harness, 'ver2');

    expect(toastError).toHaveBeenCalledWith('Failed to delete version');
  });

  it('keeps the version when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderVersionActions();

    await deleteVersion(harness, 'ver2');

    expect(versionIds(harness)).toEqual(['ver1', 'ver2', 'ver3']);
    expect(toastError).toHaveBeenCalledWith('offline');
  });

  // Confirming twice must not remove a second, unrelated version: the second
  // pass runs after versionToDelete has been cleared.
  it('is a no-op the second time the confirm button is pressed', async () => {
    const harness = renderVersionActions();

    await deleteVersion(harness, 'ver2');
    await act(async () => {
      await harness.result.current.actions.handleDeleteVersion();
    });

    expect(callsTo(`${VERSIONS_URL}/ver2`, 'DELETE')).toHaveLength(1);
    expect(versionIds(harness)).toEqual(['ver1', 'ver3']);
  });
});
