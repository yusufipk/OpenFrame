import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoAssetProvider } from '@prisma/client';
import {
  buildProjectDownloadManifest,
  canDownloadProjectMedia,
  getProjectDownloadLimits,
  parseRequestedVideoIds,
  validateProjectDownloadManifest,
  type ProjectDownloadManifest,
  type ProjectDownloadManifestFile,
} from '@/lib/project-download';

// `@/lib/project-download` reaches `@/lib/video-assets`, which imports `@/lib/db`
// and opens a pg Pool plus process signal handlers on import. Nothing under test
// here touches a database.
vi.mock('@/lib/db', () => ({ db: {}, default: {}, disconnectDb: vi.fn() }));

// Every limit and the SSRF allowlist come from process.env, so the host
// environment must not be allowed to decide a default.
const MANAGED_ENV = [
  'NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS',
  'OPENFRAME_PROJECT_DOWNLOAD_MAX_FILES',
  'OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES',
];

beforeEach(() => {
  for (const name of MANAGED_ENV) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Hand-written literals, deliberately not imported from the module under test:
// deleting or editing a constant in lib/project-download.ts must break these.
const DEFAULT_MAX_FILES = 250;
const TWENTY_GIB = '21474836480';

type ManifestVideos = Parameters<typeof buildProjectDownloadManifest>[1];
type ManifestVideo = ManifestVideos[number];
type ManifestVersion = ManifestVideo['versions'][number];
type ManifestAsset = ManifestVideo['assets'][number];

function version(overrides: Partial<ManifestVersion> = {}): ManifestVersion {
  return {
    id: 'ver-1',
    versionNumber: 1,
    versionLabel: null,
    providerId: 'bunny',
    videoId: 'bunny-guid-1',
    originalUrl: 'https://video.bunnycdn.example/original.mp4',
    sizeBytes: BigInt(0),
    ...overrides,
  };
}

function asset(overrides: Partial<ManifestAsset> = {}): ManifestAsset {
  return {
    id: 'ast-1',
    provider: VideoAssetProvider.BUNNY,
    displayName: 'B roll',
    sourceUrl: 'https://video.bunnycdn.example/asset.mp4',
    providerVideoId: 'bunny-asset-guid',
    sizeBytes: BigInt(0),
    ...overrides,
  };
}

function video(overrides: Partial<ManifestVideo> = {}): ManifestVideo {
  return {
    id: 'vid-1',
    title: 'Intro',
    position: 0,
    versions: [version()],
    assets: [],
    ...overrides,
  };
}

function namesOf(videos: ManifestVideos, options?: { includeAllVersions?: boolean }): string[] {
  return buildProjectDownloadManifest('Project', videos, options).files.map(
    (file) => file.fileName
  );
}

/**
 * `getSafeDirectDownloadUrl` is module private. The only path that reaches it is
 * a version whose `providerId` is `direct`, so the SSRF allowlist is exercised
 * through the manifest builder and read back off the single emitted file.
 */
function directDownloadUrl(rawUrl: string): string | null {
  const manifest = buildProjectDownloadManifest('Project', [
    video({ versions: [version({ providerId: 'direct', originalUrl: rawUrl })] }),
  ]);
  return manifest.files[0]?.url ?? null;
}

function manifestFiles(count: number): ProjectDownloadManifestFile[] {
  return Array.from({ length: count }, (_unused, index) => ({
    fileName: `clip-${index}.mp4`,
    url: `/api/versions/ver-${index}/download?source=original`,
    sizeBytes: null,
  }));
}

function manifestOf(overrides: Partial<ProjectDownloadManifest> = {}): ProjectDownloadManifest {
  const files = overrides.files ?? manifestFiles(1);
  return {
    projectName: 'Project',
    totalFiles: files.length,
    totalBytes: null,
    ...overrides,
    files,
  };
}

describe('canDownloadProjectMedia', () => {
  // The full truth table. Expected values are written by hand, not derived from
  // the implementation's shape.
  it.each([
    { hasAccess: false, canEdit: false, allowDownloads: false, expected: false },
    { hasAccess: false, canEdit: false, allowDownloads: true, expected: false },
    { hasAccess: false, canEdit: true, allowDownloads: false, expected: false },
    { hasAccess: false, canEdit: true, allowDownloads: true, expected: false },
    { hasAccess: true, canEdit: false, allowDownloads: false, expected: false },
    { hasAccess: true, canEdit: false, allowDownloads: true, expected: true },
    { hasAccess: true, canEdit: true, allowDownloads: false, expected: true },
    { hasAccess: true, canEdit: true, allowDownloads: true, expected: true },
  ])(
    'returns $expected for hasAccess=$hasAccess canEdit=$canEdit allowDownloads=$allowDownloads',
    ({ hasAccess, canEdit, allowDownloads, expected }) => {
      expect(canDownloadProjectMedia({ allowDownloads }, { hasAccess, canEdit })).toBe(expected);
    }
  );

  it('lets an editor download even when the project has downloads switched off', () => {
    expect(
      canDownloadProjectMedia({ allowDownloads: false }, { hasAccess: true, canEdit: true })
    ).toBe(true);
  });

  it('refuses a read-only viewer when the project has downloads switched off', () => {
    expect(
      canDownloadProjectMedia({ allowDownloads: false }, { hasAccess: true, canEdit: false })
    ).toBe(false);
  });

  it('refuses a viewer with no access even when the project allows downloads', () => {
    expect(
      canDownloadProjectMedia({ allowDownloads: true }, { hasAccess: false, canEdit: false })
    ).toBe(false);
  });

  it('checks access before edit rights, so canEdit alone never grants a download', () => {
    expect(
      canDownloadProjectMedia({ allowDownloads: false }, { hasAccess: false, canEdit: true })
    ).toBe(false);
  });
});

describe('getProjectDownloadLimits', () => {
  it('defaults to 250 files and 20 GiB when neither variable is set', () => {
    expect(getProjectDownloadLimits()).toEqual({
      maxFiles: 250,
      maxBytes: BigInt('21474836480'),
    });
  });

  it('reads a valid file limit from the environment', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_FILES', '7');

    expect(getProjectDownloadLimits().maxFiles).toBe(7);
  });

  it('reads a valid byte limit from the environment and returns it as a bigint', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES', '1048576');

    expect(getProjectDownloadLimits().maxBytes).toBe(BigInt(1048576));
  });

  it.each([
    ['zero', '0'],
    ['a negative number', '-5'],
    ['a fractional number', '1.5'],
    ['non-numeric text', 'lots'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['Infinity', 'Infinity'],
    ['a value past MAX_SAFE_INTEGER', '9007199254740992'],
  ])('falls back to 250 files when the file limit is %s', (_label, raw) => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_FILES', raw);

    expect(getProjectDownloadLimits().maxFiles).toBe(250);
  });

  it.each([
    ['zero', '0'],
    ['a negative number', '-1'],
    ['a fractional number', '2.5'],
    ['non-numeric text', 'twenty'],
    ['an empty string', ''],
  ])('falls back to 20 GiB when the byte limit is %s', (_label, raw) => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES', raw);

    expect(getProjectDownloadLimits().maxBytes).toBe(BigInt('21474836480'));
  });

  it('accepts exponent notation because the value goes through Number()', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_FILES', '1e3');

    expect(getProjectDownloadLimits().maxFiles).toBe(1000);
  });

  it('accepts a padded numeric string because Number() trims it', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES', ' 4096 ');

    expect(getProjectDownloadLimits().maxBytes).toBe(BigInt(4096));
  });

  it('keeps the file limit and the byte limit independent', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_FILES', '3');

    expect(getProjectDownloadLimits()).toEqual({
      maxFiles: 3,
      maxBytes: BigInt('21474836480'),
    });
  });
});

