import type { VideoProvider, VideoMetadata, EmbedOptions, ThumbnailSize } from './types';
import { getCachedMetadata, setCachedMetadata } from './metadata-cache';

// Vimeo URL patterns
const VIMEO_PATTERNS = [
  /vimeo\.com\/(\d+)/,
  /vimeo\.com\/video\/(\d+)/,
  /player\.vimeo\.com\/video\/(\d+)/,
  /vimeo\.com\/channels\/\w+\/(\d+)/,
  /vimeo\.com\/groups\/\w+\/videos\/(\d+)/,
];

export const vimeoProvider: VideoProvider = {
  id: 'vimeo',
  name: 'Vimeo',
  icon: 'Video', // Lucide doesn't have Vimeo icon

  canHandle(url: string): boolean {
    return VIMEO_PATTERNS.some(pattern => pattern.test(url));
  },

  extractVideoId(url: string): string | null {
    for (const pattern of VIMEO_PATTERNS) {
      const match = url.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return null;
  },

  getEmbedUrl(videoId: string, options: EmbedOptions = {}): string {
    const params = new URLSearchParams();
    
    if (options.autoplay) params.set('autoplay', '1');
    if (options.startTime) params.set('t', `${Math.floor(options.startTime)}s`);
    if (options.loop) params.set('loop', '1');
    if (options.muted) params.set('muted', '1');
    
    // Better UX options
    params.set('byline', '0');
    params.set('portrait', '0');
    params.set('title', '0');
    
    const queryString = params.toString();
    return `https://player.vimeo.com/video/${videoId}${queryString ? `?${queryString}` : ''}`;
  },

  getThumbnailUrl(videoId: string, size: ThumbnailSize = 'medium'): string {
    // Vimeo requires API call to get thumbnail, return placeholder
    // In production, cache these after fetching metadata
    const sizeMap: Record<ThumbnailSize, number> = {
      small: 200,
      medium: 400,
      large: 640,
      maxres: 1280,
    };
    
    // This is a placeholder - actual thumbnail comes from metadata API
    return `https://vumbnail.com/${videoId}_${sizeMap[size]}.jpg`;
  },

  async getMetadata(videoId: string): Promise<VideoMetadata> {
    const cacheKey = `vimeo:${videoId}`;
    const cached = getCachedMetadata(cacheKey);
    if (cached) return cached;
    try {
      const response = await fetch(
        `https://vimeo.com/api/oembed.json?url=https://vimeo.com/${videoId}`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch video metadata');
      }
      
      const data = await response.json();
      
      const metadata: VideoMetadata = {
        title: data.title,
        description: data.description,
        thumbnailUrl: data.thumbnail_url,
        duration: data.duration,
        author: data.author_name,
        authorUrl: data.author_url,
        uploadDate: data.upload_date ? new Date(data.upload_date) : undefined,
      };

      setCachedMetadata(cacheKey, metadata);
      return metadata;
    } catch (error) {
      const fallback: VideoMetadata = {
        title: 'Vimeo Video',
        thumbnailUrl: this.getThumbnailUrl(videoId, 'large'),
      };
      setCachedMetadata(cacheKey, fallback);
      return fallback;
    }
  },
};
