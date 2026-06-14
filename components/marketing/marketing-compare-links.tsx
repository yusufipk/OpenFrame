import Link from 'next/link';
import { compareFooterLinks } from '@/lib/marketing/comparison-pages';

export function MarketingCompareLinks() {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Compare
      </span>
      <nav className="flex flex-col gap-1.5">
        {compareFooterLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
