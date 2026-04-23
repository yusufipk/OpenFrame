import type { VideoProvider, VideoMetadata, EmbedOptions } from './types';
import { getCachedMetadata, setCachedMetadata } from './metadata-cache';
import { resolveServerBunnyCdnHostname } from '@/lib/bunny-cdn';

// Bunny Stream URL patterns
// e.g. https://iframe.mediadelivery.net/play/libraryId/videoId
// e.g. https://video.bunnycdn.com/play/libraryId/videoId
const BUNNY_PATTERNS = [
  /(?:iframe\.mediadelivery\.net|video\.bunnycdn\.com)\/(?:play|embed)\/[0-9]+\/([a-zA-Z0-9_-]+)/,
];

export const bunnyProvider: VideoProvider = {
  id: 'bunny',
  name: 'Bunny Stream',
  icon: 'Video',

  canHandle(url: string): boolean {
    return BUNNY_PATTERNS.some((pattern) => pattern.test(url));
  },

  extractVideoId(url: string): string | null {
    for (const pattern of BUNNY_PATTERNS) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  },

  getEmbedUrl(videoId: string, options: EmbedOptions = {}): string {
    // Requires library ID, but our current DB only stores `videoId` for standard providers
    // For Bunny, we typically store the full embed URL as `originalUrl`
    // So if this function is called, we try to extract it from the environment or default
    const libraryId =
      process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID || process.env.BUNNY_STREAM_LIBRARY_ID || '0';

    const params = new URLSearchParams();

    if (options.autoplay) params.set('autoplay', 'true');
    if (options.loop) params.set('loop', 'true');
    if (options.muted) params.set('muted', 'true');

    // We can use video.bunnycdn.com or iframe.mediadelivery.net
    return `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}?${params.toString()}`;
  },

  getThumbnailUrl(videoId: string): string {
    const bunnyCdnHostname = resolveServerBunnyCdnHostname();
    if (!bunnyCdnHostname) return '';
    return `https://${bunnyCdnHostname}/${videoId}/thumbnail.jpg`;
  },

  async getMetadata(videoId: string): Promise<VideoMetadata> {
    const cacheKey = `bunny:${videoId}`;
    const cached = getCachedMetadata(cacheKey);
    if (cached) return cached;

    // We can't fetch title/duration via public API without an API key,
    // so we return basic metadata. When videos are uploaded via our server,
    // the title will be passed during creation.
    const fallback: VideoMetadata = {
      title: 'Bunny Video',
      thumbnailUrl: this.getThumbnailUrl(videoId, 'large'),
    };

    setCachedMetadata(cacheKey, fallback);
    return fallback;
  },
};