describe('validateProjectDownloadManifest', () => {
  it('rejects a manifest with no files', () => {
    expect(validateProjectDownloadManifest(manifestOf({ files: [] }))).toBe(
      'No downloadable files found for this selection'
    );
  });

  it('reports the empty selection before the size cap', () => {
    expect(
      validateProjectDownloadManifest(manifestOf({ files: [], totalBytes: '999999999999999' }))
    ).toBe('No downloadable files found for this selection');
  });

  it('accepts a single file', () => {
    expect(validateProjectDownloadManifest(manifestOf())).toBeNull();
  });

  it('accepts exactly 250 files', () => {
    expect(
      validateProjectDownloadManifest(manifestOf({ files: manifestFiles(DEFAULT_MAX_FILES) }))
    ).toBeNull();
  });

  it('rejects 251 files and names both counts', () => {
    expect(
      validateProjectDownloadManifest(manifestOf({ files: manifestFiles(DEFAULT_MAX_FILES + 1) }))
    ).toBe(
      'This download includes 251 files, which exceeds the limit of 250. Try selecting fewer videos.'
    );
  });

  it('counts the files array rather than trusting the totalFiles field', () => {
    expect(
      validateProjectDownloadManifest(manifestOf({ files: manifestFiles(1), totalFiles: 5000 }))
    ).toBeNull();
  });

  it('rejects on the real file count even when totalFiles understates it', () => {
    expect(
      validateProjectDownloadManifest(manifestOf({ files: manifestFiles(251), totalFiles: 1 }))
    ).toBe(
      'This download includes 251 files, which exceeds the limit of 250. Try selecting fewer videos.'
    );
  });

  it('accepts a total of exactly 20 GiB', () => {
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: TWENTY_GIB }))).toBeNull();
  });

  it('rejects a total one byte over 20 GiB', () => {
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: '21474836481' }))).toBe(
      'This download is too large (over 20 GiB). Try selecting fewer videos.'
    );
  });

  it('accepts a null total size', () => {
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: null }))).toBeNull();
  });

  it('accepts a total of zero expressed as a string', () => {
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: '0' }))).toBeNull();
  });

  it('accepts a total far above the cap when it arrives as an empty string', () => {
    // '' is falsy, so the byte branch is skipped entirely.
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: '' }))).toBeNull();
  });

  it('reports the file count before the size cap when both are exceeded', () => {
    expect(
      validateProjectDownloadManifest(
        manifestOf({ files: manifestFiles(251), totalBytes: '99999999999999' })
      )
    ).toBe(
      'This download includes 251 files, which exceeds the limit of 250. Try selecting fewer videos.'
    );
  });

  it('honours a lowered file limit from the environment', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_FILES', '2');

    expect(validateProjectDownloadManifest(manifestOf({ files: manifestFiles(2) }))).toBeNull();
    expect(validateProjectDownloadManifest(manifestOf({ files: manifestFiles(3) }))).toBe(
      'This download includes 3 files, which exceeds the limit of 2. Try selecting fewer videos.'
    );
  });

  it('honours a lowered byte limit from the environment', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES', '1073741824');

    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: '1073741824' }))).toBeNull();
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: '1073741825' }))).toBe(
      'This download is too large (over 1 GiB). Try selecting fewer videos.'
    );
  });

  it('still applies the 20 GiB default when the configured byte limit is invalid', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES', 'one-gigabyte');

    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: TWENTY_GIB }))).toBeNull();
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: '21474836481' }))).toBe(
      'This download is too large (over 20 GiB). Try selecting fewer videos.'
    );
  });

  // KNOWN GAP in lib/project-download.ts, asserted as-is rather than fixed here:
  // the GiB figure in the message is `maxBytes / 1 GiB` in bigint arithmetic, so
  // it truncates. A 1.5 GiB cap is reported to the user as "over 1 GiB", which
  // understates the limit they are being held to.
  it('truncates a fractional GiB limit in the error message', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES', '1610612736');

    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: '1610612737' }))).toBe(
      'This download is too large (over 1 GiB). Try selecting fewer videos.'
    );
  });

  // The contract is to return a message, never to throw: a SyntaxError out of here
  // reaches the route as a 500 rather than the 400 every other rejection produces.
  it('returns a message rather than throwing when totalBytes is not numeric', () => {
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes: 'lots' }))).toBe(
      'Could not determine the size of this download'
    );
  });

  it.each([
    ['a negative total', '-1'],
    ['a decimal total', '1.5'],
    ['a hex total', '0x10'],
  ])('rejects %s without throwing', (_label, totalBytes) => {
    expect(validateProjectDownloadManifest(manifestOf({ totalBytes }))).toBe(
      'Could not determine the size of this download'
    );
  });
});

