import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  driveDownloadUrl,
  getDriveFileMetadata,
  isGoogleThumbnailUrl,
  isPlausibleAccessToken,
  isValidDriveFileId,
  titleFromDriveFileName,
  verifyDriveAccessToken,
} from '@/lib/google-drive';

const CLIENT_ID = 'unit-client.apps.googleusercontent.com';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

describe('isValidDriveFileId', () => {
  it('accepts the shape Drive ids have', () => {
    expect(isValidDriveFileId('1AbCdEfGhIjKlMnOpQrStUvWx_-9')).toBe(true);
  });

  // The server builds a googleapis.com url from this value, so anything that
  // could leave the path segment has to be refused.
  it.each([
    ['a path traversal', '../../../etc/passwd'],
    ['a query string', '1AbCdEfGhIjK?alt=media'],
    ['a full url', 'https://evil.example/file'],
    ['an encoded slash', '1AbCdEfGhIjK%2F..'],
    ['something too short to be an id', 'abc'],
    ['a non-string', 12345678901],
  ])('refuses %s', (_label, value) => {
    expect(isValidDriveFileId(value)).toBe(false);
  });
});

describe('driveDownloadUrl', () => {
  it('builds the Drive API media url for a valid id', () => {
    expect(driveDownloadUrl('1AbCdEfGhIjKlMnOpQrStUvWx')).toBe(
      'https://www.googleapis.com/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWx?alt=media&supportsAllDrives=true'
    );
  });

  it('throws rather than build a url from an invalid id', () => {
    expect(() => driveDownloadUrl('../x')).toThrow('Invalid Google Drive file id');
  });
});

describe('isPlausibleAccessToken', () => {
  it('accepts a Google-shaped token', () => {
    expect(isPlausibleAccessToken('ya29.a0AfB_byC-token.value')).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a token carrying a header break', 'ya29.x\r\nX-Injected: 1'],
    ['a token with spaces', 'ya29 x'],
    ['an absurdly long token', 'y'.repeat(4097)],
    ['a non-string', { token: 'ya29' }],
  ])('refuses %s', (_label, value) => {
    expect(isPlausibleAccessToken(value)).toBe(false);
  });
});

