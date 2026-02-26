'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import {
  Video,
  MoveRight,
  Play,
  Mic,
  PenTool,
  Keyboard,
  BellRing,
  FolderOpen,
  FileDown,
  History,
  Smartphone,
  Link as LinkIcon,
  CheckSquare,
  MessageSquare,
  Github,
  ArrowRight,
  XCircle,
  ArrowDown,
  CheckCircle
} from 'lucide-react';


interface LandingPageProps {
  isLoggedIn: boolean;
}

const controlButtonClass =
  'group relative isolate inline-flex h-8 items-center justify-center overflow-hidden border border-border bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors duration-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-9 sm:px-4 sm:text-xs';

const coreWorkflowFeatures = [
  {
    title: 'Version Compare',
    description: 'Compare any two versions side-by-side on a single timeline.',
    icon: History,
  },
  {
    title: 'Asset Management',
    description: 'Keep images and supplementary videos grouped perfectly per cut.',
    icon: FolderOpen,
  },
  {
    title: 'Version History',
    description: 'Infinite versioning. Toggle between V1 and V10 without losing where you are.',
    icon: History,
  },
  {
    title: 'Approval Workflow',
    description: 'Assign specific team members or clients to review and sign off on a cut. Get an exact \"Approved\" status.',
    icon: CheckCircle,
  },
];

const workflowAcceleratorFeatures = [
  {
    title: 'Keyboard Shortcuts',
    description: 'J, K, L, Space, and M controls for professional editing workflows.',
    icon: Keyboard,
  },
  {
    title: 'PDF/CSV Exports',
    description: 'Turn video comments into a professional feedback report in one click.',
    icon: FileDown,
  },
  {
    title: 'Real-time Webhooks',
    description: 'Get instant Telegram or Slack alerts the second a comment is dropped.',
    icon: BellRing,
  },
  {
    title: 'Mobile-Optimized Review',
    description: 'Touch-optimized player for clients reviewing cuts on the move.',
    icon: Smartphone,
  },
];

