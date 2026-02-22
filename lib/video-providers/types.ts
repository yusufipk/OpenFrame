// Video Provider Types - Future-proof abstraction for multiple video sources

export interface VideoMetadata {
  title: string;
  description?: string;
  thumbnailUrl: string;
  duration?: number; // in seconds
  author?: string;
  authorUrl?: string;
  uploadDate?: Date;
}

export interface VideoProvider {
  id: string;
  name: string;
  icon: string; // Lucide icon name

  // URL handling
  canHandle(url: string): boolean;
  extractVideoId(url: string): string | null;

  // Embed and display
  getEmbedUrl(videoId: string, options?: EmbedOptions): string;
  getThumbnailUrl(videoId: string, size?: ThumbnailSize): string;

  // Metadata fetching
  getMetadata(videoId: string): Promise<VideoMetadata>;
}

export interface EmbedOptions {
  autoplay?: boolean;
  startTime?: number; // in seconds
  controls?: boolean;
  loop?: boolean;
  muted?: boolean;
}

export type ThumbnailSize = 'small' | 'medium' | 'large' | 'maxres';

// Supported provider types - extend as we add more
export type VideoProviderType = 'youtube' | 'direct' | 'bunny';

// Video source stored in database
export interface VideoSource {
  providerId: VideoProviderType;
  videoId: string;
  originalUrl: string;
  metadata?: VideoMetadata;
}
