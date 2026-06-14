import Link from 'next/link';
import { ArrowRight, Github, MoveRight } from 'lucide-react';
import { FeatureComparisonTable } from '@/components/marketing/feature-comparison-table';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { MarketingHeader } from '@/components/marketing/marketing-header';
import { PricingComparison } from '@/components/marketing/pricing-comparison';
import { ProductVisual } from '@/components/marketing/product-visual';
import type { ComparisonPageDefinition } from '@/lib/marketing/comparison-types';
import { getCompetitorName, comparisonPageMap } from '@/lib/marketing/comparison-pages';
import { seoConfig } from '@/lib/seo';

interface ComparisonPageProps {
  page: ComparisonPageDefinition;
  isLoggedIn: boolean;
}

export function ComparisonPage({ page, isLoggedIn }: ComparisonPageProps) {
  const hostedCtaHref = isLoggedIn ? '/dashboard' : '/register';
  const competitorName = getCompetitorName(page) ?? 'Alternatives';
  const relatedSlugs = page.relatedSlugs.filter((slug) => slug in comparisonPageMap);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <MarketingHeader isLoggedIn={isLoggedIn} />

      <main>
        <section className="border-b border-border px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
          <div className="mx-auto grid w-full max-w-[1200px] gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
                {page.eyebrow}
              </p>
              <h1 className="mt-4 text-4xl font-semibold tracking-[-0.03em] md:text-6xl">
                {page.headline}
              </h1>
              <p className="mt-6 max-w-2xl text-base text-muted-foreground md:text-lg">
                {page.subheadline}
              </p>
              <p className="mt-4 max-w-2xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground/90 md:text-base">
                <span className="font-medium text-primary">No per-member or guest fees.</span> One
                $10/month hosted plan covers your whole team and every client reviewer link.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  href={hostedCtaHref}
                  className="group relative isolate inline-flex h-12 items-center justify-center overflow-hidden border border-primary bg-primary px-8 text-sm font-medium text-primary-foreground transition-transform duration-300 hover:scale-[1.02]"
                >
                  Start free trial
                  <MoveRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Link>
                <a
                  href={seoConfig.githubUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-12 items-center justify-center border border-border bg-background px-8 text-sm font-medium text-foreground transition-colors hover:bg-card"
                >
                  <Github className="mr-2 h-4 w-4" />
                  View GitHub
                </a>
              </div>
            </div>
            <ProductVisual variant={page.visualVariant} />
          </div>
        </section>

        <section className="border-b border-border px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto w-full max-w-[1200px]">
            <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-4xl">
              {page.solutionTitle}
            </h2>
            <p className="mt-4 max-w-3xl text-base text-muted-foreground md:text-lg">
              {page.solutionNarrative}
            </p>
          </div>
        </section>

        <section className="border-b border-border bg-background px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto grid w-full max-w-[1200px] gap-8 lg:grid-cols-2">
            <div className="border border-primary/30 bg-primary/5 p-6">
              <h3 className="text-xl font-semibold">Where OpenFrame fits best</h3>
              <ul className="mt-4 space-y-3 text-sm text-foreground/90 md:text-base">
                {page.bestForOpenFrame.map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </div>
            <div className="border border-border bg-card p-6">
              <h3 className="text-xl font-semibold">Where {competitorName} may still fit</h3>
              <ul className="mt-4 space-y-3 text-sm text-muted-foreground md:text-base">
                {page.bestForCompetitor.map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="border-b border-border bg-card/10 px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto grid w-full max-w-[1200px] gap-8 lg:grid-cols-2">
            <div>
              <h3 className="text-2xl font-semibold">OpenFrame advantages</h3>
              <ul className="mt-4 space-y-3 text-sm md:text-base">
                {page.openframeWins.map((item) => (
                  <li key={item} className="border border-border bg-background p-4">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-2xl font-semibold">{competitorName} advantages</h3>
              <ul className="mt-4 space-y-3 text-sm text-muted-foreground md:text-base">
                {page.competitorWins.map((item) => (
                  <li key={item} className="border border-border bg-background p-4">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="border-b border-border px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto w-full max-w-[1200px] space-y-8">
            <div>
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-4xl">
                Feature comparison
              </h2>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground md:text-base">
                Honest tradeoffs based on official product, pricing, and help documentation. Verify
                current plans before buying.
              </p>
            </div>
            <FeatureComparisonTable rows={page.featureRows} competitorName={competitorName} />
          </div>
        </section>

        <section className="border-b border-border bg-[#0a0a0a] px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto w-full max-w-[1200px] space-y-8">
            <div>
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-4xl">
                Pricing comparison
              </h2>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground md:text-base">
                OpenFrame is $10/month flat with a 7-day free trial. You do not pay per team member,
                collaborator, or guest reviewer. Self-hosting is free with Docker.
              </p>
            </div>
            <PricingComparison
              rows={page.pricingRows}
              footnote={page.pricingFootnote}
              competitorName={competitorName}
            />
          </div>
        </section>

        <section className="border-b border-border px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto w-full max-w-[1200px]">
            <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-4xl">FAQ</h2>
            <div className="mt-8 space-y-4">
              {page.faq.map((item) => (
                <div key={item.question} className="border border-border bg-card p-6">
                  <h3 className="text-lg font-semibold">{item.question}</h3>
                  <p className="mt-2 text-sm text-muted-foreground md:text-base">{item.answer}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {relatedSlugs.length > 0 ? (
          <section className="border-b border-border bg-card/10 px-4 py-12 sm:px-6 lg:px-8">
            <div className="mx-auto w-full max-w-[1200px]">
              <h2 className="text-xl font-semibold">Related comparisons</h2>
              <div className="mt-4 flex flex-wrap gap-3">
                {relatedSlugs.map((slug) => (
                  <Link
                    key={slug}
                    href={`/${slug}`}
                    className="inline-flex items-center gap-2 border border-border bg-background px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {slug.replaceAll('-', ' ')}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <section className="px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center justify-between gap-4 border border-border bg-card p-8 text-center md:flex-row md:text-left">
            <div>
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-4xl">
                Start your free trial
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Your first client review link takes minutes.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href={hostedCtaHref}
                className="inline-flex h-12 items-center justify-center border border-primary bg-primary px-8 text-sm font-medium text-primary-foreground"
              >
                Start free trial
              </Link>
              <a
                href={seoConfig.githubUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-12 items-center justify-center border border-border bg-background px-8 text-sm font-medium text-foreground"
              >
                View GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
