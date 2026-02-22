import type { MetadataRoute } from 'next';
import { seoConfig } from '@/lib/seo';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: seoConfig.url,
      lastModified,
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${seoConfig.url}/login`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${seoConfig.url}/register`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
  ];
}
