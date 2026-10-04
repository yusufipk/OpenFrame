'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  NLE_FRAME_RATES,
  parseNleOptions,
  type NleExportOptions,
  type NleFormat,
} from '@/lib/nle-comment-export';

const COPY: Record<NleFormat, { title: string; label: string; markers: string; howTo: string }> = {
  edl: {
    title: 'DaVinci Resolve EDL',
    label: 'EDL',
    markers:
      'Markers take the color of the comment tag. Most emoji are left out: Resolve cannot read them from an EDL.',
    howTo: 'In Resolve, use Timeline Markers from EDL on the timeline in the Media Pool.',
  },
  xml: {
    title: 'Adobe Premiere XML',
    label: 'XML',
    markers: 'Markers take the color of the comment tag.',
    howTo:
      'In Premiere, use File → Import. XML creates a separate sequence with markers; it does not modify your existing sequence.',
  },
};

export function NleExportDialog({
  format,
  onClose,
  onExport,
}: {
  format: NleFormat | null;
  onClose: () => void;
  onExport: (format: NleFormat, options: NleExportOptions) => void;
}) {
  const [fps, setFps] = useState('24');
  const [origin, setOrigin] = useState('00:00:00:00');
  const [dropFrame, setDropFrame] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      open={format !== null}
      onOpenChange={(open) => {
        if (!open) {
          // A validation error belongs to the attempt that caused it, not the next opening.
          setError('');
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{format && COPY[format].title}</DialogTitle>
          <DialogDescription>
            Match the frame rate and timeline start timecode of your edit. Comment times are
            relative to the start of the reviewed video.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const options = { fps, origin, dropFrame };
              parseNleOptions(options);
              if (format) onExport(format, options);
              setError('');
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Invalid export options');
            }
          }}
        >
          <label className="block">
            Frame rate (fps)
            <select
              className="block w-full rounded border bg-background p-2"
              value={fps}
              onChange={(event) => setFps(event.target.value)}
            >
              {NLE_FRAME_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate === '24000/1001'
                    ? '23.976 (24000/1001)'
                    : rate === '30000/1001'
                      ? '29.97 (30000/1001)'
                      : rate === '60000/1001'
                        ? '59.94 (60000/1001)'
                        : rate}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Timeline start timecode
            <input
              className="block w-full rounded border bg-background p-2"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder={dropFrame ? '01:00:00;00' : '01:00:00:00'}
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={dropFrame}
              onChange={(event) => {
                setDropFrame(event.target.checked);
                setOrigin((value) =>
                  value.replace(/[:;](\d{2})$/, `${event.target.checked ? ';' : ':'}$1`)
                );
              }}
            />
            Drop-frame timecode (29.97 / 59.94 only)
          </label>
          <p className="text-sm text-muted-foreground">
            Same-frame comments share one marker, with replies listed under their comment.{' '}
            {format && COPY[format].markers}
          </p>
          <p className="text-sm text-muted-foreground">{format && COPY[format].howTo}</p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit">Download {format && COPY[format].label}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