describe('parseRequestedVideoIds', () => {
  it('returns null when no parameter was supplied', () => {
    expect(parseRequestedVideoIds(null)).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a lone comma', ','],
    ['commas and spaces only', ' , , '],
  ])('returns an empty array for %s', (_label, raw) => {
    expect(parseRequestedVideoIds(raw)).toEqual([]);
  });

  it('returns a single id', () => {
    expect(parseRequestedVideoIds('vid-1')).toEqual(['vid-1']);
  });

  it('trims whitespace around each id', () => {
    expect(parseRequestedVideoIds('  vid-1 ,\tvid-2  ')).toEqual(['vid-1', 'vid-2']);
  });

  it('drops empty segments between commas', () => {
    expect(parseRequestedVideoIds('vid-1,,vid-2,')).toEqual(['vid-1', 'vid-2']);
  });

  it('de-duplicates repeated ids and keeps first-seen order', () => {
    expect(parseRequestedVideoIds('vid-2,vid-1,vid-2,vid-3,vid-1')).toEqual([
      'vid-2',
      'vid-1',
      'vid-3',
    ]);
  });

  it('does not validate the id shape', () => {
    expect(parseRequestedVideoIds("' OR 1=1 --")).toEqual(["' OR 1=1 --"]);
  });
});

describe('buildProjectDownloadManifest direct download host allowlist', () => {
  it('drops a direct version when no allowlist is configured', () => {
    expect(directDownloadUrl('https://example.com/clip.mp4')).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a lone comma', ','],
    ['whitespace and commas', ' , , '],
  ])('drops a direct version when the allowlist is %s', (_label, raw) => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', raw);

    expect(directDownloadUrl('https://example.com/clip.mp4')).toBeNull();
  });

  it('allows an https URL whose host is on the allowlist', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl('https://example.com/clip.mp4')).toBe('https://example.com/clip.mp4');
  });

  it('allows plain http on an allowlisted host', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl('http://example.com/clip.mp4')).toBe('http://example.com/clip.mp4');
  });

  it('matches an uppercase host against a lowercase allowlist entry', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl('https://EXAMPLE.COM/clip.mp4')).toBe('https://example.com/clip.mp4');
  });

  it('matches a lowercase host against an uppercase allowlist entry', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'EXAMPLE.COM');

    expect(directDownloadUrl('https://example.com/clip.mp4')).toBe('https://example.com/clip.mp4');
  });

  it('trims whitespace around allowlist entries and honours every one of them', () => {
    vi.stubEnv(
      'NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS',
      '  cdn.example.com , Media.Example.Net '
    );

    expect(directDownloadUrl('https://cdn.example.com/clip.mp4')).toBe(
      'https://cdn.example.com/clip.mp4'
    );
    expect(directDownloadUrl('https://media.example.net/clip.mp4')).toBe(
      'https://media.example.net/clip.mp4'
    );
  });

  it.each([
    ['a host that only shares a suffix with an allowlisted one', 'https://evil-example.com/c.mp4'],
    ['a subdomain of an allowlisted host', 'https://cdn.example.com/c.mp4'],
    [
      'an allowlisted host used as a subdomain of an attacker domain',
      'https://example.com.evil.com/c.mp4',
    ],
    ['a longer TLD on the same label', 'https://example.company/c.mp4'],
    ['a trailing dot on an allowlisted host', 'https://example.com./c.mp4'],
    ['an allowlisted host smuggled into userinfo', 'https://example.com@evil.com/c.mp4'],
    [
      'userinfo with an encoded slash before the real host',
      'https://example.com%2f@evil.com/c.mp4',
    ],
    ['a password field carrying the allowlisted host', 'https://user:example.com@evil.com/c.mp4'],
    ['an allowlisted host in the fragment', 'https://evil.com/c.mp4#@example.com'],
    ['an allowlisted host in the query string', 'https://evil.com/c.mp4?next=https://example.com'],
    ['an allowlisted host in the path', 'https://evil.com/example.com/c.mp4'],
    ['a bare hostname with no registrable suffix', 'https://example/c.mp4'],
  ])('rejects %s', (_label, rawUrl) => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl(rawUrl)).toBeNull();
  });

  it('does not treat an allowlist entry as a wildcard for its subdomains', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', '*.example.com');

    expect(directDownloadUrl('https://cdn.example.com/c.mp4')).toBeNull();
    expect(directDownloadUrl('https://example.com/c.mp4')).toBeNull();
  });

  it.each([
    ['ftp', 'ftp://example.com/clip.mp4'],
    ['file', 'file://example.com/clip.mp4'],
    ['ws', 'ws://example.com/clip.mp4'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:video/mp4;base64,AAAA'],
    ['blob', 'blob:https://example.com/0-1-2'],
    ['mailto', 'mailto:someone@example.com'],
  ])('rejects the %s scheme even when the host is allowlisted', (_label, rawUrl) => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl(rawUrl)).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['free text', 'not a url'],
    ['a protocol-relative URL', '//example.com/clip.mp4'],
    ['an app-relative path', '/api/upload/video/clip.mp4'],
    ['a scheme with no host', 'https:///clip.mp4'],
    ['a bracketed host that is not an address', 'http://[not-an-ip]/clip.mp4'],
  ])('rejects %s that the URL parser cannot handle', (_label, rawUrl) => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl(rawUrl)).toBeNull();
  });

  // KNOWN GAP in lib/project-download.ts, asserted as-is rather than fixed here:
  // only the hostname is checked, so once a host is allowlisted every port on it
  // is reachable, and any credentials in the URL survive into the manifest that
  // the browser is told to fetch.
  it('allows an arbitrary port on an allowlisted host', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl('https://example.com:8443/clip.mp4')).toBe(
      'https://example.com:8443/clip.mp4'
    );
    expect(directDownloadUrl('http://example.com:22/clip.mp4')).toBe(
      'http://example.com:22/clip.mp4'
    );
  });

  it('keeps credentials that were embedded in an allowlisted URL', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl('https://user:secret@example.com/clip.mp4')).toBe(
      'https://user:secret@example.com/clip.mp4'
    );
  });

  it('drops the default port when normalising an allowlisted URL', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl('http://example.com:80/clip.mp4')).toBe('http://example.com/clip.mp4');
  });

  it('adds the missing root path when normalising an allowlisted URL', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl('https://example.com')).toBe('https://example.com/');
  });

  it('resolves dot segments out of the path before returning the URL', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(directDownloadUrl('https://example.com/a/b/../../clip.mp4')).toBe(
      'https://example.com/clip.mp4'
    );
  });

  it('allows an allowlisted IPv4 literal', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', '127.0.0.1');

    expect(directDownloadUrl('http://127.0.0.1/clip.mp4')).toBe('http://127.0.0.1/clip.mp4');
  });

  it.each([
    ['decimal', 'http://2130706433/clip.mp4'],
    ['hexadecimal', 'http://0x7f.0.0.1/clip.mp4'],
    ['fullwidth digits', 'http://１２７.0.0.1/clip.mp4'],
  ])('normalises a %s spelling of an allowlisted IPv4 literal onto it', (_label, rawUrl) => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', '127.0.0.1');

    expect(directDownloadUrl(rawUrl)).toBe('http://127.0.0.1/clip.mp4');
  });

  it('rejects a loopback address that is not the allowlisted one', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', '127.0.0.1');

    expect(directDownloadUrl('http://127.0.0.2/clip.mp4')).toBeNull();
    expect(directDownloadUrl('http://169.254.169.254/latest/meta-data')).toBeNull();
  });

  // KNOWN GAP in lib/project-download.ts, asserted as-is rather than fixed here:
  // URL.hostname keeps the brackets around an IPv6 literal, so the unbracketed
  // spelling an operator would naturally write in the allowlist never matches.
  it('does not match an unbracketed IPv6 allowlist entry', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', '::1');

    expect(directDownloadUrl('http://[::1]/clip.mp4')).toBeNull();
  });

  it('matches a bracketed IPv6 allowlist entry', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', '[::1]');

    expect(directDownloadUrl('http://[::1]/clip.mp4')).toBe('http://[::1]/clip.mp4');
  });

  // An internationalised host is punycoded by the URL parser before the check,
  // so the allowlist has to be written in punycode to be usable at all.
  it('rejects a unicode host when the allowlist holds its unicode spelling', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'exämple.com');

    expect(directDownloadUrl('https://exämple.com/clip.mp4')).toBeNull();
  });

  it('accepts both spellings of a host when the allowlist holds its punycode form', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'xn--exmple-cua.com');

    expect(directDownloadUrl('https://exämple.com/clip.mp4')).toBe(
      'https://xn--exmple-cua.com/clip.mp4'
    );
    expect(directDownloadUrl('https://xn--exmple-cua.com/clip.mp4')).toBe(
      'https://xn--exmple-cua.com/clip.mp4'
    );
  });

  it('leaves the manifest empty when the only direct version is rejected', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    const manifest = buildProjectDownloadManifest('Project', [
      video({
        versions: [version({ providerId: 'direct', originalUrl: 'https://evil.com/clip.mp4' })],
      }),
    ]);

    expect(manifest.files).toEqual([]);
    expect(manifest.totalFiles).toBe(0);
  });
});

