'use client';

import Image from 'next/image';
import Link from 'next/link';
import { CtaLink } from '@/components/marketing/cta-link';
import { MarketingCompareLinks } from '@/components/marketing/marketing-compare-links';
import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import {
  Video,
  MoveRight,
  Play,
  Mic,
  Users,
  Tag,
  Code,
  Lock,
  Upload,
  Share2,
  MessageSquare,
  Check,
  CheckCircle2,
  Copy,
  Link as LinkIcon,
  Github,
  ArrowRight,
} from 'lucide-react';

interface LandingPageProps {
  isLoggedIn: boolean;
}

const controlButtonClass =
  'group relative isolate inline-flex h-8 items-center justify-center overflow-hidden border border-border bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors duration-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-9 sm:px-4 sm:text-xs';

const primaryCtaClass =
  'group relative isolate inline-flex min-h-12 items-center justify-center gap-2 overflow-hidden border border-primary bg-primary px-6 py-3 text-center text-[13px] font-semibold text-primary-foreground transition-colors duration-300 hover:bg-primary/90 sm:px-8 sm:text-sm';

const labelClass = 'text-[11px] uppercase tracking-[0.14em] text-muted-foreground';

const trustSignals = [
  { label: 'No client accounts', icon: Users },
  { label: 'Flat $10 per month', icon: Tag },
  { label: 'Fair Source, self-hostable', icon: Code },
  { label: 'Private by default', icon: Lock },
];

const steps = [
  {
    label: 'Upload a cut',
    description: 'Drop a file, or import an unlisted YouTube video.',
    icon: Upload,
  },
  {
    label: 'Share the link',
    description: 'Set permissions once, the client needs no account.',
    icon: Share2,
  },
  {
    label: 'Timestamped feedback',
    description: 'Comments, voice notes and drawings land on the frame.',
    icon: MessageSquare,
  },
  {
    label: 'Approve and move on',
    description: 'The cut gets a signed off Approved status, export the notes.',
    icon: Check,
  },
];

const hostedFeatures = [
  'Unlimited collaborators and clients',
  'Live review sessions, up to 10 participants',
  'Comments, voice notes, annotations',
  'Version compare, history, approvals',
  'Permissioned share links, PDF and CSV export',
  'Unlimited unlisted YouTube imports',
  '200 GB storage, add 100 GB for $5/mo',
];

const selfHostedFeatures = [
  'Full source code, read it and audit it',
  'Docker setup for self-hosting',
  'Every release becomes Apache 2.0 two years after publication',
];

const faq = [
  {
    q: 'How does live review work?',
    a: 'Start a live review on an uploaded video and invite your client through a share link with commenting enabled. Up to 10 participants can watch in sync, draw on the frame, and save their drawings as timestamped comments. Live review does not include voice or video calls and is not available for YouTube imports.',
  },
  {
    q: 'Do clients need an account?',
    a: 'No. They can review in the browser with a share link.',
  },
  {
    q: 'Is OpenFrame open source?',
    a: 'OpenFrame is Fair Source, licensed under the Functional Source License (FSL). You can read and audit the full source code and self-host it, and every release automatically becomes Apache 2.0 open source two years after publication.',
  },
  {
    q: 'Is there a free trial?',
    a: 'Yes. Hosted Cloud starts with a 7-day free trial and never asks for a card to begin it. After that it is a flat $10/mo, with no per-seat or per-client fees.',
  },
  {
    q: 'How is this different from a Google Drive link?',
    a: 'Drive does not give timestamped discussion, voice notes, annotations, or version compare, which is where approval time is actually saved.',
  },
  {
    q: 'What happens if I exceed my storage?',
    a: 'You can add 100 GB for $5/mo. If you need much more, contact us at info@open-frame.net and we will help you choose the best setup.',
  },
  {
    q: 'Can I self-host?',
    a: 'Yes. The full source code is public and ships with a Docker setup for self-hosting. Hosted Cloud is for teams who want zero setup.',
  },
];

// Bar heights for the voice note waveform, in percent. The first twenty read
// as "played", the rest as "remaining".
const waveformBars = [
  28, 52, 74, 40, 96, 62, 34, 80, 46, 90, 38, 66, 88, 30, 72, 50, 84, 42, 94, 56, 32, 68, 44, 86,
  36, 60, 92, 48, 26, 70, 54, 82, 38, 64,
];

