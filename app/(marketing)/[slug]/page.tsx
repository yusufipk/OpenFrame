import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ComparisonPage } from '@/components/marketing/comparison-page';
import { auth } from '@/lib/auth';
import { comparisonPages, getComparisonPage } from '@/lib/marketing/comparison-pages';
import { buildComparisonJsonLd, buildComparisonMetadata } from '@/lib/marketing/metadata';

interface MarketingSlugPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return comparisonPages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: MarketingSlugPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = getComparisonPage(slug);

  if (!page) {
    return {};
  }

  return buildComparisonMetadata({
    title: page.title,
    description: page.metaDescription,
    path: `/${page.slug}`,
    keywords: page.keywords,
  });
}

export default async function MarketingSlugPage({ params }: MarketingSlugPageProps) {
  const { slug } = await params;
  const page = getComparisonPage(slug);

  if (!page) {
    notFound();
  }

  const session = await auth();
  const structuredData = buildComparisonJsonLd({
    title: page.title,
    description: page.metaDescription,
    path: `/${page.slug}`,
    faq: page.faq,
  });
  const safeStructuredData = JSON.stringify(structuredData).replace(/</g, '\\u003c');

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeStructuredData }} />
      <ComparisonPage page={page} isLoggedIn={Boolean(session?.user)} />
    </>
  );
}