describe('buildProjectDownloadManifest provider routing', () => {
  it('includes an image review with its original image extension', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({
        title: 'Cover',
        versions: [
          version({
            providerId: 'r2-image',
            originalUrl: '/api/upload/image/aaaaaaaa-1111-2222-3333-444444444444.webp',
            sizeBytes: BigInt(2048),
          }),
        ],
      }),
    ]);

    expect(manifest.files).toEqual([
      {
        fileName: '01-Cover-v1.webp',
        url: '/api/upload/image/aaaaaaaa-1111-2222-3333-444444444444.webp',
        sizeBytes: 2048,
      },
    ]);
  });

  it.each([
    '/api/upload/image/clip.png',
    '/api/upload/image/aaaaaaaa-1111-2222-3333-444444444444.png/../../other',
    '/api/upload/image/aaaaaaaa-1111-2222-3333-444444444444.gif',
  ])('drops an image review with an unsupported path or format: %s', (originalUrl) => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ providerId: 'r2-image', originalUrl })] }),
    ]);
    expect(manifest.files).toEqual([]);
  });

  it('sends a bunny version to the original-source download route', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ id: 'ver-9', providerId: 'bunny', videoId: 'guid-9' })] }),
    ]);

    expect(manifest.files[0]?.url).toBe('/api/versions/ver-9/download?source=original');
  });

  it('drops a bunny version that carries no provider video id', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ providerId: 'bunny', videoId: '' })] }),
    ]);

    expect(manifest.files).toEqual([]);
  });

  it('passes an r2 proxy path through unchanged', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({
        versions: [
          version({
            providerId: 'r2',
            originalUrl: '/api/upload/video/aaaaaaaa-1111-2222-3333-444444444444.mp4',
          }),
        ],
      }),
    ]);

    expect(manifest.files[0]?.url).toBe(
      '/api/upload/video/aaaaaaaa-1111-2222-3333-444444444444.mp4'
    );
  });

  it('drops an r2 version whose url is not an upload proxy path', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ providerId: 'r2', originalUrl: 'https://r2.example/c.mp4' })] }),
    ]);

    expect(manifest.files).toEqual([]);
  });

  it.each([
    ['an unknown provider', 'vimeo'],
    ['youtube', 'youtube'],
    ['an empty provider id', ''],
    ['a differently cased bunny', 'BUNNY'],
    ['a differently cased r2', 'R2'],
    ['a differently cased direct', 'Direct'],
  ])('drops a version from %s', (_label, providerId) => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ providerId, originalUrl: 'https://example.com/c.mp4' })] }),
    ]);

    expect(manifest.files).toEqual([]);
  });

  it('keeps the versions it can resolve and silently drops the rest', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [
        video({
          versions: [
            version({ id: 'ver-1', versionNumber: 1, providerId: 'bunny', videoId: 'guid-1' }),
            version({ id: 'ver-2', versionNumber: 2, providerId: 'vimeo' }),
            version({
              id: 'ver-3',
              versionNumber: 3,
              providerId: 'r2',
              originalUrl: '/api/upload/video/bbbbbbbb-1111-2222-3333-444444444444.mp4',
            }),
          ],
        }),
      ],
      { includeAllVersions: true }
    );

    expect(manifest.files.map((file) => file.url)).toEqual([
      '/api/versions/ver-1/download?source=original',
      '/api/upload/video/bbbbbbbb-1111-2222-3333-444444444444.mp4',
    ]);
  });

  // The r2 branch validates against the strict proxy-path pattern rather than a
  // `startsWith` on the prefix, so dot segments never reach the manifest as a url
  // and never leak a path separator into the file name either.
  it.each([
    ['dot segments after a valid-looking name', '/api/upload/video/clip.mp4/../../../etc/passwd'],
    ['a non-uuid basename', '/api/upload/video/clip.mp4'],
    ['an encoded traversal', '/api/upload/video/..%2F..%2Fetc%2Fpasswd'],
    ['a nested path', '/api/upload/video/nested/dir/file.mp4'],
  ])('drops an r2 version whose stored url has %s', (_label, originalUrl) => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ providerId: 'r2', originalUrl })] }),
    ]);

    expect(manifest.files).toEqual([]);
  });

  it('keeps a well-formed r2 proxy path', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({
        versions: [
          version({
            providerId: 'r2',
            originalUrl: '/api/upload/video/bbbbbbbb-1111-2222-3333-444444444444.mp4',
          }),
        ],
      }),
    ]);

    expect(manifest.files[0]?.url).toBe(
      '/api/upload/video/bbbbbbbb-1111-2222-3333-444444444444.mp4'
    );
    expect(manifest.files[0]?.fileName).toBe('01-Intro-v1.mp4');
  });
});

