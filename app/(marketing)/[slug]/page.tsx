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
  return (
    <>
      {/* One script per object: single-object payloads with a top-level
          @context survive naive JSON-LD consumers that choke on arrays. */}
      {structuredData.map((data, index) => (
        <script
          key={`${String(data['@type'])}-${index}`}
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(data).replace(/</g, '\\u003c'),
          }}
        />
      ))}
      <ComparisonPage page={page} isLoggedIn={Boolean(session?.user)} />
    </>
  );
}
