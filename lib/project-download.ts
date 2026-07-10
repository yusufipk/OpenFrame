import { VideoAssetProvider } from '@prisma/client';
import {
  extractAudioFileNameFromProxyUrl,
  extractImageFileNameFromProxyUrl,
  extractVideoFileNameFromProxyUrl,
  sanitizeAssetDisplayName,
} from '@/lib/video-assets';

const DEFAULT_MAX_FILES = 250;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB

export type ProjectDownloadAccess = {
  hasAccess: boolean;
  canEdit: boolean;
};

export type ProjectDownloadTarget = {
  id: string;
  name: string;
  allowDownloads: boolean;
  workspaceId: string;
  workspaceOwnerId: string;
};

export type ProjectDownloadManifestFile = {
  fileName: string;
  url: string;
  sizeBytes: number | null;
};

export type ProjectDownloadManifest = {
  projectName: string;
  files: ProjectDownloadManifestFile[];
  totalFiles: number;
  totalBytes: string | null;
};

export function getProjectDownloadLimits(): { maxFiles: number; maxBytes: bigint } {
  const maxFilesRaw = Number(process.env.OPENFRAME_PROJECT_DOWNLOAD_MAX_FILES ?? DEFAULT_MAX_FILES);
  const maxFiles =
    Number.isSafeInteger(maxFilesRaw) && maxFilesRaw > 0 ? maxFilesRaw : DEFAULT_MAX_FILES;

  const maxBytesRaw = Number(process.env.OPENFRAME_PROJECT_DOWNLOAD_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  const maxBytes =
    Number.isSafeInteger(maxBytesRaw) && maxBytesRaw > 0
      ? BigInt(maxBytesRaw)
      : BigInt(DEFAULT_MAX_BYTES);

  return { maxFiles, maxBytes };
}

export function canDownloadProjectMedia(
  project: Pick<ProjectDownloadTarget, 'allowDownloads'>,
  access: ProjectDownloadAccess
): boolean {
  if (!access.hasAccess) return false;
  if (access.canEdit) return true;
  return project.allowDownloads;
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 0 ? sanitized : 'file';
}

function getAllowedDirectHosts(): string[] {
  return (process.env.NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function getSafeDirectDownloadUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const allowedHosts = getAllowedDirectHosts();
    if (allowedHosts.length === 0) return null;
    if (!allowedHosts.includes(parsed.hostname.toLowerCase())) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function extensionFromUrl(url: string, fallback: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  const ext = withoutQuery.includes('.') ? withoutQuery.slice(withoutQuery.lastIndexOf('.')) : '';
  return ext || fallback;
}

type VersionRow = {
  id: string;
  versionNumber: number;
  versionLabel: string | null;
  providerId: string;
  videoId: string;
  originalUrl: string;
  sizeBytes: bigint;
};

type AssetRow = {
  id: string;
  provider: VideoAssetProvider;
  displayName: string;
  sourceUrl: string;
  providerVideoId: string | null;
  sizeBytes: bigint;
};

type VideoRow = {
  id: string;
  title: string;
  position: number;
  versions: VersionRow[];
  assets: AssetRow[];
};

function selectLatestVersion(versions: VersionRow[]): VersionRow[] {
  if (versions.length === 0) return [];
  let latest = versions[0]!;
  for (const version of versions) {
    if (version.versionNumber > latest.versionNumber) latest = version;
  }
  return [latest];
}

function makeUniqueName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  const dotIndex = baseName.lastIndexOf('.');
  const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const ext = dotIndex > 0 ? baseName.slice(dotIndex) : '';

  let counter = 2;
  while (usedNames.has(`${stem}-${counter}${ext}`)) {
    counter += 1;
  }
  const unique = `${stem}-${counter}${ext}`;
  usedNames.add(unique);
  return unique;
}

function buildVersionFileName(videoIndex: number, videoTitle: string, version: VersionRow): string {
  const label = version.versionLabel?.trim() || `v${version.versionNumber}`;
  const stem = sanitizeFileName(`${String(videoIndex).padStart(2, '0')}-${videoTitle}-${label}`);
  const ext = extensionFromUrl(version.originalUrl, '.mp4');
  return `${stem}${ext}`;
}

function buildAssetFileName(videoIndex: number, videoTitle: string, asset: AssetRow): string {
  const displayName = sanitizeAssetDisplayName(asset.displayName, 'asset');
  const stem = sanitizeFileName(
    `${String(videoIndex).padStart(2, '0')}-${videoTitle}-asset-${displayName}`
  );

  if (asset.provider === VideoAssetProvider.R2_IMAGE) {
    const fileName = extractImageFileNameFromProxyUrl(asset.sourceUrl);
    const ext = fileName?.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.png';
    return `${stem}${ext}`;
  }
  if (asset.provider === VideoAssetProvider.R2_AUDIO) {
    const fileName = extractAudioFileNameFromProxyUrl(asset.sourceUrl);
    const ext = fileName?.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.webm';
    return `${stem}${ext}`;
  }
  if (asset.provider === VideoAssetProvider.R2_VIDEO) {
    const fileName = extractVideoFileNameFromProxyUrl(asset.sourceUrl);
    const ext = fileName?.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.mp4';
    return `${stem}${ext}`;
  }
  if (asset.provider === VideoAssetProvider.BUNNY) {
    return `${stem}.mp4`;
  }

  return `${stem}.bin`;
}

function versionDownloadUrl(version: VersionRow): string | null {
  if (version.providerId === 'bunny' && version.videoId) {
    // Always fetch the original (uncompressed) file for bulk/project downloads so
    // quality never drops. 'auto' could silently fall back to a compressed MP4.
    return `/api/versions/${version.id}/download?source=original`;
  }
  if (version.providerId === 'r2') {
    if (version.originalUrl.startsWith('/api/upload/video/')) {
      return version.originalUrl;
    }
    const fileName = extractVideoFileNameFromProxyUrl(version.originalUrl);
    if (fileName) return `/api/upload/video/${fileName}`;
  }
  if (version.providerId === 'direct') {
    return getSafeDirectDownloadUrl(version.originalUrl);
  }
  return null;
}

function assetDownloadUrl(videoId: string, asset: AssetRow): string | null {
  if (asset.provider === VideoAssetProvider.YOUTUBE) return null;
  if (
    asset.provider === VideoAssetProvider.R2_IMAGE ||
    asset.provider === VideoAssetProvider.R2_AUDIO ||
    asset.provider === VideoAssetProvider.R2_VIDEO ||
    asset.provider === VideoAssetProvider.BUNNY
  ) {
    return `/api/videos/${videoId}/assets/${asset.id}/download`;
  }
  return null;
}

function bigintToSafeNumber(value: bigint): number | null {
  if (value <= BigInt(0)) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
}

export type BuildProjectDownloadManifestOptions = {
  /** Include every version of each video. Defaults to latest version only. */
  includeAllVersions?: boolean;
};

export function buildProjectDownloadManifest(
  projectName: string,
  videos: VideoRow[],
  options: BuildProjectDownloadManifestOptions = {}
): ProjectDownloadManifest {
  const { includeAllVersions = false } = options;
  const files: ProjectDownloadManifestFile[] = [];
  const usedNames = new Set<string>();

  const sortedVideos = [...videos].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id)
  );

  sortedVideos.forEach((video, index) => {
    const videoIndex = index + 1;
    const videoTitle = sanitizeFileName(video.title) || `video-${videoIndex}`;

    const versionsToInclude = includeAllVersions
      ? video.versions
      : selectLatestVersion(video.versions);

    for (const version of versionsToInclude) {
      const url = versionDownloadUrl(version);
      if (!url) continue;

      files.push({
        fileName: makeUniqueName(buildVersionFileName(videoIndex, videoTitle, version), usedNames),
        url,
        sizeBytes: bigintToSafeNumber(version.sizeBytes),
      });
    }

    for (const asset of video.assets) {
      const url = assetDownloadUrl(video.id, asset);
      if (!url) continue;

      files.push({
        fileName: makeUniqueName(buildAssetFileName(videoIndex, videoTitle, asset), usedNames),
        url,
        sizeBytes: bigintToSafeNumber(asset.sizeBytes),
      });
    }
  });

  const knownTotal = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);

  return {
    projectName,
    files,
    totalFiles: files.length,
    totalBytes: knownTotal > 0 ? String(knownTotal) : null,
  };
}

export function validateProjectDownloadManifest(manifest: ProjectDownloadManifest): string | null {
  if (manifest.files.length === 0) {
    return 'No downloadable files found for this selection';
  }

  const { maxFiles, maxBytes } = getProjectDownloadLimits();
  if (manifest.files.length > maxFiles) {
    return `This download includes ${manifest.files.length} files, which exceeds the limit of ${maxFiles}. Try selecting fewer videos.`;
  }

  if (manifest.totalBytes) {
    const knownTotal = BigInt(manifest.totalBytes);
    if (knownTotal > maxBytes) {
      const maxGiB = Number(maxBytes / BigInt(1024 * 1024 * 1024));
      return `This download is too large (over ${maxGiB} GiB). Try selecting fewer videos.`;
    }
  }

  return null;
}

export function parseRequestedVideoIds(raw: string | null): string[] | null {
  if (raw === null) return null;
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return [];
  return [...new Set(ids)];
}
