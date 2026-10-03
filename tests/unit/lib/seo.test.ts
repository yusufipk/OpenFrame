import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSiteUrl, seoConfig } from '@/lib/seo';
import { buildComparisonJsonLd, buildComparisonMetadata } from '@/lib/marketing/metadata';

const FALLBACK = 'https://open-frame.net';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
  vi.stubEnv('NEXTAUTH_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSiteUrl', () => {
  it('falls back to the production origin when neither variable is set', () => {
    expect(getSiteUrl()).toBe(FALLBACK);
  });

  it('prefers NEXT_PUBLIC_APP_URL over NEXTAUTH_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
    vi.stubEnv('NEXTAUTH_URL', 'https://auth.example.com');

    expect(getSiteUrl()).toBe('https://app.example.com');
  });

  it('uses NEXTAUTH_URL when the public variable is unset', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://auth.example.com');

    expect(getSiteUrl()).toBe('https://auth.example.com');
  });

  it.each([
    ['https://example.com/marketing/pricing', 'https://example.com'],
    ['https://example.com?utm=x', 'https://example.com'],
    ['https://example.com:8443/path', 'https://example.com:8443'],
    ['http://localhost:3000/', 'http://localhost:3000'],
  ])('reduces %s to the origin %s', (raw, expected) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', raw);

    expect(getSiteUrl()).toBe(expected);
  });

  it.each([
    ['example.com', 'https://example.com'],
    ['example.com/path', 'https://example.com'],
    ['  example.com  ', 'https://example.com'],
  ])('adds the https scheme to %s', (raw, expected) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', raw);

    expect(getSiteUrl()).toBe(expected);
  });

  it('keeps an explicit http scheme rather than upgrading it', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://example.com');

    expect(getSiteUrl()).toBe('http://example.com');
  });

  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['a bare colon', ':'],
  ])('falls back for %s', (_label, raw) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', raw);

    expect(getSiteUrl()).toBe(FALLBACK);
  });
});

describe('seoConfig', () => {
  it('resolves its url once at import time and does not follow later env changes', () => {
    const atImport = seoConfig.url;
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://changed.example.com');

    expect(seoConfig.url).toBe(atImport);
    expect(getSiteUrl()).toBe('https://changed.example.com');
  });

  it('exposes an origin with no trailing slash so paths can be appended directly', () => {
    expect(seoConfig.url).toMatch(/^https?:\/\/[^/]+$/);
  });

  it('keeps the description within the length search engines render', () => {
    expect(seoConfig.description.length).toBeGreaterThan(50);
    expect(seoConfig.description.length).toBeLessThanOrEqual(160);
  });

  it('keeps the title short enough to avoid truncation', () => {
    expect(seoConfig.title.length).toBeLessThanOrEqual(60);
  });

  it('has no duplicate keywords', () => {
    expect(new Set(seoConfig.keywords).size).toBe(seoConfig.keywords.length);
  });

  it('points the og image and logo at site-relative paths', () => {
    expect(seoConfig.ogImage.startsWith('/')).toBe(true);
    expect(seoConfig.logo.startsWith('/')).toBe(true);
  });
});

