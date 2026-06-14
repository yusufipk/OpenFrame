import { Check, Minus, X } from 'lucide-react';
import type { FeatureRow } from '@/lib/marketing/comparison-types';

function renderStatus(value: FeatureRow['openframe']) {
  if (value === 'yes') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-400">
        <Check className="h-4 w-4" />
        Yes
      </span>
    );
  }

  if (value === 'no') {
    return (
      <span className="inline-flex items-center gap-1 text-red-400/90">
        <X className="h-4 w-4" />
        No
      </span>
    );
  }

  if (value === 'partial') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-300">
        <Minus className="h-4 w-4" />
        Partial
      </span>
    );
  }

  return <span className="text-foreground/90">{value}</span>;
}

interface FeatureComparisonTableProps {
  rows: FeatureRow[];
  competitorName: string;
}

export function FeatureComparisonTable({ rows, competitorName }: FeatureComparisonTableProps) {
  return (
    <div className="overflow-x-auto border border-border bg-card">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-border bg-background/60">
          <tr>
            <th className="px-4 py-3 font-medium text-muted-foreground">Feature</th>
            <th className="px-4 py-3 font-medium text-primary">OpenFrame</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">{competitorName}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-border/60 last:border-b-0">
              <td className="px-4 py-3 align-top">
                <div className="font-medium text-foreground">{row.label}</div>
                {row.note ? (
                  <div className="mt-1 text-xs text-muted-foreground">{row.note}</div>
                ) : null}
              </td>
              <td className="px-4 py-3 align-top">{renderStatus(row.openframe)}</td>
              <td className="px-4 py-3 align-top">{renderStatus(row.competitor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