export function LandingPage({ isLoggedIn }: LandingPageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navbarRef = useRef<HTMLElement | null>(null);
  const hostedCtaHref = isLoggedIn ? '/dashboard' : '/register';

  useEffect(() => {
    const cleanupHandlers: Array<() => void> = [];

    const ctx = gsap.context(() => {
      // General Reveal Animations
      gsap.from('[data-hero-copy]', {
        y: 40,
        opacity: 0,
        duration: 1,
        stagger: 0.15,
        ease: 'power4.out',
      });

      gsap.from('[data-reveal]', {
        y: 30,
        opacity: 0,
        duration: 0.9,
        stagger: 0.1,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: '[data-reveal]',
          start: 'top 85%',
        },
      });

      // Voice Notes Waveform Animation
      const waveformBars = gsap.utils.toArray<HTMLElement>('.voice-bar');
      waveformBars.forEach((bar, index) => {
        gsap.set(bar, { transformOrigin: 'center bottom' });
        gsap.to(bar, {
          scaleY: gsap.utils.random(0.3, 1.5),
          duration: gsap.utils.random(0.4, 0.8),
          repeat: -1,
          yoyo: true,
          delay: index * 0.05,
          ease: 'power2.inOut',
        });
      });

      // Navbar Scroll Effect
      const nav = navbarRef.current;
      if (nav) {
        const updateNavbar = () => {
          const hasScrolled = window.scrollY > 20;
          gsap.to(nav, {
            backgroundColor: hasScrolled ? 'color-mix(in oklab, var(--background) 85%, transparent)' : 'transparent',
            backdropFilter: hasScrolled ? 'blur(16px)' : 'blur(0px)',
            borderBottomColor: hasScrolled ? 'var(--border)' : 'transparent',
            duration: 0.3,
            overwrite: 'auto',
          });
        };
        updateNavbar();
        window.addEventListener('scroll', updateNavbar, { passive: true });
        cleanupHandlers.push(() => window.removeEventListener('scroll', updateNavbar));
      }
    }, rootRef);

    return () => {
      cleanupHandlers.forEach((cleanup) => cleanup());
      ctx.revert();
    };
  }, []);

  return (
    <div ref={rootRef} className="min-h-screen overflow-x-hidden bg-background text-foreground font-sans selection:bg-primary/20">
      {/* Header */}
      <header ref={navbarRef} className="fixed inset-x-0 top-0 z-50 border-b border-transparent bg-transparent transition-colors duration-300">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between px-4 sm:h-16 sm:px-6 lg:px-10">
          <Link href="/" className="group relative isolate inline-flex items-center gap-2 overflow-hidden border border-border bg-background px-3 py-2">
            <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
            <Video className="relative z-10 h-4 w-4 text-primary" />
            <span className="relative z-10 text-xs font-semibold tracking-[0.12em]">OPENFRAME</span>
          </Link>

          <nav className="hidden items-center gap-6 text-[11px] font-medium uppercase tracking-[0.14em] md:flex">
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="#features">
              Features
            </Link>
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="#pricing">
              Pricing
            </Link>
            <a className="text-muted-foreground transition-colors hover:text-foreground" href="https://github.com/yusufipk/OpenFrame" target="_blank" rel="noreferrer">
              GitHub
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
                <Link href="/login" className="text-xs font-medium text-muted-foreground hover:text-foreground hidden sm:block mr-4">
                  Log in
                </Link>
                <Link href="/register" className={controlButtonClass}>
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10">Get Started Free</span>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="relative">
        {/* 1) HERO */}
        <section className="relative flex min-h-[95vh] flex-col items-center justify-center px-4 pb-20 pt-32 text-center sm:px-6 lg:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-primary/5 via-background to-background" />

          <div className="relative z-10 mx-auto max-w-[1000px] space-y-8">
            <div data-hero-copy className="inline-flex items-center gap-2 border border-border/50 bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-md">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary"></span>
              </span>
              <span className="font-mono tracking-wide uppercase">Open Source Video Review</span>
            </div>

            <h1 data-hero-copy className="text-4xl font-semibold leading-[0.95] tracking-[-0.03em] sm:text-5xl md:text-6xl lg:text-7xl">
              Cut Video Approval Time in Half. <br className="hidden md:block" />
              <span className="text-muted-foreground">Stop Chasing Timecodes.</span>
            </h1>

            <p data-hero-copy className="mx-auto max-w-2xl text-base text-muted-foreground md:text-xl">
              OpenFrame puts comments, voice notes, and annotations on a single timeline so clients say &quot;yes&quot; faster and your team stops guessing.
            </p>

            <div data-hero-copy className="mx-auto flex max-w-md flex-col items-center justify-center gap-2">
              <Link
                href={hostedCtaHref}
                className="group relative isolate inline-flex h-12 min-w-max items-center justify-center overflow-hidden border border-primary bg-primary px-10 text-sm font-medium whitespace-nowrap text-primary-foreground transition-transform duration-300 hover:scale-[1.02]"
              >
                Start free
                <MoveRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Link>

              <a href="#pricing" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                Prefer self-hosting? <ArrowRight className="ml-1 inline h-3.5 w-3.5" />
              </a>
            </div>
          </div>

          <div data-hero-copy className="relative mx-auto mt-20 w-full max-w-[1200px]">
            <div className="relative aspect-[16/9] w-full overflow-hidden border border-border bg-card shadow-2xl rounded-lg">
              <Image
                src="/landing/deep-dive-dashboard-2.webp"
                alt="Product Interface Preview"
                fill
                className="object-cover"
                priority
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-transparent to-transparent pointer-events-none" />

              {/* Toolbar floating UI */}
              <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 border border-border/80 bg-background/90 p-2 backdrop-blur-md shadow-xl">
                <button className="flex h-8 w-8 items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90">
                  <PenTool className="h-4 w-4" />
                </button>
                <div className="h-6 w-px bg-border" />
                <button className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground">
                  <MessageSquare className="h-4 w-4" />
                </button>
                <button className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground">
                  <Mic className="h-4 w-4" />
                </button>
              </div>

            </div>
          </div>
        </section>

        {/* 2) PROBLEM BLOCK */}
        <section className="border-y border-border bg-card/10 px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mx-auto max-w-4xl">
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">Feedback chaos looks like this:</h2>
              <ul className="mt-8 space-y-4 text-base text-muted-foreground md:text-lg">
                <li className="flex items-start gap-3">
                  <XCircle className="mt-1 h-5 w-5 shrink-0 text-red-500/80" />
                  <span>Comments spread across WhatsApp, email, and random screenshots.</span>
                </li>
                <li className="flex items-start gap-3">
                  <XCircle className="mt-1 h-5 w-5 shrink-0 text-red-500/80" />
                  <span>&quot;Around 1:12&quot; turns into 10 minutes of guessing.</span>
                </li>
                <li className="flex items-start gap-3">
                  <XCircle className="mt-1 h-5 w-5 shrink-0 text-red-500/80" />
                  <span>Nobody knows which version is actually the latest.</span>
                </li>
                <li className="flex items-start gap-3">
                  <XCircle className="mt-1 h-5 w-5 shrink-0 text-red-500/80" />
                  <span>One unclear note becomes a full extra revision round.</span>
                </li>
              </ul>
              <div className="mt-10 border-l-2 border-primary/50 pl-4">
                <p className="text-base text-foreground md:text-lg">
                  OpenFrame replaces all of that with one link, one timeline, one source of truth.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 3) HOW IT WORKS */}
        <section className="border-b border-border bg-background px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-10 text-center">
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">From upload to approval - in one flow.</h2>
            </div>
            <div className="flex flex-col md:flex-row items-center gap-4 relative">
              {['Upload a cut', 'Share a review link', 'Get timestamped feedback', 'Mark approved and move on'].map((step, idx, arr) => (
                <div key={step} className="contents">
                  <div data-reveal className="flex-1 w-full border border-border bg-card/20 p-6 text-center text-sm font-medium text-foreground md:text-base relative z-10 transition-colors hover:border-primary/30">
                    <div className="mb-4 flex h-8 w-8 mx-auto items-center justify-center bg-secondary text-muted-foreground font-mono text-xs">
                      {idx + 1}
                    </div>
                    {step}
                  </div>
                  {idx < arr.length - 1 && (
                    <>
                      <div className="hidden md:block text-muted-foreground/30 flex-shrink-0">
                        <MoveRight className="h-6 w-6" />
                      </div>
                      <div className="block md:hidden text-muted-foreground/30 flex-shrink-0 py-2">
                        <ArrowDown className="h-6 w-6" />
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 4) FEATURES */}
        <section id="features" className="scroll-mt-20 border-t border-border bg-card/10">

          {/* Feature 1 */}
          <div className="border-b border-border">
            <div className="mx-auto flex w-full max-w-[1200px] flex-col-reverse items-center justify-between gap-12 px-4 py-20 sm:px-6 lg:flex-row lg:px-8 lg:py-32">
              <div data-reveal className="w-full lg:w-1/2 relative">
                <div className="relative aspect-[16/10] w-full border border-border/50 bg-background overflow-hidden">
                  <Image src="/landing/compare-v2.webp" alt="Comparison Mode" fill className="object-cover object-left-top" sizes="(min-width: 1024px) 50vw, 100vw" />
                  <div className="absolute inset-0 bg-background/5" />
                </div>
              </div>
              <div data-reveal className="w-full lg:w-1/2 space-y-6">
                <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">Compare versions side-by-side. End &quot;which cut is this?&quot;</h2>
                <p className="text-base text-muted-foreground md:text-lg">
                  See what actually changed between versions then approve with confidence.
                </p>
                <p className="text-xs uppercase tracking-[0.14em] text-primary">Cuts revision cycles.</p>
              </div>
            </div>
          </div>

          {/* Feature 2 */}
          <div className="border-b border-border bg-background">
            <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center justify-between gap-12 px-4 py-20 sm:px-6 lg:flex-row lg:px-8 lg:py-32">
              <div data-reveal className="w-full lg:w-1/2 space-y-6">
                <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">Explain it better with Voice.</h2>
                <p className="text-base text-muted-foreground md:text-lg">
                  No more &quot;What did you mean by this?&quot; emails. Every note lands at the exact moment in the video.
                </p>
                <p className="text-xs uppercase tracking-[0.14em] text-primary">Faster feedback. Fewer misunderstandings.</p>
              </div>
              <div data-reveal className="w-full lg:w-1/2">
                <div className="border border-border bg-card p-6">
                  <div className="border border-border/50 bg-background p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center bg-secondary font-mono text-xs">Y</div>
                        <div className="space-y-1">
                          <p className="font-mono text-[11px] font-medium leading-none">Yusuf İpek</p>
                          <p className="font-mono text-[10px] text-muted-foreground">00:03:45</p>
                        </div>
                      </div>
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
                    </div>
                    <div className="mt-6 flex h-16 items-center gap-1 overflow-hidden">
                      <button className="mr-2 flex h-8 w-8 flex-none items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90">
                        <Play className="h-3 w-3" />
                      </button>
                      {Array.from({ length: 40 }).map((_, i) => (
                        <span key={i} className="voice-bar w-full flex-1 bg-primary/60" style={{ height: `${[30, 80, 50, 90, 40, 70, 60, 45, 85, 55, 65, 35, 95, 75, 25, 40, 80, 50, 90, 30][i % 20]}%` }} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Feature 3 */}
          <div className="border-b border-border">
            <div className="mx-auto flex w-full max-w-[1200px] flex-col-reverse items-center justify-between gap-12 px-4 py-20 sm:px-6 lg:flex-row lg:px-8 lg:py-32">
              <div data-reveal className="w-full lg:w-1/2 relative aspect-video bg-card border border-border p-4">
                <div className="relative h-full w-full border border-border/50 overflow-hidden bg-background">
                  <Image src="https://images.unsplash.com/photo-1542204165-65bf26472b9b?auto=format&fit=crop&w=800&q=80" alt="Annotate" fill className="object-cover opacity-70" />
                  <svg className="absolute inset-0 h-full w-full pointer-events-none" viewBox="0 0 800 450" fill="none">
                    <circle cx="500" cy="225" r="80" stroke="#06b6d4" strokeWidth="4" className="opacity-90 drop-shadow-[0_0_8px_rgba(6,182,212,0.8)]" />
                    <path d="M500 145 Q550 80 620 120" stroke="#06b6d4" strokeWidth="4" className="opacity-90" strokeLinecap="round" />
                  </svg>

                  {/* Circle Editor UI mock */}
                  <div className="absolute top-4 left-4 border border-border/50 bg-background/90 backdrop-blur-md p-2 flex flex-col gap-2">
                    <div className="flex gap-2">
                      <div className="h-6 w-6 rounded-full bg-red-500 cursor-pointer border-2 border-transparent"></div>
                      <div className="h-6 w-6 rounded-full bg-yellow-500 cursor-pointer border-2 border-transparent"></div>
                      <div className="h-6 w-6 rounded-full bg-green-500 cursor-pointer border-2 border-transparent"></div>
                      <div className="h-6 w-6 rounded-full bg-[#06b6d4] cursor-pointer border-2 border-white"></div>
                    </div>
                    <div className="h-px w-full bg-border/50" />
                    <div className="flex gap-2">
                      <button className="flex h-8 w-8 items-center justify-center text-muted-foreground bg-primary/10 text-primary hover:bg-secondary">
                        <PenTool className="h-4 w-4" />
                      </button>
                      <button className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:bg-secondary">
                        <MoveRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div data-reveal className="w-full lg:w-1/2 space-y-6">
                <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">Point. Draw. Done.</h2>
                <p className="text-base text-muted-foreground md:text-lg">
                  Precise feedback that leaves zero room for error. Circle, sketch, and point directly on the video frame.
                </p>
                <p className="text-xs uppercase tracking-[0.14em] text-primary">Stops &quot;I thought you meant...&quot;</p>
              </div>
            </div>
          </div>
        </section>

        {/* 5) EVERYTHING YOUR TEAM EXPECTS */}
        <section className="border-b border-border px-4 py-20 sm:px-6 lg:px-8 lg:py-32 bg-background">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-12 flex flex-col items-center text-center">
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">Everything a real production workflow needs.</h2>
              <p className="mt-4 max-w-2xl text-base text-muted-foreground">The core tools teams expect without the complexity that slows clients down.</p>
            </div>

            <div className="space-y-10">
              <div>
                <p data-reveal className="mb-4 text-xs uppercase tracking-[0.14em] text-muted-foreground">Core workflow</p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {coreWorkflowFeatures.map((feat) => (
                    <div key={feat.title} data-reveal className="group border border-border bg-card p-6 transition-colors hover:border-primary/50 hover:bg-card/80">
                      <feat.icon className="mb-4 h-6 w-6 text-primary" />
                      <h3 className="mb-2 text-lg font-medium">{feat.title}</h3>
                      <p className="text-sm text-muted-foreground">{feat.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p data-reveal className="mb-4 text-xs uppercase tracking-[0.14em] text-muted-foreground">Workflow Accelerators</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {workflowAcceleratorFeatures.map((feat) => (
                    <div key={feat.title} data-reveal className="group border border-border bg-card p-6 transition-colors hover:border-primary/50 hover:bg-card/80">
                      <feat.icon className="mb-4 h-6 w-6 text-primary" />
                      <h3 className="mb-2 text-lg font-medium">{feat.title}</h3>
                      <p className="text-sm text-muted-foreground">{feat.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 6) BUILT FOR CLIENTS */}
        <section className="border-b border-border bg-card/20 px-4 py-20 sm:px-6 lg:px-8 lg:py-32">
          <div className="mx-auto flex w-full max-w-[1200px] flex-col lg:flex-row gap-12 lg:items-center">
            <div data-reveal className="lg:w-1/2 space-y-6">
              <h2 className="text-4xl font-semibold tracking-[-0.02em] md:text-5xl">Clients don&apos;t need an account. They just review.</h2>
              <p className="text-lg text-muted-foreground">If clients can&apos;t adopt the tool, approvals don&apos;t happen. OpenFrame keeps it frictionless.</p>
            </div>
            <div data-reveal className="lg:w-1/2 space-y-4">
              <div className="flex items-start gap-4 border border-border bg-background p-6 transition-transform hover:-translate-y-1">
                <LinkIcon className="mt-1 h-6 w-6 shrink-0 text-primary" />
                <div>
                  <h3 className="text-lg font-semibold">One link. Review in the browser.</h3>
                </div>
              </div>
              <div className="flex items-start gap-4 border border-border bg-background p-6 transition-transform hover:-translate-y-1">
                <Smartphone className="mt-1 h-6 w-6 shrink-0 text-primary" />
                <div>
                  <h3 className="text-lg font-semibold">Works great on mobile.</h3>
                </div>
              </div>
              <div className="flex items-start gap-4 border border-border bg-background p-6 transition-transform hover:-translate-y-1">
                <MessageSquare className="mt-1 h-6 w-6 shrink-0 text-primary" />
                <div>
                  <h3 className="text-lg font-semibold">Timestamped notes that are impossible to miss.</h3>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 7) PRICING */}
        <section id="pricing" className="border-b border-border bg-[#0a0a0a] px-4 py-20 sm:px-6 lg:px-8 lg:py-32">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-16">
              <h2 className="text-3xl font-semibold md:text-5xl text-foreground" style={{ fontFamily: 'monospace', letterSpacing: '-0.02em' }}>
                Deploy it yourself - or let us run it for you.
              </h2>
            </div>

            <div className="grid gap-6 md:grid-cols-3">
              {/* Card 1: Open Source */}
              <div data-reveal className="relative flex flex-col border border-border/40 bg-[#141414] p-8">
                <div className="mb-6">
                  <h3 className="text-xl font-semibold text-foreground">Open Source (Self-hosted)</h3>
                </div>

                <div className="mb-8 flex items-baseline gap-2">
                  <span className="text-3xl font-semibold text-[#06b6d4]">Free</span>
                </div>
                <p className="mb-8 text-sm text-muted-foreground">For teams who want full control and can run their own infrastructure.</p>

                <ul className="mb-8 flex-1 space-y-4 text-sm text-foreground/80">
                  <li className="flex items-center gap-3"><CheckSquare className="h-4 w-4 text-[#06b6d4]" />Full codebase access</li>
                  <li className="flex items-center gap-3"><CheckSquare className="h-4 w-4 text-[#06b6d4]" />Self-hosted infrastructure control</li>
                  <li className="flex items-center gap-3"><CheckSquare className="h-4 w-4 text-[#06b6d4]" />Manual update cadence</li>
                </ul>

                <a href="https://github.com/yusufipk/OpenFrame" target="_blank" rel="noreferrer" className="mt-auto group relative isolate inline-flex h-12 w-full items-center justify-center overflow-hidden border border-border/50 bg-[#0a0a0a] font-medium text-foreground transition-colors hover:bg-white/5 text-sm">
                  <Github className="mr-2 h-4 w-4" /> View on GitHub
                </a>
              </div>

              {/* Card 2: Hosted Cloud */}
              <div data-reveal className="relative flex flex-col border border-[#06b6d4]/40 bg-[#141414] p-8">
                <div className="mb-6">
                  <p className="font-mono text-[10px] uppercase font-semibold text-muted-foreground tracking-widest mb-4">Best for teams who want zero setup.</p>
                  <h3 className="text-xl font-semibold text-foreground">Hosted Cloud</h3>
                </div>

                <div className="mb-6 flex items-baseline gap-2">
                  <span className="text-3xl font-semibold text-[#06b6d4]">$10</span>
                  <span className="text-[#06b6d4]">/ month</span>
                </div>

                <ul className="mb-8 flex-1 space-y-4 text-sm text-foreground/80">
                  <li className="flex items-start gap-3"><CheckSquare className="mt-0.5 shrink-0 h-4 w-4 text-[#06b6d4]" /><span>Unlimited collaborators</span></li>
                  <li className="flex items-start gap-3"><CheckSquare className="mt-0.5 shrink-0 h-4 w-4 text-[#06b6d4]" /><span>Timestamped comments + voice notes</span></li>
                  <li className="flex items-start gap-3"><CheckSquare className="mt-0.5 shrink-0 h-4 w-4 text-[#06b6d4]" /><span>Annotations + version compare</span></li>
                  <li className="flex items-start gap-3"><CheckSquare className="mt-0.5 shrink-0 h-4 w-4 text-[#06b6d4]" /><span>Share links with permissions</span></li>
                  <li className="flex items-start gap-3"><CheckSquare className="mt-0.5 shrink-0 h-4 w-4 text-[#06b6d4]" /><span>Exports (PDF/CSV)</span></li>
                  <li className="flex items-start gap-3"><CheckSquare className="mt-0.5 shrink-0 h-4 w-4 text-[#06b6d4]" /><span>Unlimited YouTube Video Imports</span></li>
                  <li className="flex items-start gap-3"><CheckSquare className="mt-0.5 shrink-0 h-4 w-4 text-[#06b6d4]" /><span>Includes: 200 GB Storage</span></li>
                </ul>
                <p className="mb-8 text-sm text-muted-foreground">Need more storage? Add 100 GB for $5/mo.</p>

                <Link href={hostedCtaHref} className="mt-auto group relative isolate inline-flex h-12 w-full items-center justify-center overflow-hidden bg-[#06b6d4] font-medium text-black transition-colors hover:bg-[#06b6d4]/90 text-sm">
                  Start free
                </Link>
              </div>

              {/* Card 3: Studio & Agency */}
              <div data-reveal className="relative flex flex-col border border-border/40 bg-[#141414] p-8">
                <div className="mb-6">
                  <h3 className="text-xl font-semibold text-foreground">Need more than the standard limits?</h3>
                </div>
                <div className="mb-6 flex items-baseline gap-2">
                  <span className="text-3xl font-semibold text-[#06b6d4]">Let&apos;s talk</span>
                </div>

                <p className="mb-8 text-sm text-foreground/80 leading-relaxed">
                  Custom capacity and setup help for high-volume production teams. Tell us your storage, usage, and workflow - we&apos;ll recommend the right approach.
                </p>

                <a href="mailto:support@openframe.com" className="group relative isolate inline-flex h-12 w-full items-center justify-center overflow-hidden bg-[#0a0a0a] font-medium text-foreground transition-colors hover:bg-white/5 border border-border/50 text-sm">
                  Contact us
                </a>
              </div>

            </div>
          </div>
        </section>

        {/* 8) SECURITY & PRIVACY */}
        <section className="border-b border-border bg-background px-4 py-20 sm:px-6 lg:px-8 lg:py-24">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mx-auto max-w-4xl">
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">Security & privacy, by design.</h2>
              <ul className="mt-8 space-y-4 text-base text-muted-foreground md:text-lg">
                <li>- Permissioned share links (control who can view/comment)</li>
                <li>- Private-by-default projects</li>
                <li>- Delete videos and projects anytime</li>
                <li>- Self-host option for full data control</li>
              </ul>
            </div>
          </div>
        </section>

        {/* 9) FAQ */}
        <section className="border-b border-border bg-card/10 px-4 py-20 sm:px-6 lg:px-8 lg:py-24">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mx-auto max-w-4xl">
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">FAQ</h2>
              <div className="mt-10 space-y-4">
                {[
                  {
                    q: 'Do clients need an account?',
                    a: 'No. They can review in the browser with a share link.',
                  },
                  {
                    q: 'What happens if I exceed my storage?',
                    a: 'You can add 100 GB for $5/mo. If you need much more, contact us and we’ll help you choose the best setup.',
                  },
                  {
                    q: 'How is YouTube unlimited?',
                    a: 'There is no storage limit on YouTube imports. You can import an unlimited amount of unlisted YouTube videos and use all of our review features exactly the same.',
                  },
                  {
                    q: 'Can I self-host?',
                    a: 'Yes. The core is open-source and self-hostable. Hosted Cloud is for teams who want zero setup.',
                  },
                  {
                    q: 'How is this different from sending a Google Drive link?',
                    a: 'Drive doesn’t give timestamped discussion, voice notes, annotations, or version compare, which is where approval time is actually saved.',
                  },
                  {
                    q: 'Is it mobile-friendly?',
                    a: 'Yes. Clients can review and comment from mobile.',
                  },
                  {
                    q: 'Can I export feedback?',
                    a: 'Yes. Export to PDF/CSV for archiving or client handoff.',
                  },
                  {
                    q: 'Who can access my videos?',
                    a: 'Only people you invite or share a link with (based on permissions you set).',
                  },
                  {
                    q: 'Can I cancel anytime?',
                    a: 'Yes. Cancel anytime from your billing settings.',
                  },
                ].map((item) => (
                  <div key={item.q} className="border border-border bg-background p-6">
                    <h3 className="text-lg font-semibold">{item.q}</h3>
                    <p className="mt-2 text-sm text-muted-foreground md:text-base">{item.a}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 10) FINAL CTA STRIP */}
        <section className="border-b border-border bg-background px-4 py-16 sm:px-6 lg:px-8">
          <div data-reveal className="mx-auto flex w-full max-w-[1200px] flex-col items-center justify-between gap-4 text-center md:flex-row md:text-left">
            <div>
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-4xl">Stop chasing feedback. Start getting approvals.</h2>
              <p className="mt-2 text-sm text-muted-foreground">Your first review link takes minutes.</p>
            </div>
            <Link
              href={hostedCtaHref}
              className="group relative isolate inline-flex h-12 min-w-max items-center justify-center overflow-hidden border border-primary bg-primary px-10 text-sm font-medium whitespace-nowrap text-primary-foreground transition-transform duration-300 hover:scale-[1.02] md:min-w-[240px]"
            >
              Start free
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-background px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <Video className="h-4 w-4 text-primary" />
            <span className="font-mono text-xs text-muted-foreground">© {new Date().getFullYear()} OpenFrame.</span>
          </div>
          <div className="flex gap-4">
            <a href="https://github.com/yusufipk/OpenFrame" className="text-xs text-muted-foreground hover:text-foreground">GitHub</a>
            <a href="https://x.com/yusufipk" className="text-xs text-muted-foreground hover:text-foreground">X (Twitter)</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