describe('buildProjectDownloadManifest version selection and ordering', () => {
  it('keeps only the highest numbered version by default', () => {
    expect(
      namesOf([
        video({
          versions: [
            version({ id: 'ver-1', versionNumber: 1, videoId: 'guid-1' }),
            version({ id: 'ver-3', versionNumber: 3, videoId: 'guid-3' }),
            version({ id: 'ver-2', versionNumber: 2, videoId: 'guid-2' }),
          ],
        }),
      ])
    ).toEqual(['01-Intro-v3.mp4']);
  });

  it('picks the highest version number even when it arrives first', () => {
    expect(
      namesOf([
        video({
          versions: [
            version({ id: 'ver-5', versionNumber: 5, videoId: 'guid-5' }),
            version({ id: 'ver-2', versionNumber: 2, videoId: 'guid-2' }),
          ],
        }),
      ])
    ).toEqual(['01-Intro-v5.mp4']);
  });

  it('emits every version in the given order when includeAllVersions is set', () => {
    expect(
      namesOf(
        [
          video({
            versions: [
              version({ id: 'ver-1', versionNumber: 1, videoId: 'guid-1' }),
              version({ id: 'ver-3', versionNumber: 3, videoId: 'guid-3' }),
              version({ id: 'ver-2', versionNumber: 2, videoId: 'guid-2' }),
            ],
          }),
        ],
        { includeAllVersions: true }
      )
    ).toEqual(['01-Intro-v1.mp4', '01-Intro-v3.mp4', '01-Intro-v2.mp4']);
  });

  it('produces nothing for a video with no versions', () => {
    expect(namesOf([video({ versions: [] })])).toEqual([]);
  });

  it('orders videos by position and numbers them from one', () => {
    expect(
      namesOf([
        video({ id: 'vid-b', title: 'Second', position: 5 }),
        video({ id: 'vid-a', title: 'First', position: 1 }),
      ])
    ).toEqual(['01-First-v1.mp4', '02-Second-v1.mp4']);
  });

  it('breaks a position tie on the video id', () => {
    expect(
      namesOf([
        video({ id: 'vid-z', title: 'Zulu', position: 0 }),
        video({ id: 'vid-a', title: 'Alpha', position: 0 }),
      ])
    ).toEqual(['01-Alpha-v1.mp4', '02-Zulu-v1.mp4']);
  });

  it('handles a negative position without reordering the rest', () => {
    expect(
      namesOf([
        video({ id: 'vid-a', title: 'Alpha', position: 0 }),
        video({ id: 'vid-b', title: 'Bravo', position: -1 }),
      ])
    ).toEqual(['01-Bravo-v1.mp4', '02-Alpha-v1.mp4']);
  });

  it('does not reorder the array the caller passed in', () => {
    const videos = [
      video({ id: 'vid-b', title: 'Second', position: 5 }),
      video({ id: 'vid-a', title: 'First', position: 1 }),
    ];

    buildProjectDownloadManifest('Project', videos);

    expect(videos.map((entry) => entry.id)).toEqual(['vid-b', 'vid-a']);
  });

  it('pads the index to two digits and stops padding at ten', () => {
    const videos = Array.from({ length: 10 }, (_unused, index) =>
      video({ id: `vid-${index}`, title: 'Clip', position: index })
    );

    const names = namesOf(videos);

    expect(names[0]).toBe('01-Clip-v1.mp4');
    expect(names[8]).toBe('09-Clip-v1.mp4');
    expect(names[9]).toBe('10-Clip-v1.mp4');
  });

  it('carries the project name through untouched', () => {
    expect(buildProjectDownloadManifest('  Q3 <Launch>  ', []).projectName).toBe('  Q3 <Launch>  ');
  });

  it('returns an empty manifest for no videos', () => {
    expect(buildProjectDownloadManifest('Project', [])).toEqual({
      projectName: 'Project',
      files: [],
      totalFiles: 0,
      totalBytes: null,
    });
  });
});

