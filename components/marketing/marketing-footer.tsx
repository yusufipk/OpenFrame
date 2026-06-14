import Link from 'next/link';
import { Video } from 'lucide-react';
import { seoConfig } from '@/lib/seo';
import { MarketingCompareLinks } from '@/components/marketing/marketing-compare-links';

export function MarketingFooter() {
  return (
    <footer className="border-t border-border bg-background px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-[1200px] gap-8 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex items-start gap-2">
          <Video className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span className="font-mono text-xs text-muted-foreground">
            © 2026 IPEK TECH LLC. All rights reserved.
          </span>
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
              href={seoConfig.githubUrl}
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
  );
}
