import Link from 'next/link';
import { MoveRight, Video } from 'lucide-react';
import { seoConfig } from '@/lib/seo';

const controlButtonClass =
  'group relative isolate inline-flex h-8 items-center justify-center overflow-hidden border border-border bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors duration-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-9 sm:px-4 sm:text-xs';

interface MarketingHeaderProps {
  isLoggedIn: boolean;
}

export function MarketingHeader({ isLoggedIn }: MarketingHeaderProps) {
  const hostedCtaHref = isLoggedIn ? '/dashboard' : '/register';

  return (
    <header className="border-b border-border bg-background/90 backdrop-blur-md">
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
            href="/#features"
          >
            Features
          </Link>
          <Link
            className="text-muted-foreground transition-colors hover:text-foreground"
            href="/#pricing"
          >
            Pricing
          </Link>
          <a
            className="text-muted-foreground transition-colors hover:text-foreground"
            href={seoConfig.githubUrl}
            target="_blank"
            rel="noreferrer"
          >
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
              <Link
                href="/login"
                className="mr-4 hidden text-xs font-medium text-muted-foreground hover:text-foreground sm:block"
              >
                Log in
              </Link>
              <Link href={hostedCtaHref} className={controlButtonClass}>
                <span className="pointer-events-none absolute inset-0 -translate-x-[101%] bg-primary/10 transition-transform duration-300 group-hover:translate-x-0" />
                <span className="relative z-10">Start free trial</span>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