describe('buildProjectDownloadManifest file naming', () => {
  it('prefers the version label over the version number', () => {
    expect(
      namesOf([video({ versions: [version({ versionNumber: 4, versionLabel: 'final cut' })] })])
    ).toEqual(['01-Intro-final cut.mp4']);
  });

  it('trims a padded version label', () => {
    expect(
      namesOf([video({ versions: [version({ versionNumber: 4, versionLabel: '  final  ' })] })])
    ).toEqual(['01-Intro-final.mp4']);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('falls back to the version number when the label is %s', (_label, versionLabel) => {
    expect(namesOf([video({ versions: [version({ versionNumber: 7, versionLabel })] })])).toEqual([
      '01-Intro-v7.mp4',
    ]);
  });

  it('takes the extension from the original url', () => {
    expect(
      namesOf([video({ versions: [version({ originalUrl: 'https://cdn.example/master.mov' })] })])
    ).toEqual(['01-Intro-v1.mov']);
  });

  it('lowercases the extension', () => {
    expect(
      namesOf([video({ versions: [version({ originalUrl: 'https://cdn.example/master.MP4' })] })])
    ).toEqual(['01-Intro-v1.mp4']);
  });

  it('strips the query string before reading the extension', () => {
    expect(
      namesOf([
        video({
          versions: [version({ originalUrl: 'https://cdn.example/master.webm?token=abc.def' })],
        }),
      ])
    ).toEqual(['01-Intro-v1.webm']);
  });

  // The extension is appended after the sanitiser has run, so it is derived from the
  // last path segment only and has to be a short alphanumeric run. A dot in the host
  // of an extensionless url must not contribute a path separator: a zip writer would
  // turn that into a directory rather than a file.
  it('falls back rather than letting a dot in the host leak a path separator', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(
      namesOf([
        video({
          versions: [
            version({ providerId: 'direct', originalUrl: 'https://example.com/download' }),
          ],
        }),
      ])
    ).toEqual(['01-Intro-v1.mp4']);
  });

  it.each([
    ['a path segment after the extension', 'https://example.com/a.mp4/../../etc/passwd'],
    ['an extension longer than ten characters', 'https://example.com/clip.verylongextension'],
    ['a non-alphanumeric extension', 'https://example.com/clip.mp4%2f..'],
    ['a dotfile with no extension', 'https://example.com/.hidden'],
  ])('falls back to .mp4 for %s', (_label, originalUrl) => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'example.com');

    expect(
      namesOf([video({ versions: [version({ providerId: 'direct', originalUrl })] })])
    ).toEqual(['01-Intro-v1.mp4']);
  });

  it('falls back to .mp4 when the url contains no dot at all', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'localhost');

    expect(
      namesOf([
        video({
          versions: [version({ providerId: 'direct', originalUrl: 'http://localhost/download' })],
        }),
      ])
    ).toEqual(['01-Intro-v1.mp4']);
  });

  it.each([
    ['angle brackets', 'A<b>C', '01-A-b-C-v1.mp4'],
    ['a colon', 'A:C', '01-A-C-v1.mp4'],
    ['a double quote', 'A"C', '01-A-C-v1.mp4'],
    ['a pipe', 'A|C', '01-A-C-v1.mp4'],
    ['a question mark', 'A?C', '01-A-C-v1.mp4'],
    ['an asterisk', 'A*C', '01-A-C-v1.mp4'],
    ['a forward slash', 'A/C', '01-A-C-v1.mp4'],
    ['a backslash', 'A\\C', '01-A-C-v1.mp4'],
  ])('replaces %s in the video title with a dash', (_label, title, expected) => {
    expect(namesOf([video({ title })])).toEqual([expected]);
  });

  it('replaces a null byte in the video title with a dash', () => {
    expect(namesOf([video({ title: 'A\u0000C' })])).toEqual(['01-A-C-v1.mp4']);
  });

  it.each([
    ['a start-of-heading control character', 'A\u0001C'],
    ['an escape control character', 'A\u001bC'],
    ['a unit separator control character', 'A\u001fC'],
  ])('replaces %s in the video title with a dash', (_label, title) => {
    expect(namesOf([video({ title })])).toEqual(['01-A-C-v1.mp4']);
  });

  it('replaces a tab and a newline with dashes rather than collapsing them', () => {
    expect(namesOf([video({ title: 'A\tB\nC' })])).toEqual(['01-A-B-C-v1.mp4']);
  });

  it('neutralises a posix traversal title by replacing the separators', () => {
    // The dot segments survive; only the separators go, which is what keeps the
    // result inside one path component.
    expect(namesOf([video({ title: '../../etc/passwd' })])).toEqual(['01-..-..-etc-passwd-v1.mp4']);
  });

  it('neutralises a windows traversal title by replacing the separators', () => {
    expect(namesOf([video({ title: '..\\..\\Windows\\System32' })])).toEqual([
      '01-..-..-Windows-System32-v1.mp4',
    ]);
  });

  it('collapses runs of whitespace to a single space', () => {
    expect(namesOf([video({ title: 'A     B' })])).toEqual(['01-A B-v1.mp4']);
  });

  it('collapses a non-breaking space and a byte order mark like ordinary whitespace', () => {
    expect(namesOf([video({ title: 'A\u00a0B\ufeffC' })])).toEqual(['01-A B C-v1.mp4']);
  });

  it('trims leading and trailing whitespace from the title', () => {
    expect(namesOf([video({ title: '   Intro   ' })])).toEqual(['01-Intro-v1.mp4']);
  });

  it('falls back to the literal name "file" for a title that sanitises to nothing', () => {
    expect(namesOf([video({ title: '   ' })])).toEqual(['01-file-v1.mp4']);
  });

  it('falls back to "file" for an empty title', () => {
    expect(namesOf([video({ title: '' })])).toEqual(['01-file-v1.mp4']);
  });

  it('preserves unicode letters and emoji in the title', () => {
    expect(namesOf([video({ title: 'Café 日本語 \u{1f3ac}' })])).toEqual([
      '01-Café 日本語 \u{1f3ac}-v1.mp4',
    ]);
  });

  // KNOWN GAP in lib/project-download.ts, asserted as-is rather than fixed here:
  // the sanitiser strips C0 controls but not U+007F or the bidi overrides, so a
  // title can still reverse how the extension renders in a file listing.
  it('keeps a right-to-left override and a delete character in the title', () => {
    expect(namesOf([video({ title: 'clip\u202egpj\u007f' })])).toEqual([
      '01-clip\u202egpj\u007f-v1.mp4',
    ]);
  });

  // KNOWN GAP in lib/project-download.ts, asserted as-is rather than fixed here:
  // reserved Windows device names are not special cased. The numeric prefix means
  // the emitted name is never a bare `CON`, which is the only reason this is not
  // exploitable today.
  it('does not special case a reserved windows device name', () => {
    expect(namesOf([video({ title: 'CON' })])).toEqual(['01-CON-v1.mp4']);
  });

  it('sanitises the version label as well as the title', () => {
    expect(namesOf([video({ versions: [version({ versionLabel: 'a/b:c' })] })])).toEqual([
      '01-Intro-a-b-c.mp4',
    ]);
  });
});

