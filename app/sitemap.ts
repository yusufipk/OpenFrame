import type { MetadataRoute } from 'next';
import { comparisonPages } from '@/lib/marketing/comparison-pages';
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
    ...comparisonPages.map((page) => ({
      url: `${seoConfig.url}/${page.slug}`,
      lastModified,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    })),
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
    {
      url: `${seoConfig.url}/terms`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${seoConfig.url}/privacy`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${seoConfig.url}/refund`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ];
}
