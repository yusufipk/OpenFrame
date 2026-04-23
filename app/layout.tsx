import type { Metadata } from 'next';
import { Geist_Mono, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/components/theme-provider';
import { seoConfig } from '@/lib/seo';
import './globals.css';

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  preload: true,
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
  preload: true,
});

export const metadata: Metadata = {
  metadataBase: new URL(seoConfig.url),
  title: {
    default: `${seoConfig.name} | ${seoConfig.title}`,
    template: `%s | ${seoConfig.name}`,
  },
  description: seoConfig.description,
  applicationName: seoConfig.name,
  keywords: [...seoConfig.keywords],
  authors: [{ name: seoConfig.name, url: seoConfig.url }],
  creator: seoConfig.name,
  publisher: seoConfig.name,
  category: 'technology',
  referrer: 'no-referrer',
  alternates: {
    canonical: '/',
  },
  icons: {
    icon: [{ url: seoConfig.logo, type: 'image/svg+xml' }],
    shortcut: [seoConfig.logo],
    apple: [{ url: seoConfig.logo }],
  },
  manifest: '/manifest.webmanifest',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: seoConfig.name,
    url: seoConfig.url,
    title: `${seoConfig.name} | ${seoConfig.title}`,
    description: seoConfig.description,
    images: [
      {
        url: seoConfig.ogImage,
        width: 1888,
        height: 1048,
        alt: `${seoConfig.name} meta image`,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${seoConfig.name} | ${seoConfig.title}`,
    description: seoConfig.description,
    images: [seoConfig.ogImage],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

const structuredData = [
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: seoConfig.name,
    url: seoConfig.url,
    logo: `${seoConfig.url}${seoConfig.logoPath}`,
    sameAs: [seoConfig.githubUrl],
  },
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: seoConfig.name,
    url: seoConfig.url,
    description: seoConfig.description,
    publisher: {
      '@type': 'Organization',
      name: seoConfig.name,
      logo: {
        '@type': 'ImageObject',
        url: `${seoConfig.url}${seoConfig.logoPath}`,
      },
    },
  },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${jetbrainsMono.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased min-h-screen bg-background font-sans">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <svg aria-hidden="true" className="fixed h-0 w-0">
            <filter id="openframe-noise">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.92"
                numOctaves="2"
                stitchTiles="stitch"
              />
            </filter>
          </svg>
          {children}
          <div aria-hidden="true" className="noise-overlay" />
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