describe('buildProjectDownloadManifest duplicate file names', () => {
  it('suffixes a colliding name before the extension', () => {
    expect(
      namesOf(
        [
          video({
            versions: [
              version({ id: 'ver-1', versionNumber: 1, videoId: 'g1', versionLabel: 'take' }),
              version({ id: 'ver-2', versionNumber: 2, videoId: 'g2', versionLabel: 'take' }),
            ],
          }),
        ],
        { includeAllVersions: true }
      )
    ).toEqual(['01-Intro-take.mp4', '01-Intro-take-2.mp4']);
  });

  it('keeps counting for a third collision', () => {
    expect(
      namesOf(
        [
          video({
            versions: [
              version({ id: 'ver-1', versionNumber: 1, videoId: 'g1', versionLabel: 'take' }),
              version({ id: 'ver-2', versionNumber: 2, videoId: 'g2', versionLabel: 'take' }),
              version({ id: 'ver-3', versionNumber: 3, videoId: 'g3', versionLabel: 'take' }),
            ],
          }),
        ],
        { includeAllVersions: true }
      )
    ).toEqual(['01-Intro-take.mp4', '01-Intro-take-2.mp4', '01-Intro-take-3.mp4']);
  });

  it('skips a counter value that an earlier file already claimed', () => {
    expect(
      namesOf(
        [
          video({
            versions: [
              version({ id: 'ver-1', versionNumber: 1, videoId: 'g1', versionLabel: 'take' }),
              version({ id: 'ver-2', versionNumber: 2, videoId: 'g2', versionLabel: 'take-2' }),
              version({ id: 'ver-3', versionNumber: 3, videoId: 'g3', versionLabel: 'take' }),
            ],
          }),
        ],
        { includeAllVersions: true }
      )
    ).toEqual(['01-Intro-take.mp4', '01-Intro-take-2.mp4', '01-Intro-take-3.mp4']);
  });

  it('does not rename across videos that already differ by index', () => {
    expect(
      namesOf([
        video({ id: 'vid-a', title: 'Intro', position: 0 }),
        video({ id: 'vid-b', title: 'Intro', position: 1 }),
      ])
    ).toEqual(['01-Intro-v1.mp4', '02-Intro-v1.mp4']);
  });
});

