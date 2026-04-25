'use client';

import { memo } from 'react';
import { CheckCircle2, GitCompareArrows } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { Version } from '@/components/video-page/types';

interface CompareVersionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: Version[];
  selectedCompareVersions: Set<string>;
  onToggleVersion: (versionId: string) => void;
  onCompare: () => void;
}

export const CompareVersionsDialog = memo(function CompareVersionsDialog({
  open,
  onOpenChange,
  versions,
  selectedCompareVersions,
  onToggleVersion,
  onCompare,
}: CompareVersionsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select Versions to Compare</DialogTitle>
          <DialogDescription>Choose 2 or more versions to compare side by side.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 mt-2 max-h-64 overflow-y-auto">
          {versions
            .slice()
            .sort((a, b) => a.versionNumber - b.versionNumber)
            .map((v) => {
              const isSelected = selectedCompareVersions.has(v.id);
              return (
                <button
                  key={v.id}
                  type="button"
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors',
                    isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50'
                  )}
                  onClick={() => onToggleVersion(v.id)}
                >
                  <div
                    className={cn(
                      'h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                      isSelected
                        ? 'bg-primary border-primary text-primary-foreground'
                        : 'border-muted-foreground/40'
                    )}
                  >
                    {isSelected && <CheckCircle2 className="h-3 w-3" />}
                  </div>
                  <Badge variant="secondary">v{v.versionNumber}</Badge>
                  <span className="text-sm font-medium truncate">
                    {v.versionLabel || `Version ${v.versionNumber}`}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground shrink-0">
                    {v._count.comments} comments
                  </span>
                </button>
              );
            })}
        </div>
        <Button
          className="w-full mt-2"
          disabled={selectedCompareVersions.size < 2}
          onClick={onCompare}
        >
          <GitCompareArrows className="h-4 w-4 mr-2" />
          Compare {selectedCompareVersions.size} Versions
        </Button>
      </DialogContent>
    </Dialog>
  );
});
