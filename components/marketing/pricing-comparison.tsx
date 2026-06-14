import type { PricingRow } from '@/lib/marketing/comparison-types';

interface PricingComparisonProps {
  rows: PricingRow[];
  footnote?: string;
  competitorName: string;
}

export function PricingComparison({ rows, footnote, competitorName }: PricingComparisonProps) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="border border-border bg-card p-5">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{row.label}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[10px] uppercase tracking-[0.12em] text-primary">OpenFrame</p>
                <p className="mt-1 text-sm text-foreground">{row.openframe}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {competitorName}
                </p>
                <p className="mt-1 text-sm text-foreground/90">{row.competitor}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
      {footnote ? <p className="text-xs text-muted-foreground">{footnote}</p> : null}
    </div>
  );
}