describe('buildProjectDownloadManifest assets', () => {
  it('omits assets by default', () => {
    expect(namesOf([video({ assets: [asset()] })])).toEqual(['01-Intro-v1.mp4']);
  });

  it('appends assets after the video when includeAssets is set', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [video({ assets: [asset({ id: 'ast-7' })] })],
      { includeAssets: true }
    );

    expect(manifest.files.map((file) => file.url)).toEqual([
      '/api/versions/ver-1/download?source=original',
      '/api/videos/vid-1/assets/ast-7/download',
    ]);
  });

  it('drops a youtube asset because there is nothing to fetch', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [video({ versions: [], assets: [asset({ provider: VideoAssetProvider.YOUTUBE })] })],
      { includeAssets: true }
    );

    expect(manifest.files).toEqual([]);
  });

  it('drops an asset whose provider is outside the known set', () => {
    // Guards the fail-closed default if a new VideoAssetProvider member is added
    // without extending this file.
    const manifest = buildProjectDownloadManifest(
      'Project',
      [
        video({
          versions: [],
          assets: [asset({ provider: 'VIMEO' as VideoAssetProvider })],
        }),
      ],
      { includeAssets: true }
    );

    expect(manifest.files).toEqual([]);
  });

  it.each([
    ['an image', VideoAssetProvider.R2_IMAGE, '.png'],
    ['audio', VideoAssetProvider.R2_AUDIO, '.webm'],
    ['video', VideoAssetProvider.R2_VIDEO, '.mp4'],
    ['bunny', VideoAssetProvider.BUNNY, '.mp4'],
  ])(
    'falls back to %s extension %s when the source url is not a proxy path',
    (_label, provider, expectedExtension) => {
      const manifest = buildProjectDownloadManifest(
        'Project',
        [
          video({
            versions: [],
            assets: [
              asset({ provider, displayName: 'B roll', sourceUrl: 'https://cdn.example/x' }),
            ],
          }),
        ],
        { includeAssets: true }
      );

      expect(manifest.files[0]?.fileName).toBe(`01-Intro-asset-B roll${expectedExtension}`);
    }
  );

  it.each([
    ['image', VideoAssetProvider.R2_IMAGE, '/api/upload/image/', '.jpeg'],
    ['audio', VideoAssetProvider.R2_AUDIO, '/api/upload/audio/', '.ogg'],
    ['video', VideoAssetProvider.R2_VIDEO, '/api/upload/video/', '.mov'],
  ])(
    'takes the %s extension from a valid proxy source url',
    (_label, provider, prefix, extension) => {
      const manifest = buildProjectDownloadManifest(
        'Project',
        [
          video({
            versions: [],
            assets: [
              asset({
                provider,
                displayName: 'B roll',
                sourceUrl: `${prefix}cccccccc-1111-2222-3333-444444444444${extension}`,
              }),
            ],
          }),
        ],
        { includeAssets: true }
      );

      expect(manifest.files[0]?.fileName).toBe(`01-Intro-asset-B roll${extension}`);
    }
  );

  it('ignores an audio proxy url on an image asset and uses the image fallback', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [
        video({
          versions: [],
          assets: [
            asset({
              provider: VideoAssetProvider.R2_IMAGE,
              displayName: 'B roll',
              sourceUrl: '/api/upload/audio/cccccccc-1111-2222-3333-444444444444.ogg',
            }),
          ],
        }),
      ],
      { includeAssets: true }
    );

    expect(manifest.files[0]?.fileName).toBe('01-Intro-asset-B roll.png');
  });

  // A voice comment's display name is the stored file name, extension included.
  it('does not repeat an extension the display name already carries', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [
        video({
          versions: [],
          assets: [
            asset({
              provider: VideoAssetProvider.R2_AUDIO,
              displayName: '33661b60-b658-47f9-bd40-71c32a0a2fdb.webm',
              sourceUrl: '/api/upload/audio/33661b60-b658-47f9-bd40-71c32a0a2fdb.webm',
            }),
          ],
        }),
      ],
      { includeAssets: true }
    );

    expect(manifest.files[0]?.fileName).toBe(
      '01-Intro-asset-33661b60-b658-47f9-bd40-71c32a0a2fdb.webm'
    );
  });

  it('always names a bunny asset .mp4 regardless of the source url', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [
        video({
          versions: [],
          assets: [
            asset({
              provider: VideoAssetProvider.BUNNY,
              displayName: 'B roll',
              sourceUrl: 'https://cdn.example/clip.mkv',
            }),
          ],
        }),
      ],
      { includeAssets: true }
    );

    expect(manifest.files[0]?.fileName).toBe('01-Intro-asset-B roll.mp4');
  });

  it('strips brackets and parentheses from the asset display name', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [video({ versions: [], assets: [asset({ displayName: 'B-roll [take 2] (final)' })] })],
      { includeAssets: true }
    );

    expect(manifest.files[0]?.fileName).toBe('01-Intro-asset-B-roll take 2 final.mp4');
  });

  it('falls back to the literal name "asset" for a blank display name', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [video({ versions: [], assets: [asset({ displayName: '   ' })] })],
      { includeAssets: true }
    );

    expect(manifest.files[0]?.fileName).toBe('01-Intro-asset-asset.mp4');
  });

  it('replaces a path separator in the asset display name', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [video({ versions: [], assets: [asset({ displayName: '../secret' })] })],
      { includeAssets: true }
    );

    expect(manifest.files[0]?.fileName).toBe('01-Intro-asset-..-secret.mp4');
  });

  it('de-duplicates an asset name against a version name', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [
        video({
          versions: [version({ versionLabel: 'asset-B roll' })],
          assets: [asset({ displayName: 'B roll' })],
        }),
      ],
      { includeAssets: true }
    );

    expect(manifest.files.map((file) => file.fileName)).toEqual([
      '01-Intro-asset-B roll.mp4',
      '01-Intro-asset-B roll-2.mp4',
    ]);
  });
});

describe('buildProjectDownloadManifest sizes', () => {
  it('reports a positive size as a number', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ sizeBytes: BigInt(1234) })] }),
    ]);

    expect(manifest.files[0]?.sizeBytes).toBe(1234);
  });

  it.each([
    ['zero', BigInt(0)],
    ['a negative value', BigInt(-1)],
  ])('reports %s as an unknown size', (_label, sizeBytes) => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ sizeBytes })] }),
    ]);

    expect(manifest.files[0]?.sizeBytes).toBeNull();
  });

  it('clamps a size above MAX_SAFE_INTEGER instead of losing precision silently', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) })] }),
    ]);

    expect(manifest.files[0]?.sizeBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('keeps a size of exactly MAX_SAFE_INTEGER unchanged', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) })] }),
    ]);

    expect(manifest.files[0]?.sizeBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('sums the known sizes into totalBytes as a string', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ id: 'vid-a', position: 0, versions: [version({ sizeBytes: BigInt(100) })] }),
      video({ id: 'vid-b', position: 1, versions: [version({ sizeBytes: BigInt(250) })] }),
    ]);

    expect(manifest.totalBytes).toBe('350');
    expect(manifest.totalFiles).toBe(2);
  });

  it('treats an unknown size as zero when summing', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ id: 'vid-a', position: 0, versions: [version({ sizeBytes: BigInt(100) })] }),
      video({ id: 'vid-b', position: 1, versions: [version({ sizeBytes: BigInt(0) })] }),
    ]);

    expect(manifest.totalBytes).toBe('100');
    expect(manifest.totalFiles).toBe(2);
  });

  it('reports a null total when every size is unknown', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ sizeBytes: BigInt(0) })] }),
    ]);

    expect(manifest.files).toHaveLength(1);
    expect(manifest.totalBytes).toBeNull();
  });

  it('excludes a dropped version from both the count and the total', () => {
    const manifest = buildProjectDownloadManifest(
      'Project',
      [
        video({
          versions: [
            version({ id: 'ver-1', versionNumber: 1, sizeBytes: BigInt(100) }),
            version({ id: 'ver-2', versionNumber: 2, providerId: 'vimeo', sizeBytes: BigInt(900) }),
          ],
        }),
      ],
      { includeAllVersions: true }
    );

    expect(manifest.totalFiles).toBe(1);
    expect(manifest.totalBytes).toBe('100');
  });

  it('produces a manifest the validator accepts end to end', () => {
    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ sizeBytes: BigInt(1024) })] }),
    ]);

    expect(validateProjectDownloadManifest(manifest)).toBeNull();
  });

  it('produces a manifest the validator rejects when the project is too big', () => {
    vi.stubEnv('OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES', '1024');

    const manifest = buildProjectDownloadManifest('Project', [
      video({ versions: [version({ sizeBytes: BigInt(2048) })] }),
    ]);

    expect(validateProjectDownloadManifest(manifest)).toBe(
      'This download is too large (over 0 GiB). Try selecting fewer videos.'
    );
  });
});
