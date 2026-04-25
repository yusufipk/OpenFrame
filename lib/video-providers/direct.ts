import type { VideoProvider, VideoMetadata, EmbedOptions } from './types';

// Direct video URL patterns (for future self-hosted videos)
const DIRECT_VIDEO_PATTERNS = [/\.(mp4|webm|ogg|mov)(\?.*)?$/i];

// Security: Validate URL protocol to prevent XSS
function isValidVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http and https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return DIRECT_VIDEO_PATTERNS.some((pattern) => pattern.test(url));
  } catch {
    return false;
  }
}

export const directProvider: VideoProvider = {
  id: 'direct',
  name: 'Direct Upload',
  icon: 'Upload',

  canHandle(url: string): boolean {
    // Check for common video extensions and valid protocol
    return isValidVideoUrl(url);
  },

  extractVideoId(url: string): string | null {
    // For direct uploads, the "videoId" is the full URL
    // Security: Validate URL before returning
    if (this.canHandle(url)) {
      return url;
    }
    return null;
  },

  getEmbedUrl(videoId: string, options: EmbedOptions = {}): string {
    // For direct videos, we'll use HTML5 video player
    // The videoId IS the URL for direct uploads
    const params = new URLSearchParams();

    if (options.startTime) params.set('t', String(Math.floor(options.startTime)));

    const queryString = params.toString();
    return `${videoId}${queryString ? `#t=${options.startTime}` : ''}`;
  },

  getThumbnailUrl(videoId: string): string {
    void videoId;
    // For direct uploads, thumbnail would be generated server-side
    // Return a placeholder for now
    return '/placeholder-video-thumbnail.png';
  },

  async getMetadata(videoId: string): Promise<VideoMetadata> {
    // For direct uploads, metadata would be stored in our database
    // This is a placeholder implementation
    const filename = videoId.split('/').pop() || 'Video';
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');

    return {
      title: nameWithoutExt,
      thumbnailUrl: this.getThumbnailUrl(videoId),
    };
  },
};
