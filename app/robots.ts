import type { MetadataRoute } from 'next';
import { seoConfig } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/admin', '/dashboard', '/projects', '/settings', '/workspaces'],
      },
    ],
    sitemap: `${seoConfig.url}/sitemap.xml`,
    host: seoConfig.url,
  };
}
