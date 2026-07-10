'use client';

import { downloadNamedFile, navigateDownload } from '@/lib/client/download-file';

const DOWNLOAD_STAGGER_MS = 500;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function triggerBrowserDownload(file: ProjectDownloadManifestFile): Promise<void> {
  // Same-origin proxy files (R2 / S3 / MinIO via /api/upload/video/...): the
  // download attribute applies and the browser streams straight to disk, so the
  // name is correct at any size with no memory cost.
  if (file.url.startsWith('/api/upload/video/')) {
    navigateDownload(file.url, file.fileName);
    return;
  }

  // Bunny (CDN redirect) and external direct hosts are cross-origin, so the name
  // only applies if we fetch the bytes. downloadNamedFile does that for files up
  // to 10 GB; larger ones fall back to a plain navigation (CDN filename).
  const saved = await downloadNamedFile(file.url, file.fileName);
  if (!saved) {
    navigateDownload(file.url, file.fileName);
  }
}

export async function runProjectDownloadManifest(manifest: ProjectDownloadManifest): Promise<void> {
  for (let index = 0; index < manifest.files.length; index += 1) {
    // Sequential so at most one file is buffered in memory at a time.
    await triggerBrowserDownload(manifest.files[index]!);
    if (index < manifest.files.length - 1) {
      await sleep(DOWNLOAD_STAGGER_MS);
    }
  }
}
