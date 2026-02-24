'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import {
  CheckSquare,
  Clock3,
  FileVideo,
  GitBranch,
  Github,
  GitMerge,
  Grid3X3,
  Layers3,
  MessageSquare,
  MessageSquareDot,
  Mic,
  MoveRight,
  PenTool,
  Play,
  Upload,
  Video,
  Waves,
} from 'lucide-react';

interface LandingPageProps {
  isLoggedIn: boolean;
}

const controlButtonClass =
  'group relative isolate inline-flex h-8 items-center justify-center overflow-hidden border border-border bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors duration-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-9 sm:px-4 sm:text-xs';

const primaryButtonClass =
  'group relative isolate inline-flex h-10 items-center justify-center overflow-hidden border border-primary bg-primary px-4 text-[11px] font-medium text-primary-foreground transition-transform duration-300 hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-11 sm:px-5 sm:text-xs';

const secondaryButtonClass =
  'group relative isolate inline-flex h-10 items-center justify-center overflow-hidden border border-border bg-background px-4 text-[11px] font-medium text-foreground transition-colors duration-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-11 sm:px-5 sm:text-xs';

const workflowProofItems = [
  {
    step: '01',
    title: 'Upload Or Import',
    description: 'Drop MP4 files or import YouTube links into one project timeline.',
    kind: 'upload',
  },
  {
    step: '02',
    title: 'Comment At Timestamp',
    description: 'Text and voice notes are attached to exact moments on the timeline.',
    kind: 'comment',
  },
  {
    step: '03',
    title: 'Ship Next Version',
    description: 'Upload a new cut while preserving feedback history and review context.',
    kind: 'version',
  },
] as const;

