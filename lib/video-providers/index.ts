// Video Provider Registry - Central place to manage all video providers

import { youtubeProvider } from './youtube';
import { directProvider } from './direct';
import { bunnyProvider } from './bunny';
import type { VideoProvider, VideoSource, VideoMetadata, VideoProviderType } from './types';
import { logError } from '@/lib/logger';

// Export types
export * from './types';

// Registry of all available providers
const providers: VideoProvider[] = [
  youtubeProvider,
  directProvider,
  bunnyProvider,
];

// Provider lookup map for quick access
const providerMap = new Map<string, VideoProvider>(
  providers.map(p => [p.id, p])
);

/**
 * Detect which provider can handle a given URL
 */
export function detectProvider(url: string): VideoProvider | null {
  for (const provider of providers) {
    if (provider.canHandle(url)) {
      return provider;
    }
  }
  return null;
}

/**
 * Get a provider by its ID
 */
export function getProvider(providerId: VideoProviderType): VideoProvider | null {
  return providerMap.get(providerId) ?? null;
}

/**
 * Get all available providers
 */
export function getAllProviders(): VideoProvider[] {
  return [...providers];
}

/**
 * Parse a video URL and return a VideoSource object
 */
export function parseVideoUrl(url: string): VideoSource | null {
  const provider = detectProvider(url);

  if (!provider) {
    return null;
  }

  const videoId = provider.extractVideoId(url);

  if (!videoId) {
    return null;
  }

  return {
    providerId: provider.id as VideoProviderType,
    videoId,
    originalUrl: url,
  };
}

/**
 * Fetch metadata for a video source
 */
export async function fetchVideoMetadata(source: VideoSource): Promise<VideoMetadata | null> {
  const provider = getProvider(source.providerId);

  if (!provider) {
    return null;
  }

  try {
    return await provider.getMetadata(source.videoId);
  } catch (error) {
    logError('Failed to fetch video metadata:', error);
    return null;
  }
}

/**
 * Get embed URL for a video source
 */
export function getEmbedUrl(source: VideoSource, options?: Parameters<VideoProvider['getEmbedUrl']>[1]): string | null {
  const provider = getProvider(source.providerId);

  if (!provider) {
    return null;
  }

  return provider.getEmbedUrl(source.videoId, options);
}

/**
 * Get thumbnail URL for a video source
 */
export function getThumbnailUrl(source: VideoSource, size?: Parameters<VideoProvider['getThumbnailUrl']>[1]): string | null {
  const provider = getProvider(source.providerId);

  if (!provider) {
    return null;
  }

  return provider.getThumbnailUrl(source.videoId, size);
}

/**
 * Check if a URL is a valid video URL from any supported provider
 */
export function isValidVideoUrl(url: string): boolean {
  return detectProvider(url) !== null;
}

/**
 * Get the provider icon name for UI display
 */
export function getProviderIcon(providerId: VideoProviderType): string {
  const provider = getProvider(providerId);
  return provider?.icon ?? 'Video';
}
