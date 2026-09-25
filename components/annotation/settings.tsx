'use client';

import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ANNOTATION_COLORS, MAX_ANNOTATION_WIDTH, MIN_ANNOTATION_WIDTH } from './palette';

interface AnnotationSettingsProps {
  color: string;
  width: number;
  onColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  className?: string;
}

export function AnnotationSettings({
  color,
  width,
  onColorChange,
  onWidthChange,
  className,
}: AnnotationSettingsProps) {
  return (
    <div className={className ?? 'flex items-center justify-center flex-wrap gap-x-2 gap-y-2'}>
      <div
        className="flex items-center justify-center flex-wrap gap-1.5"
        role="group"
        aria-label="Stroke color"
      >
        {ANNOTATION_COLORS.map(({ name, value }) => (
          <button
            key={value}
            type="button"
            aria-label={name}
            aria-pressed={color === value}
            className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 shrink-0"
            style={{
              backgroundColor: value,
              borderColor: color === value ? 'white' : 'transparent',
              boxShadow: color === value ? `0 0 0 2px ${value}` : 'none',
            }}
            onClick={() => onColorChange(value)}
          />
        ))}
      </div>
      <div className="hidden sm:block w-px h-6 bg-border mx-1" />
      <div className="flex items-center gap-1" role="group" aria-label="Stroke width">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Decrease stroke width"
          disabled={width <= MIN_ANNOTATION_WIDTH}
          onClick={() => onWidthChange(Math.max(MIN_ANNOTATION_WIDTH, width - 1))}
        >
          <Minus className="h-3 w-3" />
        </Button>
        <span className="text-xs tabular-nums w-4 text-center" aria-label={`Stroke width ${width}`}>
          {width}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Increase stroke width"
          disabled={width >= MAX_ANNOTATION_WIDTH}
          onClick={() => onWidthChange(Math.min(MAX_ANNOTATION_WIDTH, width + 1))}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