const shareOptions = [
  { label: 'Can comment', on: true },
  { label: 'Ask for a name before commenting', on: true },
  { label: 'Allow download of the original file', on: false },
  { label: 'Show earlier versions', on: false },
];

const heroGridStyle = {
  backgroundImage:
    'linear-gradient(to right, color-mix(in oklab, var(--foreground) 5%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--foreground) 5%, transparent) 1px, transparent 1px)',
  backgroundSize: '48px 48px',
  maskImage:
    'radial-gradient(ellipse 820px 640px at 50% 30%, #000 0%, rgba(0,0,0,0.6) 52%, transparent 80%)',
  WebkitMaskImage:
    'radial-gradient(ellipse 820px 640px at 50% 30%, #000 0%, rgba(0,0,0,0.6) 52%, transparent 80%)',
} as const;

const heroGlowStyle = {
  background:
    'radial-gradient(closest-side, color-mix(in oklab, var(--primary) 18%, transparent), color-mix(in oklab, var(--primary) 6%, transparent) 55%, transparent 100%)',
} as const;

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-3xl font-semibold leading-[1.05] tracking-[-0.02em] md:text-[42px]">
      {children}
    </h2>
  );
}

function MockToolbar({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between gap-3 border-b border-border px-3">
      <span className="truncate text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {left}
      </span>
      {right}
    </div>
  );
}

function Avatar({ initial }: { initial: string }) {
  return (
    <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center bg-secondary text-xs">
      {initial}
    </div>
  );
}

function Timecode({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-primary/10 px-2 py-[3px] text-[11px] tracking-[0.04em] text-primary">
      {children}
    </span>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`flex h-5 w-[38px] shrink-0 items-center px-[3px] ${on ? 'justify-end bg-primary' : 'justify-start bg-muted'}`}
    >
      <div
        className={`h-[14px] w-[14px] ${on ? 'bg-primary-foreground' : 'bg-muted-foreground/60'}`}
      />
    </div>
  );
}

