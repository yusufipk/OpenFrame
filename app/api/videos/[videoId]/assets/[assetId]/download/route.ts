import { NextRequest } from 'next/server';
import { VideoAssetProvider } from '@prisma/client';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { proxyR2MediaObject } from '@/lib/r2-media-proxy';
import { fetchWithTimeout, resolveBunnyDownloadSource } from '@/lib/bunny-download';
import { db } from '@/lib/db';
import {
  extractImageFileNameFromProxyUrl,
  extractAudioFileNameFromProxyUrl,
  getVideoAssetAccessContext,
} from '@/lib/video-assets';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ videoId: string; assetId: string }> };
type BunnySourcePreference = 'auto' | 'original' | 'compressed';

const IMAGE_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

const AUDIO_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};
const BUNNY_ALLOWED_QUALITIES = new Set([2160, 1440, 1080, 720, 480, 360, 240]);

function sanitizeFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 0 ? sanitized : 'asset';
}

function toAsciiFileName(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : 'asset';
}

function buildContentDisposition(fileNameWithExt: string): string {
  const asciiFallback = toAsciiFileName(fileNameWithExt).replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileNameWithExt);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function imageContentTypeFromFileName(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return IMAGE_CONTENT_TYPE_BY_EXTENSION[ext] || 'application/octet-stream';
}

// GET /api/videos/[videoId]/assets/[assetId]/download
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'asset-download');
    if (limited) return limited;

    const { videoId, assetId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.hasViewAccess) return apiErrors.forbidden('Access denied');
    if (!context.viewerUserId || !context.canDownloadAssets) {
      return apiErrors.forbidden('Asset downloads require an authenticated account');
    }

    const asset = await db.videoAsset.findFirst({
      where: { id: assetId, videoId },
      select: {
        id: true,
        provider: true,
        displayName: true,
        sourceUrl: true,
        providerVideoId: true,
      },
    });
    if (!asset) return apiErrors.notFound('Asset');
    if (asset.provider === VideoAssetProvider.YOUTUBE) {
      return apiErrors.badRequest('YouTube assets cannot be downloaded');
    }

    if (asset.provider === VideoAssetProvider.R2_IMAGE) {
      const fileName = extractImageFileNameFromProxyUrl(asset.sourceUrl);
      if (!fileName) return apiErrors.badRequest('Invalid image asset URL');
      const key = `images/${fileName}`;
      const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.png';
      const downloadName = `${sanitizeFileName(asset.displayName)}${extension}`;
      const contentDisposition = buildContentDisposition(downloadName);

      return proxyR2MediaObject({
        request,
        key,
        fallbackContentType: imageContentTypeFromFileName(fileName),
        cacheControl: 'private, no-store',
        extraHeaders: {
          'Content-Disposition': contentDisposition,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
        internalErrorMessage: 'Failed to retrieve image',
      });
    }

    if (asset.provider === VideoAssetProvider.R2_AUDIO) {
      const fileName = extractAudioFileNameFromProxyUrl(asset.sourceUrl);
      if (!fileName) return apiErrors.badRequest('Invalid audio asset URL');
      const key = `voice/${fileName}`;
      const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.webm';
      const downloadName = `${sanitizeFileName(asset.displayName)}${ext}`;
      const contentDisposition = buildContentDisposition(downloadName);
      const extKey = ext.replace('.', '');
      const contentType = AUDIO_CONTENT_TYPE_BY_EXTENSION[extKey] || 'audio/webm';

      return proxyR2MediaObject({
        request,
        key,
        fallbackContentType: contentType,
        cacheControl: 'private, no-store',
        extraHeaders: {
          'Content-Disposition': contentDisposition,
          'X-Content-Type-Options': 'nosniff',
        },
        internalErrorMessage: 'Failed to retrieve audio',
      });
    }

    const sourceParam = request.nextUrl.searchParams.get('source');
    const rawQuality = request.nextUrl.searchParams.get('quality');
    const isPrepareOnly = request.nextUrl.searchParams.get('prepare') === '1';
    const requestedQuality = Number(rawQuality);
    const sourcePreference: BunnySourcePreference =
      sourceParam === null
        ? 'auto'
        : sourceParam === 'original' || sourceParam === 'compressed'
          ? sourceParam
          : 'auto';

    if (sourceParam !== null && sourceParam !== 'original' && sourceParam !== 'compressed') {
      return apiErrors.badRequest('Invalid source. Allowed values: original, compressed');
    }
    if (
      rawQuality !== null
      && (!Number.isFinite(requestedQuality) || !BUNNY_ALLOWED_QUALITIES.has(requestedQuality))
    ) {
      return apiErrors.badRequest('Invalid quality. Allowed values: 2160, 1440, 1080, 720, 480, 360, 240');
    }
    if (rawQuality !== null && sourcePreference === 'original') {
      return apiErrors.badRequest('Quality cannot be used when source=original');
    }

    if (!asset.providerVideoId) {
      return apiErrors.badRequest('Missing Bunny asset video id');
    }

    const source = await resolveBunnyDownloadSource(
      asset.providerVideoId,
      Number.isFinite(requestedQuality) ? requestedQuality : null,
      sourcePreference
    );
    if (!source) {
      if (sourcePreference === 'original') {
        return apiErrors.notFound('Original file');
      }
      return apiErrors.notFound('Download file');
    }

    if (isPrepareOnly) {
      const response = successResponse({
        quality: source.quality,
        sourceType: source.sourceType,
      });
      return withCacheControl(response, 'private, no-store');
    }

    const upstream = await fetchWithTimeout(source.url, { cache: 'no-store' });
    if (!upstream.ok || !upstream.body) {
      return apiErrors.notFound('Download file');
    }

    const extension = source.sourceType === 'compressed' ? '.mp4' : '';
    const filename = `${sanitizeFileName(asset.displayName)}${extension}`;
    const response = new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Content-Disposition': buildContentDisposition(filename),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) response.headers.set('Content-Length', contentLength);

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error downloading asset:', error);
    return apiErrors.internalError('Failed to download asset');
  }
}