describe('isGoogleThumbnailUrl', () => {
  it('accepts a googleusercontent.com thumbnail', () => {
    expect(isGoogleThumbnailUrl('https://lh3.googleusercontent.com/drive-storage/abc=s220')).toBe(
      true
    );
  });

  it.each([
    ['plain http', 'http://lh3.googleusercontent.com/x'],
    ['a look-alike host', 'https://googleusercontent.com.evil.example/x'],
    ['the bare domain with no subdomain', 'https://googleusercontent.com/x'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data'],
    ['not a url at all', 'thumbnail'],
  ])('refuses %s', (_label, value) => {
    expect(isGoogleThumbnailUrl(value)).toBe(false);
  });
});

describe('titleFromDriveFileName', () => {
  it('drops the extension', () => {
    expect(titleFromDriveFileName('Client Cut v3.mp4')).toBe('Client Cut v3');
  });

  it('keeps a name that has no extension', () => {
    expect(titleFromDriveFileName('Final render')).toBe('Final render');
  });

  it('keeps a dotted name whose last part is not an extension', () => {
    expect(titleFromDriveFileName('v1.2 review.draft-version')).toBe('v1.2 review.draft-version');
  });

  it('keeps a version number that looks like an extension', () => {
    expect(titleFromDriveFileName('Client cut v2.1')).toBe('Client cut v2.1');
  });

  it('falls back when the name is nothing but an extension', () => {
    expect(titleFromDriveFileName('.mp4')).toBe('.mp4');
  });

  it('caps the length', () => {
    expect(titleFromDriveFileName(`${'a'.repeat(300)}.mov`)).toHaveLength(200);
  });
});

describe('verifyDriveAccessToken', () => {
  let answer: { status: number; body: unknown };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID);
    vi.stubEnv('GOOGLE_DRIVE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_PICKER_API_KEY', 'picker-key');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT_NUMBER', '1234');
    answer = {
      status: 200,
      body: {
        aud: CLIENT_ID,
        azp: CLIENT_ID,
        scope: `email ${DRIVE_FILE_SCOPE}`,
        expires_in: '3000',
      },
    };
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('accepts a token issued to our client with the drive.file scope', async () => {
    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(true);
  });

  it('sends the token in the request body, not in the url', async () => {
    await verifyDriveAccessToken('ya29.secret-token');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/tokeninfo');
    expect(url).not.toContain('secret-token');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('access_token=ya29.secret-token');
  });

  it('prefers a dedicated Drive client id when one is set', async () => {
    vi.stubEnv('GOOGLE_DRIVE_CLIENT_ID', 'drive-only.apps.googleusercontent.com');

    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(false);

    answer.body = {
      aud: 'drive-only.apps.googleusercontent.com',
      scope: DRIVE_FILE_SCOPE,
      expires_in: '3000',
    };
    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(true);
  });

  it('accepts a token whose authorized party is our client when the audience is not', async () => {
    answer.body = {
      aud: 'other-audience',
      azp: CLIENT_ID,
      scope: DRIVE_FILE_SCOPE,
      expires_in: '3000',
    };
    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(true);
  });

  it('refuses a token issued to another application', async () => {
    answer.body = {
      aud: 'other.apps.googleusercontent.com',
      azp: 'other',
      scope: DRIVE_FILE_SCOPE,
      expires_in: '3000',
    };
    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(false);
  });

  it('refuses a token whose scope list only mentions drive.file as a substring', async () => {
    answer.body = {
      aud: CLIENT_ID,
      scope: `${DRIVE_FILE_SCOPE}.readonly-lookalike`,
      expires_in: '3000',
    };
    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(false);
  });

  it('refuses a token with under five minutes left', async () => {
    answer.body = { aud: CLIENT_ID, scope: DRIVE_FILE_SCOPE, expires_in: '299' };
    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(false);
  });

  it('accepts a token with exactly five minutes left', async () => {
    answer.body = { aud: CLIENT_ID, scope: DRIVE_FILE_SCOPE, expires_in: '300' };
    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(true);
  });

  // The body is one that would pass every other check, so only the status
  // check can refuse it.
  it('refuses a token Google says is invalid', async () => {
    answer = {
      status: 400,
      body: { aud: CLIENT_ID, scope: DRIVE_FILE_SCOPE, expires_in: '3000' },
    };
    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(false);
  });

  it('refuses everything when Drive import is not configured, without calling Google', async () => {
    vi.stubEnv('GOOGLE_PICKER_API_KEY', '');

    await expect(verifyDriveAccessToken('ya29.token')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getDriveFileMetadata', () => {
  const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWx';
  let answer: { status: number; body: unknown };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    answer = {
      status: 200,
      body: {
        id: FILE_ID,
        name: 'Cut.mov',
        mimeType: 'video/quicktime',
        size: '4096',
        thumbnailLink: 'https://lh3.googleusercontent.com/t=s220',
      },
    };
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify(answer.body), { status: answer.status })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a video, sending the token as a bearer header only', async () => {
    const result = await getDriveFileMetadata(FILE_ID, 'ya29.token');

    expect(result).toEqual({
      ok: true,
      file: {
        id: FILE_ID,
        name: 'Cut.mov',
        mimeType: 'video/quicktime',
        sizeBytes: BigInt(4096),
        thumbnailLink: 'https://lh3.googleusercontent.com/t=s220',
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).not.toContain('ya29');
    expect(String(url)).toContain('supportsAllDrives=true');
    expect(init.headers).toEqual({ Authorization: 'Bearer ya29.token' });
  });

  it('drops a thumbnail link that does not point at Google', async () => {
    answer.body = { ...(answer.body as object), thumbnailLink: 'https://evil.example/t.jpg' };

    const result = await getDriveFileMetadata(FILE_ID, 'ya29.token');

    expect(result.ok && result.file.thumbnailLink).toBeNull();
  });

  it.each([
    ['a file in the trash', { trashed: true }, 'trash'],
    ['an answer about some other file', { id: '9ZzZzZzZzZzZzZzZzZzZzZzZz' }, 'unexpected'],
    ['a file with no size', { size: undefined }, 'size'],
    ['a zero-byte file', { size: '0' }, 'size'],
    ['a document', { mimeType: 'application/vnd.google-apps.document' }, 'Only video'],
  ])('refuses %s', async (_label, patch, message) => {
    answer.body = { ...(answer.body as object), ...patch };

    const result = await getDriveFileMetadata(FILE_ID, 'ya29.token');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it.each([403, 404])('explains a %s as a file this app cannot see', async (status) => {
    answer = { status, body: { error: { code: status } } };

    const result = await getDriveFileMetadata(FILE_ID, 'ya29.token');

    expect(!result.ok && result.error).toContain('not shared with this app');
  });

  it('never calls Google for an invalid id', async () => {
    const result = await getDriveFileMetadata('../x', 'ya29.token');

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
