import type { VideoProvider, VideoMetadata, EmbedOptions, ThumbnailSize } from './types';
import { getCachedMetadata, setCachedMetadata } from './metadata-cache';

// YouTube URL patterns
const YOUTUBE_PATTERNS = [
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
];

export const youtubeProvider: VideoProvider = {
  id: 'youtube',
  name: 'YouTube',
  icon: 'Youtube',

  canHandle(url: string): boolean {
    return YOUTUBE_PATTERNS.some(pattern => pattern.test(url));
  },

  extractVideoId(url: string): string | null {
    for (const pattern of YOUTUBE_PATTERNS) {
      const match = url.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return null;
  },

  getEmbedUrl(videoId: string, options: EmbedOptions = {}): string {
    const params = new URLSearchParams();
    
    // Enable JS API for programmatic control
    params.set('enablejsapi', '1');
    params.set('origin', typeof window !== 'undefined' ? window.location.origin : '');
    
    if (options.autoplay) params.set('autoplay', '1');
    if (options.startTime) params.set('start', String(Math.floor(options.startTime)));
    if (options.controls === false) params.set('controls', '0');
    if (options.loop) params.set('loop', '1');
    if (options.muted) params.set('mute', '1');
    
    // Better UX options
    params.set('rel', '0'); // Don't show related videos from other channels
    params.set('modestbranding', '1'); // Minimal YouTube branding
    
    return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
  },

  getThumbnailUrl(videoId: string, size: ThumbnailSize = 'medium'): string {
    const sizeMap: Record<ThumbnailSize, string> = {
      small: 'default', // 120x90
      medium: 'mqdefault', // 320x180
      large: 'hqdefault', // 480x360
      maxres: 'maxresdefault', // 1280x720
    };
    
    return `https://img.youtube.com/vi/${videoId}/${sizeMap[size]}.jpg`;
  },

  async getMetadata(videoId: string): Promise<VideoMetadata> {
    const cacheKey = `youtube:${videoId}`;
    const cached = getCachedMetadata(cacheKey);
    if (cached) return cached;
    // Using oEmbed API - no API key required
    // For production, you might want to use YouTube Data API for more data
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error('Failed to fetch video metadata');
      }
      
      const data = await response.json();
      
      const metadata: VideoMetadata = {
        title: data.title,
        thumbnailUrl: data.thumbnail_url,
        author: data.author_name,
        authorUrl: data.author_url,
      };

      setCachedMetadata(cacheKey, metadata);
      return metadata;
    } catch (error) {
      // Fallback with minimal data
      const fallback: VideoMetadata = {
        title: 'YouTube Video',
        thumbnailUrl: this.getThumbnailUrl(videoId, 'large'),
      };
      setCachedMetadata(cacheKey, fallback);
      return fallback;
    }
  },
};
