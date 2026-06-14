export type SourceType =
  | 'pricing'
  | 'product'
  | 'faq'
  | 'help'
  | 'docs'
  | 'comparison'
  | 'github'
  | 'changelog';

export type Confidence = 'high' | 'medium' | 'low';

export interface CompetitorSource {
  competitor: string;
  sourceUrl: string;
  sourceType: SourceType;
  lastChecked: string;
  claims: string[];
  caveats: string[];
  confidence: Confidence;
}

export interface CompetitorProfile {
  id: string;
  name: string;
  tagline: string;
  bestFor: string[];
  strengths: string[];
  limitations: string[];
  pricingSummary: string;
  pricingNotes: string[];
  reviewerAccess: string;
  selfHosted: boolean;
  sources: string[];
}

export type FeatureStatus = 'yes' | 'no' | 'partial' | 'openframe-only' | 'competitor-only';

export interface FeatureRow {
  label: string;
  openframe: FeatureStatus | string;
  competitor: FeatureStatus | string;
  note?: string;
}

export interface PricingRow {
  label: string;
  openframe: string;
  competitor: string;
}

export interface ComparisonFaq {
  question: string;
  answer: string;
}

export type VisualVariant =
  | 'timeline-comments'
  | 'version-compare'
  | 'approval-workflow'
  | 'guest-review'
  | 'voice-notes'
  | 'landing-compare'
  | 'landing-dashboard';

export interface ComparisonPageDefinition {
  slug: string;
  title: string;
  metaDescription: string;
  keywords: string[];
  competitorId: string | null;
  pageType: 'competitor' | 'use-case';
  eyebrow: string;
  headline: string;
  subheadline: string;
  painTitle: string;
  painNarrative: string;
  painBullets: string[];
  solutionTitle: string;
  solutionNarrative: string;
  bestForOpenFrame: string[];
  bestForCompetitor: string[];
  openframeWins: string[];
  competitorWins: string[];
  featureRows: FeatureRow[];
  pricingRows: PricingRow[];
  pricingFootnote?: string;
  faq: ComparisonFaq[];
  visualVariant: VisualVariant;
  relatedSlugs: string[];
}