export function LandingPage({ isLoggedIn }: LandingPageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostedCtaHref = isLoggedIn ? '/dashboard' : '/register';
  // Same button, two audiences. Once you are signed in it goes to the dashboard,
  // and offering a trial to someone who is already using the product reads as a
  // mistake rather than as an offer.
  const hostedCtaLabel = isLoggedIn ? 'Open dashboard' : 'Start 7-day free trial, no card required';

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from('[data-hero-copy]', {
        y: 40,
        opacity: 0,
        duration: 1,
        stagger: 0.15,
        ease: 'power4.out',
      });

      const bars = gsap.utils.toArray<HTMLElement>('.voice-bar');
      bars.forEach((bar, index) => {
        gsap.set(bar, { transformOrigin: 'center center' });
        gsap.to(bar, {
          scaleY: gsap.utils.random(0.3, 1.5),
          duration: gsap.utils.random(0.4, 0.8),
          repeat: -1,
          yoyo: true,
          delay: index * 0.05,
          ease: 'power2.inOut',
        });
      });
    }, rootRef);

    return () => {
      ctx.revert();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="min-h-screen overflow-x-hidden bg-background text-foreground font-sans selection:bg-primary/20"
    >
      <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between px-4 sm:h-16 sm:px-6 lg:px-10">
          <Link
            href="/"
            className="group relative isolate inline-flex items-center gap-2 overflow-hidden border border-border bg-background px-3 py-2"
          >
            <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
            <Video className="relative z-10 h-4 w-4 text-primary" />
            <span className="relative z-10 text-xs font-semibold tracking-[0.12em]">OPENFRAME</span>
          </Link>

          <nav className="hidden items-center gap-6 text-[11px] font-medium uppercase tracking-[0.14em] md:flex">
            <Link
              className="text-muted-foreground transition-colors hover:text-foreground"
              href="#features"
            >
              Features
            </Link>
            <Link
              className="text-muted-foreground transition-colors hover:text-foreground"
              href="#pricing"
            >
              Pricing
            </Link>
            <a
              className="text-muted-foreground transition-colors hover:text-foreground"
              href="https://github.com/yusufipk/OpenFrame"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <a
              className="text-muted-foreground transition-colors hover:text-foreground"
              href="mailto:info@open-frame.net"
            >
              Contact
            </a>
          </nav>

          <div className="flex items-center gap-2">
            {isLoggedIn ? (
              <Link href="/dashboard" className={controlButtonClass}>
                <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                <span className="relative z-10 inline-flex items-center gap-2">
                  Dashboard
                  <MoveRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="text-xs font-medium text-muted-foreground hover:text-foreground hidden sm:block mr-4"
                >
                  Log in
                </Link>
                <Link href="/register" className={controlButtonClass}>
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10">Start free trial</span>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="relative">
        {/* 1) HERO */}
        <section className="relative overflow-hidden px-4 pb-16 pt-20 sm:px-6 sm:pt-24 lg:px-8 lg:pb-24">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={heroGridStyle}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-[55%] h-[560px] w-[1000px] max-w-[140vw] -translate-x-1/2"
            style={heroGlowStyle}
          />

          <div className="relative mx-auto flex w-full max-w-[1200px] flex-col items-center gap-12 lg:gap-16">
            <div className="flex w-full max-w-[900px] flex-col items-center gap-6 text-center">
              <h1
                data-hero-copy
                className="text-4xl font-semibold leading-[0.95] tracking-[-0.03em] sm:text-5xl md:text-6xl lg:text-7xl"
              >
                Get client sign-off from one link.
              </h1>

              <p
                data-hero-copy
                className="max-w-[660px] text-base leading-relaxed text-muted-foreground md:text-lg"
              >
                Review together live, or leave timestamped comments, voice notes and drawings.
                Clients join in the browser, no account needed.
              </p>

              <div data-hero-copy className="flex flex-col items-center gap-3.5">
                <CtaLink href={hostedCtaHref} className={primaryCtaClass}>
                  {hostedCtaLabel}
                  <MoveRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-1" />
                </CtaLink>
                <a
                  href="https://github.com/yusufipk/OpenFrame"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Prefer self-hosting? View on GitHub <ArrowRight className="ml-1 inline h-3 w-3" />
                </a>
              </div>
            </div>

            <div data-hero-copy className="w-full max-w-[1100px]">
              <div className="relative aspect-video w-full overflow-hidden border border-border bg-card shadow-2xl">
                <video
                  src="/landing/hero-flow.mp4"
                  poster="/landing/deep-dive-dashboard-2.webp"
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
            </div>
          </div>
        </section>

        {/* 2) TRUST STRIP */}
        <section className="border-y border-border bg-card/30 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto grid w-full max-w-[1200px] grid-cols-2 gap-px bg-border md:grid-cols-4">
            {trustSignals.map((signal) => (
              <div
                key={signal.label}
                className="flex items-center gap-2.5 bg-background px-4 py-3.5 sm:px-5"
              >
                <signal.icon className="h-4 w-4 shrink-0 text-primary" />
                <span className="text-[11px] uppercase tracking-[0.14em]">{signal.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section
          aria-label="Customer testimonials"
          className="border-b border-border px-4 py-14 sm:px-6 lg:px-8 lg:py-16"
        >
          <div className="mx-auto grid w-full max-w-[1200px] gap-10 md:grid-cols-2 md:gap-12">
            <figure className="flex flex-col justify-between gap-5 text-center">
              <blockquote className="text-2xl font-medium leading-relaxed tracking-[-0.02em]">
                <p>“I absolutely love this. It’s way more affordable than Frame.”</p>
              </blockquote>
              <figcaption className="text-sm">
                <span className="font-semibold">Bez Duru</span>
                <span className="text-muted-foreground"> · Guestvfx</span>
              </figcaption>
            </figure>
            <figure className="flex flex-col justify-between gap-5 border-t border-border pt-10 text-center md:border-l md:border-t-0 md:pl-12 md:pt-0">
              <blockquote className="text-2xl font-medium leading-relaxed tracking-[-0.02em]">
                <p>
                  “I&apos;ve been using OpenFrame for the last two months, and everything is going
                  smoothly.”
                </p>
              </blockquote>
              <figcaption className="text-sm font-semibold">Done Right</figcaption>
            </figure>
          </div>
        </section>

        {/* 3) FEATURES */}
        <section id="features" className="scroll-mt-20">
          {/* Live review */}
          <div className="border-b border-border px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
            <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-14">
              <div className="flex flex-col gap-4">
                <p className={labelClass}>Live review</p>
                <SectionTitle>Watch together. Point it out.</SectionTitle>
                <p className="text-base leading-relaxed text-muted-foreground">
                  Play, pause and seek in sync with your client. Draw directly on the frame and save
                  the feedback as a timestamped comment.
                </p>
              </div>
              <div className="min-w-0 border border-border bg-card">
                <MockToolbar left="Live review" right="Watch, draw, save" />
                <div className="relative aspect-video w-full overflow-hidden bg-black">
                  <video
                    src="/landing/live-review.mp4"
                    poster="/landing/live-review-poster.webp"
                    aria-label="Two OpenFrame participants watching in sync and drawing on the same frame"
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="none"
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Version compare */}
          <div className="border-b border-border px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
            <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-14">
              <div className="flex flex-col gap-4">
                <SectionTitle>See exactly what changed.</SectionTitle>
                <p className="text-base leading-relaxed text-muted-foreground">
                  Put two cuts on one timeline and scrub them together, then approve without asking
                  which version this is.
                </p>
              </div>
              <div className="min-w-0 border border-border bg-card">
                <MockToolbar
                  left="Compare versions"
                  right={
                    <div className="flex items-center gap-2 text-[10px] tracking-[0.04em]">
                      <span className="bg-secondary px-2 py-[3px]">v2</span>
                      <span className="text-muted-foreground">against</span>
                      <span className="bg-primary/10 px-2 py-[3px] text-primary">v1</span>
                    </div>
                  }
                />
                <div className="relative aspect-video w-full overflow-hidden bg-black">
                  <video
                    src="/landing/compare-cuts.mp4"
                    poster="/landing/compare-cuts-poster.webp"
                    aria-label="OpenFrame side by side version comparison demo"
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="none"
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Voice notes and annotations */}
          <div className="border-b border-border bg-card/30 px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
            <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14">
              <div className="flex flex-col gap-4 lg:order-2">
                <SectionTitle>Say it, or draw it.</SectionTitle>
                <p className="text-base leading-relaxed text-muted-foreground">
                  Record a note or circle the frame, and both land on the exact second instead of in
                  a follow-up email.
                </p>
              </div>

              <div className="min-w-0 border border-border bg-card lg:order-1">
                <MockToolbar
                  left="Comment thread, Version 3"
                  right={
                    <span className="hidden text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:block">
                      Sorted by timecode
                    </span>
                  }
                />
                <div className="flex flex-col gap-3.5 p-4 sm:p-5">
                  <div className="flex flex-col gap-3.5 border border-border bg-background p-4 sm:p-[18px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <Avatar initial="M" />
                        <span className="text-[13px] font-medium">Michael A.</span>
                        <Timecode>00:04:44</Timecode>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-primary">
                        <Mic className="h-3.5 w-3.5" />
                        <span>Voice note</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3.5">
                      <div
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center bg-primary text-primary-foreground"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                      </div>
                      <div className="flex h-11 min-w-0 flex-1 items-center gap-[3px]">
                        {waveformBars.map((height, index) => (
                          <span
                            key={index}
                            className={`voice-bar flex-1 ${index < 20 ? 'bg-primary/70' : 'bg-foreground/15'}`}
                            style={{ height: `${height}%` }}
                          />
                        ))}
                      </div>
                      <span className="shrink-0 text-[11px] tracking-[0.04em] text-muted-foreground">
                        0:11 / 0:19
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="border border-border px-2 py-[3px] text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Feedback
                      </span>
                      <span className="text-[11px] text-muted-foreground">Reply</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-4 border border-border bg-background p-4 sm:flex-row sm:p-[18px]">
                    <div className="relative h-[112px] w-full shrink-0 overflow-hidden border border-border bg-black sm:w-[200px]">
                      <Image
                        src="/landing/deep-dive-dashboard-2.webp"
                        alt="Annotated frame"
                        fill
                        className="origin-[30%_40%] scale-[2.4] object-cover brightness-75"
                        sizes="(min-width: 640px) 480px, 240vw"
                      />
                      <svg
                        aria-hidden="true"
                        className="absolute inset-0 h-full w-full text-primary"
                        viewBox="0 0 200 112"
                        preserveAspectRatio="none"
                        fill="none"
                      >
                        <ellipse
                          cx="98"
                          cy="52"
                          rx="52"
                          ry="28"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                        <path
                          d="M144 38 Q164 22 182 32"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                    <div className="flex min-w-0 flex-col gap-2.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Avatar initial="D" />
                        <span className="text-[13px] font-medium">David K.</span>
                        <Timecode>00:01:49</Timecode>
                        <span className="border border-purple-500/40 px-2 py-[3px] text-[10px] uppercase tracking-[0.14em] text-purple-700 dark:text-purple-300">
                          Annotated
                        </span>
                      </div>
                      <p className="text-sm leading-relaxed">
                        This block needs to clear the subject, I drew where it should sit.
                      </p>
                      <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
                        <span>Reply</span>
                        <span>Resolve</span>
                        <span>Export to PDF</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Share and approve */}
          <div className="border-b border-border px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
            <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-14">
              <div className="flex flex-col gap-4">
                <SectionTitle>One link, one approval.</SectionTitle>
                <p className="text-base leading-relaxed text-muted-foreground">
                  Decide what the link allows, send it, and get an Approved status you can point at
                  later.
                </p>
              </div>

              <div className="flex min-w-0 items-center justify-center border border-border bg-gradient-to-br from-card to-background p-4 sm:p-8">
                <div className="flex w-full max-w-[520px] flex-col border border-border bg-card">
                  <div className="flex h-11 items-center justify-between border-b border-border px-4">
                    <div className="flex items-center gap-2">
                      <Share2 className="h-[15px] w-[15px] text-primary" />
                      <span className="text-xs font-medium">Share review link</span>
                    </div>
                    <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Version 3
                    </span>
                  </div>
                  <div className="flex flex-col gap-4 p-4 sm:p-[18px]">
                    <div className="flex items-stretch border border-border bg-background">
                      <div className="flex h-10 min-w-0 flex-1 items-center gap-2 px-3">
                        <LinkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-xs">open-frame.net/watch/share-7f3a</span>
                      </div>
                      <div className="flex items-center gap-1.5 bg-primary px-3.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-foreground">
                        <Copy className="h-[13px] w-[13px]" />
                        <span>Copy</span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-px border border-border bg-border">
                      {shareOptions.map((option) => (
                        <div
                          key={option.label}
                          className="flex items-center justify-between gap-3 bg-background px-3.5 py-3"
                        >
                          <span className={`text-xs ${option.on ? '' : 'text-muted-foreground'}`}>
                            {option.label}
                          </span>
                          <Toggle on={option.on} />
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border border-primary/35 bg-primary/10 px-3.5 py-3">
                      <div className="flex items-center gap-2.5">
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                        <span className="text-[11px] uppercase tracking-[0.14em] text-primary">
                          Approved by
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs">David K.</span>
                        <span className="text-[11px] tracking-[0.04em] text-muted-foreground">
                          22.02.2026 16:04
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 4) HOW IT WORKS */}
        <section className="border-b border-border bg-card/30 px-4 py-14 sm:px-6 lg:px-8 lg:py-16">
          <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-7">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-2xl font-semibold tracking-[-0.02em] md:text-[28px]">
                From upload to approval, in one flow.
              </h2>
              <span className={labelClass}>Four steps, one link</span>
            </div>
            <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((step, index) => (
                <div key={step.label} className="flex flex-col gap-3 bg-background p-5">
                  <div className="flex items-center justify-between">
                    <step.icon className="h-5 w-5 text-primary" />
                    <span className="text-[11px] tracking-[0.14em] text-muted-foreground/60">
                      0{index + 1}
                    </span>
                  </div>
                  <span className="text-sm font-medium">{step.label}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {step.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 5) PRICING */}
        <section
          id="pricing"
          className="scroll-mt-20 border-b border-border bg-card/30 px-4 py-16 sm:px-6 lg:px-8 lg:py-20"
        >
          <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <SectionTitle>Let us run it, or run it yourself.</SectionTitle>
              <span className={labelClass}>No per-seat fees</span>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
              <div className="relative flex flex-col gap-[18px] border border-primary/40 bg-card p-6 sm:p-7">
                <span className="absolute -top-[11px] left-6 bg-primary px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-foreground sm:left-7">
                  Recommended
                </span>
                <div className="flex flex-col gap-2">
                  <span className={labelClass}>Hosted cloud</span>
                  <div className="flex items-baseline gap-2 text-primary">
                    <span className="text-[40px] font-semibold tracking-[-0.02em]">$10</span>
                    <span className="text-sm">/ month</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    7-day free trial, no credit card. Cancel anytime.
                  </span>
                </div>
                <ul className="flex flex-col gap-2.5 text-[13px]">
                  {hostedFeatures.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-[15px] w-[15px] shrink-0 text-primary" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-2">
                  <CtaLink href={hostedCtaHref} className={`${primaryCtaClass} w-full`}>
                    {isLoggedIn ? 'Open dashboard' : 'Start 7-day free trial'}
                  </CtaLink>
                </div>
              </div>

              <div className="flex flex-col gap-[18px] border border-border bg-card p-6 sm:p-7">
                <div className="flex flex-col gap-2">
                  <span className={labelClass}>Fair Source, self-hosted</span>
                  <span className="text-[40px] font-semibold tracking-[-0.02em] text-primary">
                    Free
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <a
                      href="https://fsl.software/"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Functional Source License
                    </a>
                    . Your infrastructure, your data.
                  </span>
                </div>
                <ul className="flex flex-col gap-2.5 text-[13px]">
                  {selfHostedFeatures.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-[15px] w-[15px] shrink-0 text-primary" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-2">
                  <a
                    href="https://github.com/yusufipk/OpenFrame"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-12 w-full items-center justify-center gap-2 border border-border bg-background text-[13px] font-medium transition-colors hover:border-foreground/30"
                  >
                    <Github className="h-[15px] w-[15px]" />
                    View on GitHub
                  </a>
                </div>
              </div>

              <div className="flex flex-col gap-[18px] border border-border bg-card p-6 sm:p-7">
                <div className="flex flex-col gap-2">
                  <span className={labelClass}>Need more?</span>
                  <span className="text-[40px] font-semibold tracking-[-0.02em] text-primary">
                    Let&apos;s talk
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Custom capacity and setup help for high volume teams.
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed">
                  Tell us your storage, usage and workflow, we will recommend the right approach.
                  Hosted, self-hosted, or a mix of both.
                </p>
                <div className="mt-auto flex flex-col gap-3 pt-2">
                  <span className="text-xs text-muted-foreground">info@open-frame.net</span>
                  <a
                    href="mailto:info@open-frame.net"
                    className="inline-flex h-12 w-full items-center justify-center border border-border bg-background text-[13px] font-medium transition-colors hover:border-foreground/30"
                  >
                    Contact us
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 6) FAQ */}
        <section className="border-b border-border px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-7">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <SectionTitle>Questions people ask.</SectionTitle>
              <a
                href="mailto:info@open-frame.net"
                className={`${labelClass} hover:text-foreground`}
              >
                info@open-frame.net
              </a>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {faq.map((item) => (
                <div
                  key={item.q}
                  className="flex flex-col gap-2.5 border border-border bg-card p-5 transition-colors hover:border-primary/45"
                >
                  <h3 className="text-[15px] font-semibold">{item.q}</h3>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 7) FINAL CTA */}
        <section className="border-b border-border bg-card/30 px-4 py-14 sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center justify-between gap-6 text-center md:flex-row md:text-left">
            <div className="flex flex-col gap-2">
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-4xl">
                Stop chasing feedback. Start getting approvals.
              </h2>
              <span className="text-sm text-muted-foreground">
                Your first review link takes minutes.
              </span>
            </div>
            <div className="flex flex-col items-center gap-2.5 md:shrink-0 md:items-end">
              <CtaLink href={hostedCtaHref} className={`${primaryCtaClass} md:whitespace-nowrap`}>
                {hostedCtaLabel}
                <MoveRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-1" />
              </CtaLink>
              <a
                href="https://github.com/yusufipk/OpenFrame"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Prefer self-hosting? View on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-background px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-[1200px] gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex items-start gap-2">
            <Video className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="flex flex-col gap-1">
              <span className="font-mono text-xs text-muted-foreground">
                © 2026 IPEK TECH LLC. All rights reserved.
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                30 North Gould Street, Suite N, Sheridan, WY 82801, United States
              </span>
            </div>
          </div>
          <MarketingCompareLinks />
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Legal
            </span>
            <div className="flex flex-col gap-1.5">
              <a
                href="mailto:info@open-frame.net"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                info@open-frame.net
              </a>
              <a
                href="https://github.com/yusufipk/OpenFrame"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                GitHub
              </a>
              <Link href="/terms" className="text-xs text-muted-foreground hover:text-foreground">
                Terms
              </Link>
              <Link href="/privacy" className="text-xs text-muted-foreground hover:text-foreground">
                Privacy
              </Link>
              <Link href="/refund" className="text-xs text-muted-foreground hover:text-foreground">
                Refund Policy
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
