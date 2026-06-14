import type { Metadata } from 'next';
import { seoConfig } from '@/lib/seo';

export function buildComparisonMetadata({
  title,
  description,
  path,
  keywords = [],
}: {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
}): Metadata {
  const canonicalPath = path.startsWith('/') ? path : `/${path}`;
  const pageTitle = title;
  const ogTitle = `${pageTitle} | ${seoConfig.name}`;

  return {
    title: pageTitle,
    description,
    keywords: [...seoConfig.keywords, ...keywords],
    alternates: {
      canonical: canonicalPath,
    },
    openGraph: {
      title: ogTitle,
      description,
      url: `${seoConfig.url}${canonicalPath}`,
      images: [
        {
          url: seoConfig.ogImage,
          width: 1888,
          height: 1048,
          alt: `${pageTitle} | ${seoConfig.name}`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description,
      images: [seoConfig.ogImage],
    },
  };
}

export function buildComparisonJsonLd({
  title,
  description,
  path,
  faq,
}: {
  title: string;
  description: string;
  path: string;
  faq: Array<{ question: string; answer: string }>;
}) {
  const url = `${seoConfig.url}${path.startsWith('/') ? path : `/${path}`}`;

  const structuredData: Array<Record<string, unknown>> = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: title,
      description,
      url,
      isPartOf: {
        '@type': 'WebSite',
        name: seoConfig.name,
        url: seoConfig.url,
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: seoConfig.name,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Web',
      offers: {
        '@type': 'Offer',
        price: '10',
        priceCurrency: 'USD',
        description: '7-day free trial, then $10/month hosted plan. Self-hosted option is free.',
      },
      url: seoConfig.url,
    },
  ];

  if (faq.length > 0) {
    structuredData.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.answer,
        },
      })),
    });
  }

  return structuredData;
}