describe('buildComparisonMetadata', () => {
  const input = {
    title: 'OpenFrame vs Frame.io',
    description: 'A side by side comparison of OpenFrame and Frame.io for video review.',
    path: 'compare/frameio',
    keywords: ['frame.io alternative'],
  };

  it('adds a leading slash to a relative canonical path', () => {
    expect(buildComparisonMetadata(input).alternates?.canonical).toBe('/compare/frameio');
  });

  it('leaves an already absolute path alone', () => {
    expect(
      buildComparisonMetadata({ ...input, path: '/compare/frameio' }).alternates?.canonical
    ).toBe('/compare/frameio');
  });

  it('keeps the page title unbranded and brands only the social titles', () => {
    const metadata = buildComparisonMetadata(input);

    expect(metadata.title).toBe('OpenFrame vs Frame.io');
    expect(metadata.openGraph?.title).toBe('OpenFrame vs Frame.io | OpenFrame');
    expect(metadata.twitter?.title).toBe('OpenFrame vs Frame.io | OpenFrame');
  });

  it('builds an absolute open graph url from the site origin and the canonical path', () => {
    expect(buildComparisonMetadata(input).openGraph?.url).toBe(`${seoConfig.url}/compare/frameio`);
  });

  it('appends the page keywords after the shared ones', () => {
    const keywords = buildComparisonMetadata(input).keywords as string[];

    expect(keywords.slice(0, seoConfig.keywords.length)).toEqual([...seoConfig.keywords]);
    expect(keywords[keywords.length - 1]).toBe('frame.io alternative');
  });

  it('defaults to the shared keywords when none are supplied', () => {
    const keywords = buildComparisonMetadata({ ...input, keywords: undefined })
      .keywords as string[];

    expect(keywords).toEqual([...seoConfig.keywords]);
  });

  it('declares a large summary card with the shared og image', () => {
    const metadata = buildComparisonMetadata(input);

    // The Twitter metadata type is a union whose `card` field is only present on
    // some branches, so read it through a narrow structural view.
    const twitter = metadata.twitter as { card?: string; images?: unknown };
    expect(twitter.card).toBe('summary_large_image');
    expect(twitter.images).toEqual([seoConfig.ogImage]);
    expect(metadata.openGraph?.images).toEqual([
      {
        url: seoConfig.ogImage,
        width: 1888,
        height: 1048,
        alt: 'OpenFrame vs Frame.io | OpenFrame',
      },
    ]);
  });

  it('reuses the same description across the page, open graph and twitter blocks', () => {
    const metadata = buildComparisonMetadata(input);

    expect(metadata.description).toBe(input.description);
    expect(metadata.openGraph?.description).toBe(input.description);
    expect(metadata.twitter?.description).toBe(input.description);
  });
});

describe('buildComparisonJsonLd', () => {
  const input = {
    title: 'OpenFrame vs Frame.io',
    description: 'A comparison.',
    path: 'compare/frameio',
    faq: [],
  };

  it('emits a WebPage and a SoftwareApplication node when there is no FAQ', () => {
    const nodes = buildComparisonJsonLd(input);

    expect(nodes.map((node) => node['@type'])).toEqual(['WebPage', 'SoftwareApplication']);
  });

  it('builds an absolute page url and normalises a relative path', () => {
    const [webPage] = buildComparisonJsonLd(input);

    expect(webPage.url).toBe(`${seoConfig.url}/compare/frameio`);
  });

  it('does not double the leading slash on an absolute path', () => {
    const [webPage] = buildComparisonJsonLd({ ...input, path: '/compare/frameio' });

    expect(webPage.url).toBe(`${seoConfig.url}/compare/frameio`);
  });

  it('links the page to the site via isPartOf', () => {
    const [webPage] = buildComparisonJsonLd(input);

    expect(webPage.isPartOf).toEqual({
      '@type': 'WebSite',
      name: 'OpenFrame',
      url: seoConfig.url,
    });
  });

  it('advertises both hosted plans on the SoftwareApplication node', () => {
    const [, app] = buildComparisonJsonLd(input);

    expect(app.offers).toMatchObject([
      { '@type': 'Offer', name: 'Solo', price: '10', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Studio', price: '29', priceCurrency: 'USD' },
    ]);
    expect(app.applicationCategory).toBe('MultimediaApplication');
  });

  it('appends an FAQPage node built from the questions', () => {
    const nodes = buildComparisonJsonLd({
      ...input,
      faq: [
        { question: 'Is it open source?', answer: 'It is fair source.' },
        { question: 'Is there a trial?', answer: 'Seven days.' },
      ],
    });

    expect(nodes).toHaveLength(3);
    expect(nodes[2]).toEqual({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Is it open source?',
          acceptedAnswer: { '@type': 'Answer', text: 'It is fair source.' },
        },
        {
          '@type': 'Question',
          name: 'Is there a trial?',
          acceptedAnswer: { '@type': 'Answer', text: 'Seven days.' },
        },
      ],
    });
  });

  it('sets the schema.org context on every node', () => {
    const nodes = buildComparisonJsonLd({
      ...input,
      faq: [{ question: 'Q', answer: 'A' }],
    });

    expect(nodes.every((node) => node['@context'] === 'https://schema.org')).toBe(true);
  });
});