const useCaseRails = [
  {
    title: 'Agency Teams',
    label: 'CLIENT REVIEW',
    description: 'Share guest links and collect timestamped approvals without account friction.',
    image:
      'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=1200&q=80',
  },
  {
    title: 'Solo Editors',
    label: 'PERSONAL QC',
    description: 'Freelance editors can share review links with clients and close notes without account friction.',
    image:
      'https://images.unsplash.com/photo-1627244714766-94dab62ed964?q=80&w=765&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
  },
  {
    title: 'Internal Teams',
    label: 'CAMPAIGN OPS',
    description: 'Coordinate editors, PMs, and stakeholders across one shared workspace.',
    image:
      'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=1200&q=80',
  },
] as const;

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `00:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function LandingPage({ isLoggedIn }: LandingPageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navbarRef = useRef<HTMLElement | null>(null);
  const timelineCounterRef = useRef<HTMLSpanElement | null>(null);
  const heroAnnotationCircleRef = useRef<SVGCircleElement | null>(null);
  const featureAnnotationCircleRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => {
    const cleanupHandlers: Array<() => void> = [];

    const ctx = gsap.context(() => {
      gsap.from('[data-hero-copy]', {
        y: 30,
        opacity: 0,
        duration: 0.9,
        stagger: 0.12,
        ease: 'power3.out',
      });

      gsap.from('[data-reveal]', {
        y: 24,
        opacity: 0,
        duration: 0.8,
        stagger: 0.08,
        ease: 'power3.out',
      });

      gsap.to('.hero-float-card', {
        y: -14,
        duration: 2.6,
        stagger: 0.2,
        yoyo: true,
        repeat: -1,
        ease: 'power3.out',
      });

      const timelineCounter = timelineCounterRef.current;

      if (timelineCounter) {
        const playhead = { seconds: 83 };

        gsap.to(playhead, {
          seconds: 224,
          duration: 12,
          repeat: -1,
          ease: 'none',
          onUpdate: () => {
            timelineCounter.textContent = formatTime(Math.floor(playhead.seconds));
          },
        });
      }

      const timelineDrops = gsap.utils.toArray<HTMLElement>('.timeline-drop');

      timelineDrops.forEach((drop, index) => {
        const timeline = gsap.timeline({ repeat: -1, delay: index * 0.35 });

        timeline
          .fromTo(
            drop,
            { y: -18, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.8, ease: 'power3.out' }
          )
          .to(drop, { opacity: 0, duration: 0.35, ease: 'power3.out' }, '+=0.5');
      });

      const waveformBars = gsap.utils.toArray<HTMLElement>('.voice-bar');

      waveformBars.forEach((bar, index) => {
        gsap.set(bar, { transformOrigin: 'center bottom' });
        gsap.to(bar, {
          scaleY: gsap.utils.random(0.35, 1.45),
          duration: gsap.utils.random(0.45, 0.9),
          repeat: -1,
          yoyo: true,
          delay: index * 0.03,
          ease: 'power3.out',
        });
      });

      gsap.fromTo(
        '.voice-scan',
        { width: '0%' },
        {
          width: '100%',
          duration: 2.4,
          repeat: -1,
          yoyo: true,
          ease: 'power3.out',
        }
      );

      const animateStroke = (shape: SVGCircleElement | null, duration: number) => {
        if (!shape) return;

        const shapeLength = shape.getTotalLength();

        gsap.set(shape, {
          strokeDasharray: shapeLength,
          strokeDashoffset: shapeLength,
        });

        gsap.to(shape, {
          strokeDashoffset: 0,
          duration,
          repeat: -1,
          yoyo: true,
          repeatDelay: 0.6,
          ease: 'power3.out',
        });
      };

      animateStroke(heroAnnotationCircleRef.current, 2.4);
      animateStroke(featureAnnotationCircleRef.current, 2.1);

      const nav = navbarRef.current;

      if (nav) {
        const updateNavbar = () => {
          const hasScrolled = window.scrollY > 12;

          gsap.to(nav, {
            backgroundColor: hasScrolled
              ? 'color-mix(in oklab, var(--background) 80%, transparent)'
              : 'transparent',
            backdropFilter: hasScrolled ? 'blur(12px)' : 'blur(0px)',
            duration: 0.3,
            overwrite: 'auto',
            ease: 'power3.out',
          });
        };

        updateNavbar();
        window.addEventListener('scroll', updateNavbar, { passive: true });
        cleanupHandlers.push(() => window.removeEventListener('scroll', updateNavbar));
      }

      const magneticItems = gsap.utils.toArray<HTMLElement>('[data-magnetic]');

      magneticItems.forEach((item) => {
        const xTo = gsap.quickTo(item, 'x', { duration: 0.35, ease: 'power3.out' });
        const yTo = gsap.quickTo(item, 'y', { duration: 0.35, ease: 'power3.out' });

        const onMove = (event: MouseEvent) => {
          const bounds = item.getBoundingClientRect();
          const x = event.clientX - (bounds.left + bounds.width / 2);
          const y = event.clientY - (bounds.top + bounds.height / 2);

          xTo((x / bounds.width) * 10);
          yTo((y / bounds.height) * 10);
        };

        const onLeave = () => {
          xTo(0);
          yTo(0);
        };

        item.addEventListener('mousemove', onMove);
        item.addEventListener('mouseleave', onLeave);

        cleanupHandlers.push(() => {
          item.removeEventListener('mousemove', onMove);
          item.removeEventListener('mouseleave', onLeave);
        });
      });
    }, rootRef);

    return () => {
      cleanupHandlers.forEach((cleanup) => cleanup());
      ctx.revert();
    };
  }, []);

  return (
    <div ref={rootRef} className="min-h-screen overflow-x-hidden bg-background text-foreground font-sans selection:bg-primary/20">
      <header ref={navbarRef} className="fixed inset-x-0 top-0 z-50 border-b border-border bg-transparent">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between px-4 sm:h-16 sm:px-6 lg:px-10">
          <Link
            href="/"
            data-magnetic
            className="group relative isolate inline-flex items-center gap-2 overflow-hidden border border-border bg-background px-3 py-2"
          >
            <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
            <Video className="relative z-10 h-4 w-4 text-primary" />
            <span className="relative z-10 text-xs font-semibold tracking-[0.12em]">OPENFRAME</span>
          </Link>

          <nav className="hidden items-center gap-6 text-xs font-medium uppercase tracking-[0.14em] md:flex">
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="#features">
              Features
            </Link>
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="#pricing">
              Pricing
            </Link>
          </nav>

          <div className="flex items-center gap-1.5 sm:gap-2">
            {isLoggedIn ? (
              <>
                <Link href="/dashboard" data-magnetic className={controlButtonClass}>
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10 inline-flex items-center gap-1.5 sm:gap-2">
                    <span className="sm:hidden">Dashboard</span>
                    <span className="hidden sm:inline">Go to Dashboard</span>
                    <MoveRight className="h-3.5 w-3.5" />
                  </span>
                </Link>
                <div className="hidden sm:block">
                  <Link href="/dashboard" data-magnetic className={controlButtonClass}>
                    <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                    <span className="relative z-10">Workspace</span>
                  </Link>
                </div>
              </>
            ) : (
              <>
                <Link href="/login" data-magnetic className={controlButtonClass}>
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10">Login</span>
                </Link>
                <div className="hidden sm:block">
                  <Link href="/register" data-magnetic className={controlButtonClass}>
                    <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                    <span className="relative z-10">Get Started</span>
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="relative">
        <section className="min-h-screen border-b border-border px-4 pb-20 pt-24 sm:px-6 sm:pb-24 sm:pt-28 lg:pt-32">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background via-background to-secondary/40" />
          <div className="relative mx-auto grid min-h-[calc(100vh-8rem)] w-full max-w-[1200px] items-center gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
            <div className="space-y-7">
              <p data-hero-copy className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                OPEN SOURCE VIDEO REVIEW TOOL
              </p>
              <h1 data-hero-copy className="max-w-2xl text-4xl font-semibold leading-[1.03] tracking-[-0.03em] sm:text-5xl md:text-8xl">
                Review Video. Without the Chaos.
              </h1>
              <p data-hero-copy className="max-w-xl text-base text-muted-foreground md:text-xl">
                Timestamped text, voice feedback, and version control for modern creative teams.
              </p>

              <div data-hero-copy className="flex flex-col gap-3 sm:flex-row">
                <Link
                  href={isLoggedIn ? '/dashboard' : '/register'}
                  data-magnetic
                  className={primaryButtonClass}
                >
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary-foreground/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10 inline-flex items-center gap-2">
                    Start using OpenFrame
                    <MoveRight className="h-4 w-4" />
                  </span>
                </Link>
                <a
                  href="https://github.com/yusufipk/OpenFrame"
                  target="_blank"
                  rel="noreferrer"
                  data-magnetic
                  className={secondaryButtonClass}
                >
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10 inline-flex items-center gap-2">
                    <Github className="h-4 w-4" />
                    GitHub Repo
                  </span>
                </a>
              </div>
            </div>

            <div data-hero-copy className="relative">
              <div className="relative border border-border bg-card p-3">
                <div className="mb-3 flex items-center justify-between border border-border/50 bg-background px-3 py-2">
                  <div className="inline-flex items-center gap-2 text-xs">
                    <Play className="h-3.5 w-3.5 text-primary" />
                    <span className="font-mono text-muted-foreground">PLAYHEAD 00:02:14</span>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">v2.3.1</span>
                </div>

                <div className="relative aspect-[16/10] overflow-hidden border border-border/50 bg-background">
                  <Image
                    src="https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=80"
                    alt="Annotated video frame preview"
                    fill
                    className="object-cover opacity-75"
                    sizes="(min-width: 1024px) 50vw, 100vw"
                    priority
                  />
                  <div className="absolute inset-0 bg-gradient-to-b from-background/20 via-background/5 to-background/35" />

                  <svg className="pointer-events-none absolute inset-0" viewBox="0 0 640 400" fill="none">
                    <circle
                      ref={heroAnnotationCircleRef}
                      cx="462"
                      cy="198"
                      r="88"
                      stroke="currentColor"
                      strokeWidth="4"
                      className="text-primary"
                      fill="none"
                    />
                  </svg>

                  <div className="absolute left-4 top-4 border border-border/70 bg-popover px-3 py-2 text-xs">
                    <p className="font-mono text-muted-foreground">ANNOTATION</p>
                    <p className="mt-1">Focus this subject isolation for scene 04.</p>
                  </div>
                </div>
              </div>

              <div className="hero-float-card absolute -left-7 top-8 hidden border border-border bg-popover px-4 py-3 shadow-sm sm:block">
                <div className="flex items-center gap-2 text-xs">
                  <MessageSquare className="h-3.5 w-3.5 text-primary" />
                  <span className="font-mono text-muted-foreground">00:01:23</span>
                </div>
                <p className="mt-2 text-xs">Re-time this beat hit by 4 frames.</p>
              </div>

              <div className="hero-float-card absolute -right-5 bottom-6 hidden border border-border bg-popover px-4 py-3 shadow-sm sm:block">
                <div className="flex items-center gap-2 text-xs">
                  <Mic className="h-3.5 w-3.5 text-primary" />
                  <span className="font-mono text-muted-foreground">Voice Note</span>
                </div>
                <p className="mt-2 text-xs">Transition pacing reads cleaner in this cut.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="scroll-mt-20 border-b border-border px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-10 flex flex-col gap-4">
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">
                Fast, precise collaborative video review.
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Guest commenting via shareable links and workspace-level permissions are available on every project.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:auto-rows-[minmax(180px,auto)]">
              <article data-reveal className="border border-border bg-card p-4 sm:p-6 md:col-span-7">
                <div className="mb-5 flex items-center justify-between">
                  <div className="inline-flex items-center gap-2">
                    <Clock3 className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">The Timeline</h3>
                  </div>
                  <span ref={timelineCounterRef} className="font-mono text-xs text-primary">
                    00:01:23
                  </span>
                </div>
                <p className="max-w-md text-sm text-muted-foreground">
                  Comments attach to exact timestamps so every request references the exact moment on the video.
                </p>

                <div className="mt-6 border border-border/50 bg-background p-4">
                  <div className="mb-3 flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                    <span>SEQUENCE.A / MASTER CUT</span>
                    <span>24 FPS</span>
                  </div>
                  <div className="relative h-20 border border-border/50 bg-card">
                    <div className="absolute left-4 right-4 top-1/2 h-px -translate-y-1/2 bg-border" />
                    <div className="absolute left-[14%] top-1/2 h-3 w-px -translate-y-1/2 bg-border" />
                    <div className="absolute left-[38%] top-1/2 h-3 w-px -translate-y-1/2 bg-border" />
                    <div className="absolute left-[64%] top-1/2 h-3 w-px -translate-y-1/2 bg-border" />
                    <div className="absolute left-[88%] top-1/2 h-3 w-px -translate-y-1/2 bg-border" />

                    <div className="timeline-drop absolute left-[22%] top-1.5 flex flex-col items-center gap-1">
                      <span className="font-mono text-[10px] text-primary">00:00:23</span>
                      <span className="h-4 w-px bg-primary" />
                    </div>
                    <div className="timeline-drop absolute left-[46%] top-1.5 flex flex-col items-center gap-1">
                      <span className="font-mono text-[10px] text-primary">00:00:52</span>
                      <span className="h-4 w-px bg-primary" />
                    </div>
                    <div className="timeline-drop absolute left-[74%] top-1.5 flex flex-col items-center gap-1">
                      <span className="font-mono text-[10px] text-primary">00:01:34</span>
                      <span className="h-4 w-px bg-primary" />
                    </div>
                  </div>
                </div>
              </article>

              <article data-reveal className="border border-border bg-card p-4 sm:p-6 md:col-span-5">
                <div className="mb-4 inline-flex items-center gap-2">
                  <Waves className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Voice Notes</h3>
                </div>
                <p className="mb-5 text-sm text-muted-foreground">
                  Record a voice note at any timestamp. Teammates play it back in context.
                </p>
                <div className="border border-border/50 bg-background p-4">
                  <div className="mb-3 inline-flex items-center gap-2 border border-border/50 bg-card px-3 py-1.5 text-[11px]">
                    <span className="h-1.5 w-1.5 animate-pulse bg-primary" />
                    <span className="font-mono text-muted-foreground">REC 00:00:12</span>
                  </div>
                  <div className="relative overflow-hidden border border-border/50 bg-card px-3 py-4">
                    <div className="voice-scan pointer-events-none absolute inset-y-0 left-0 bg-primary/10" />
                    <div className="relative flex h-12 items-end gap-1">
                      {Array.from({ length: 22 }).map((_, index) => (
                        <span key={index} className="voice-bar h-full w-full bg-primary/80" />
                      ))}
                    </div>
                  </div>
                  <p className="mt-3 font-mono text-[11px] text-muted-foreground">MIC-01 / SAVED TO 00:01:23</p>
                </div>
              </article>

              <article data-reveal className="border border-border bg-card p-4 sm:p-6 md:col-span-5">
                <div className="mb-4 inline-flex items-center gap-2">
                  <Layers3 className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Version Management</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Upload multiple cuts under one video and keep each version named and ordered.
                </p>

                <div className="mt-6 border border-border/50 bg-background p-3">
                  <div className="version-row flex items-center justify-between border border-border/50 bg-card px-3 py-2 text-xs">
                    <span className="inline-flex items-center gap-2">
                      <FileVideo className="h-3.5 w-3.5 text-primary" />
                      <span className="font-mono">v1.0.0 - rough-cut</span>
                    </span>
                    <span className="text-muted-foreground">Archived</span>
                  </div>
                  <div className="version-row mt-2 flex items-center justify-between border border-border/50 bg-card px-3 py-2 text-xs">
                    <span className="inline-flex items-center gap-2">
                      <FileVideo className="h-3.5 w-3.5 text-primary" />
                      <span className="font-mono">v1.0.1 - client-notes</span>
                    </span>
                    <span className="text-muted-foreground">Previous</span>
                  </div>
                  <div className="version-row mt-2 flex items-center justify-between border border-primary/40 bg-secondary px-3 py-2 text-xs">
                    <span className="inline-flex items-center gap-2">
                      <FileVideo className="h-3.5 w-3.5 text-primary" />
                      <span className="font-mono">v1.0.2 - current</span>
                    </span>
                    <span className="text-primary">Active</span>
                  </div>
                </div>

                <div className="mt-4 inline-flex items-center gap-2 border border-border/50 bg-background px-3 py-2 text-xs">
                  <Upload className="h-4 w-4 text-primary" />
                  <span className="font-mono text-muted-foreground">Upload New Version</span>
                </div>
              </article>

              <article data-reveal className="border border-border bg-card p-4 sm:p-6 md:col-span-7">
                <div className="mb-4 inline-flex items-center gap-2">
                  <PenTool className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Drawing & Annotation</h3>
                </div>
                <p className="mb-5 text-sm text-muted-foreground">
                  Draw directly on the video image to point at exact areas during review.
                </p>

                <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
                  <div className="relative aspect-[16/7] overflow-hidden border border-border/50 bg-background">
                    <Image
                      src="https://images.unsplash.com/photo-1516724562728-afc824a36e84?auto=format&fit=crop&w=1200&q=80"
                      alt="Video frame with annotation overlay"
                      fill
                      className="object-cover opacity-80"
                      sizes="(min-width: 1024px) 45vw, 100vw"
                    />
                    <div className="absolute inset-0 bg-background/20" />
                    <svg className="pointer-events-none absolute inset-0" viewBox="0 0 640 280" fill="none">
                      <circle
                        ref={featureAnnotationCircleRef}
                        cx="208"
                        cy="142"
                        r="58"
                        stroke="currentColor"
                        strokeWidth="4"
                        className="text-primary"
                        fill="none"
                      />
                    </svg>
                  </div>
                  <div className="flex items-center border border-border/50 bg-background px-4 py-3 text-xs">
                    <span className="font-mono text-muted-foreground">DRAW ON FRAME / SAVE WITH COMMENT</span>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="border-b border-border px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-10 space-y-4">
              <h2 className="max-w-3xl text-3xl font-semibold tracking-[-0.02em] md:text-5xl">
                Upload. Review. Version. In one continuous loop.
              </h2>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              {workflowProofItems.map((item) => (
                <article key={item.step} data-reveal className="border border-border bg-card p-4">
                  <div className="relative mb-4 aspect-[4/3] border border-border/50 bg-background p-3 sm:aspect-[16/10]">
                    {item.kind === 'upload' && (
                      <div className="h-full border border-border/50 bg-card p-3">
                        <div className="mb-2 flex items-center text-[11px]">
                          <p className="inline-flex items-center gap-1.5 font-mono text-muted-foreground">
                            <Upload className="h-3.5 w-3.5 text-primary" />
                            Add Source
                          </p>
                        </div>
                        <div className="mb-2 flex gap-2 text-[10px]">
                          <span className="flex-1 border border-primary/40 bg-secondary px-2 py-1 font-mono text-primary">Paste URL</span>
                          <span className="flex-1 border border-border/50 bg-background px-2 py-1 font-mono text-muted-foreground">Direct Upload</span>
                        </div>
                        <div className="space-y-1.5 text-[10px]">
                          <div className="truncate border border-border/50 bg-background px-2 py-1 font-mono text-muted-foreground">https://youtube.com/watch?v=...</div>
                          <div className="border border-border/50 bg-background px-2 py-1 font-mono text-muted-foreground">Video title (optional)</div>
                          <div className="h-8 border border-border/50 bg-background px-2 py-1 font-mono text-muted-foreground">Description (optional)</div>
                        </div>
                        <div className="mt-1 flex justify-end">
                          <span className="shrink-0 border border-primary/40 bg-secondary px-2 py-1 font-mono text-[10px] text-primary">
                            Add Video
                          </span>
                        </div>
                      </div>
                    )}

                    {item.kind === 'comment' && (
                      <div className="h-full border border-border/50 bg-card p-3">
                        <div className="mb-3 flex items-center justify-between">
                          <div className="inline-flex items-center gap-2">
                            <span className="inline-flex h-5 w-5 items-center justify-center border border-primary/40 bg-secondary font-mono text-[10px] text-primary">
                              Y
                            </span>
                            <span className="font-mono text-[11px]">Yusuf İpek</span>
                          </div>
                          <span className="font-mono text-[10px] text-muted-foreground">00:04:14</span>
                        </div>
                        <p className="font-mono text-xs leading-relaxed text-foreground/90">
                          wrong tweet here&apos;s what you should use:
                        </p>
                        <p className="mt-1 truncate font-mono text-xs text-primary">https://x.com/...</p>
                        <div className="mt-3 flex items-center justify-between text-[10px]">
                          <span className="font-mono text-muted-foreground">2/21/2026</span>
                          <span className="border border-primary/40 bg-secondary px-2 py-1 font-mono text-primary">Feedback</span>
                        </div>
                        <div className="mt-3 border border-border/50 bg-background px-2 py-1 text-[10px] font-mono text-muted-foreground">
                          ↩ Reply
                        </div>
                      </div>
                    )}

                    {item.kind === 'version' && (
                      <div className="h-full border border-border/50 bg-card p-3">
                        <div className="mb-3 flex items-center justify-between text-[11px]">
                          <p className="inline-flex items-center gap-1.5 font-mono text-muted-foreground">
                            <FileVideo className="h-3.5 w-3.5 text-primary" />
                            New Version
                          </p>
                          <p className="font-mono text-muted-foreground">v1.0.3</p>
                        </div>
                        <div className="mb-2 flex gap-2 text-[10px]">
                          <span className="flex-1 border border-primary/40 bg-secondary px-2 py-1 font-mono text-primary">Link URL</span>
                          <span className="flex-1 border border-border/50 bg-background px-2 py-1 font-mono text-muted-foreground">Upload File</span>
                        </div>
                        <div className="space-y-2 text-[10px]">
                          <div className="border border-border/50 bg-background px-2 py-1 font-mono text-muted-foreground">Video URL</div>
                          <div className="border border-border/50 bg-background px-2 py-1 font-mono text-muted-foreground">Version Label</div>
                        </div>
                        <div className="mt-3 flex justify-end">
                          <span className="border border-primary/40 bg-secondary px-2 py-1 text-[10px] font-mono text-primary">Ship Version</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <p className="font-mono text-[11px] text-primary">{item.step}</p>
                    <h3 className="text-base font-semibold">{item.title}</h3>
                    <p className="text-sm text-muted-foreground">{item.description}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-border px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-10 space-y-4">
              <h2 className="max-w-3xl text-3xl font-semibold tracking-[-0.02em] md:text-5xl">
                One screen. Full review context.
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                This panel maps exactly where timestamp comments, voice notes, and frame annotation live.
              </p>
            </div>

            <div data-reveal className="relative border border-border bg-card p-4 lg:p-6">
              <div className="relative aspect-[1888/1048] overflow-hidden border border-border/50 bg-background">
                <Image
                  src="/landing/deep-dive-dashboard.webp"
                  alt="OpenFrame dashboard deep dive screenshot"
                  fill
                  className="object-contain opacity-100"
                  sizes="100vw"
                />
                <div className="absolute inset-0 bg-background/10" />
              </div>

              <div className="mt-4 grid gap-2 md:grid-cols-3">
                <div className="border border-border/50 bg-background px-3 py-2 text-xs">
                  <p className="inline-flex items-center gap-2 font-mono text-muted-foreground">
                    <MessageSquareDot className="h-3.5 w-3.5 text-primary" />
                    Timestamp Comments
                  </p>
                  <p className="mt-1 text-muted-foreground">Attached to exact timeline positions.</p>
                </div>
                <div className="border border-border/50 bg-background px-3 py-2 text-xs">
                  <p className="inline-flex items-center gap-2 font-mono text-muted-foreground">
                    <Mic className="h-3.5 w-3.5 text-primary" />
                    Voice Notes
                  </p>
                  <p className="mt-1 text-muted-foreground">Captured in context, played back in thread.</p>
                </div>
                <div className="border border-border/50 bg-background px-3 py-2 text-xs">
                  <p className="inline-flex items-center gap-2 font-mono text-muted-foreground">
                    <PenTool className="h-3.5 w-3.5 text-primary" />
                    Frame Annotation
                  </p>
                  <p className="mt-1 text-muted-foreground">Circle and draw directly on the frame.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-border px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-10 space-y-4">
              <h2 className="max-w-3xl text-3xl font-semibold tracking-[-0.02em] md:text-5xl">
                Sync 2-4 videos and compare cuts in real time.
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Play multiple versions side-by-side with synchronized playback to validate pacing, edit decisions, and grading changes.
              </p>
            </div>

            <article data-reveal className="border border-border bg-card p-4 lg:p-6">
              <div className="relative aspect-[1888/1048] overflow-hidden border border-border/50 bg-background">
                <Image
                  src="/landing/compare-v2.webp"
                  alt="OpenFrame compare mode screenshot"
                  fill
                  className="object-contain opacity-100"
                  sizes="100vw"
                />
                <div className="absolute inset-0 bg-background/10" />
              </div>

              <div className="mt-4 grid gap-2 md:grid-cols-3">
                <div className="border border-border/50 bg-background px-3 py-2 text-xs">
                  <p className="inline-flex items-center gap-2 font-mono text-muted-foreground">
                    <GitMerge className="h-3.5 w-3.5 text-primary" />
                    2-4 Video Panels
                  </p>
                  <p className="mt-1 text-muted-foreground">Load multiple versions into one comparison view.</p>
                </div>
                <div className="border border-border/50 bg-background px-3 py-2 text-xs">
                  <p className="inline-flex items-center gap-2 font-mono text-muted-foreground">
                    <Play className="h-3.5 w-3.5 text-primary" />
                    Synchronized Playback
                  </p>
                  <p className="mt-1 text-muted-foreground">Play, pause, and scrub all panels at once.</p>
                </div>
                <div className="border border-border/50 bg-background px-3 py-2 text-xs">
                  <p className="inline-flex items-center gap-2 font-mono text-muted-foreground">
                    <MessageSquareDot className="h-3.5 w-3.5 text-primary" />
                    Compare Feedback Impact
                  </p>
                  <p className="mt-1 text-muted-foreground">Confirm that requested changes are visible across versions.</p>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className="border-b border-border px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-10 space-y-4">
              <h2 className="max-w-3xl text-3xl font-semibold tracking-[-0.02em] md:text-5xl">
                Built for agencies, solo editors, and internal teams.
              </h2>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              {useCaseRails.map((item) => (
                <article key={item.title} data-reveal className="border border-border bg-card p-4">
                  <div className="relative mb-4 aspect-[16/10] overflow-hidden border border-border/50 bg-background">
                    <Image src={item.image} alt={`${item.title} screenshot`} fill className="object-cover opacity-90" sizes="(min-width: 1024px) 33vw, 100vw" />
                    <div className="absolute inset-0 bg-background/15" />
                  </div>

                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{item.label}</p>
                  <h3 className="mt-2 text-base font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{item.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="scroll-mt-20 border-b border-border px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
          <div className="mx-auto w-full max-w-[1200px]">
            <div data-reveal className="mb-10 space-y-4">
              <h2 className="text-3xl font-semibold tracking-[-0.02em] md:text-5xl">Deploy it yourself - or let us run it for you.</h2>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <article data-reveal className="flex h-full flex-col border border-border bg-card p-7">
                <div className="mb-8 space-y-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">For the builders.</p>
                  <h3 className="text-2xl font-semibold">Open Source (Self-Hosted)</h3>
                  <p className="font-mono text-3xl text-primary">Free / OSS</p>
                </div>

                <ul className="mb-10 space-y-3 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <GitBranch className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Full codebase access</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Grid3X3 className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Self-hosted infrastructure control</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Clock3 className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Manual update cadence</span>
                  </li>
                </ul>

                <a
                  href="https://github.com/yusufipk/OpenFrame"
                  target="_blank"
                  rel="noreferrer"
                  data-magnetic
                  className={secondaryButtonClass}
                >
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10 inline-flex items-center gap-2">
                    <Github className="h-4 w-4" />
                    View GitHub
                  </span>
                </a>
              </article>

              <article data-reveal className="relative flex h-full flex-col border border-primary/30 bg-secondary p-7 shadow-sm">
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/8 to-transparent" />
                <div className="relative mb-8 space-y-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    For modern creative teams.
                  </p>
                  <h3 className="text-2xl font-semibold">Hosted Cloud</h3>
                  <p className="font-mono text-3xl text-primary">$10 / month</p>
                  <p className="text-sm text-muted-foreground">For fast, collaborative video review.</p>
                </div>

                <ul className="relative mb-10 space-y-3 text-sm text-foreground">
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Unlimited Seats (Collaborators/Guests)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Unlimited Workspaces & Projects</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Unlimited YouTube video imports</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>200 GB video storage included</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>+100 GB for $5</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Download uploaded original files as-is</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Instant Webhook (Telegram/Email) Setup</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>No per-seat pricing</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Unlimited reviewers</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                    <span>Keep control of your files</span>
                  </li>
                </ul>

                <Link
                  href={isLoggedIn ? '/dashboard' : '/register'}
                  data-magnetic
                  className={`${primaryButtonClass} relative`}
                >
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary-foreground/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10 inline-flex items-center gap-2">
                    {isLoggedIn ? 'Launch workspace' : 'Start using OpenFrame'}
                    <MoveRight className="h-4 w-4" />
                  </span>
                </Link>
              </article>

              <article data-reveal className="flex h-full flex-col border border-border bg-card p-7">
                <div className="mb-8 space-y-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Studio & Agency</p>
                  <h3 className="text-2xl font-semibold">Scaling beyond standard limits?</h3>
                  <p className="text-sm text-muted-foreground">
                    We provide custom capacity, performance tuning, and priority support for high-volume production teams.
                  </p>
                </div>

                <a href="mailto:hello@openframe.so" data-magnetic className={secondaryButtonClass}>
                  <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                  <span className="relative z-10 inline-flex items-center gap-2">
                    Contact us
                    <MoveRight className="h-4 w-4" />
                  </span>
                </a>
              </article>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto grid w-full max-w-[1200px] gap-8 px-4 py-12 sm:px-6 md:grid-cols-4 lg:px-10">
          <div>
            <p className="mb-2 text-sm font-semibold">OpenFrame</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Fast video review with timestamped feedback, version tracking, and guest collaboration.
            </p>
          </div>

          <div>
            <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Legal</p>
            <div className="space-y-2 text-sm">
              <Link href="/" className="block text-muted-foreground transition-colors hover:text-foreground">
                Terms
              </Link>
              <Link href="/" className="block text-muted-foreground transition-colors hover:text-foreground">
                Privacy
              </Link>
            </div>
          </div>

          <div>
            <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Open Source</p>
            <div className="space-y-2 text-sm">
              <a
                href="https://github.com/yusufipk/OpenFrame"
                target="_blank"
                rel="noreferrer"
                className="block text-muted-foreground transition-colors hover:text-foreground"
              >
                GitHub
              </a>
              <Link href="#pricing" className="block text-muted-foreground transition-colors hover:text-foreground">
                Pricing
              </Link>
            </div>
          </div>

          <div>
            <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Console</p>
            <div className="space-y-2 text-sm">
              <a
                href="https://x.com"
                target="_blank"
                rel="noreferrer"
                className="block text-muted-foreground transition-colors hover:text-foreground"
              >
                Twitter
              </a>
              <Link href="/" className="block text-muted-foreground transition-colors hover:text-foreground">
                Docs
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
