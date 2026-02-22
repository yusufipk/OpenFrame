import type { MetadataRoute } from 'next';
import { seoConfig } from '@/lib/seo';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${seoConfig.name} - ${seoConfig.title}`,
    short_name: seoConfig.name,
    description: seoConfig.description,
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      {
        src: seoConfig.logo,
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
