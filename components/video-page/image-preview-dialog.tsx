'use client';

import { memo } from 'react';
import { Download, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface ImagePreviewDialogProps {
  previewImage: string | null;
  onClose: () => void;
  title?: string | null;
  downloadFileName?: string | null;
  canDownload?: boolean;
}

export const ImagePreviewDialog = memo(function ImagePreviewDialog({
  previewImage,
  onClose,
  title,
  downloadFileName,
  canDownload = true,
}: ImagePreviewDialogProps) {
  const resolvedDownloadName =
    downloadFileName ||
    (previewImage ? previewImage.split('/').pop() || 'attachment.png' : 'attachment.png');

  return (
    <Dialog open={!!previewImage} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-none sm:max-w-none w-screen h-screen max-h-screen p-0 overflow-hidden bg-black/90 border-none shadow-none flex items-center justify-center rounded-none"
        onClick={onClose}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <DialogTitle className="sr-only">{title || 'Image Preview'}</DialogTitle>
        <div
          className="w-[min(96vw,1500px)] h-[min(94vh,1000px)] border border-border/60 bg-black/80 shadow-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="shrink-0 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 py-1.5 backdrop-blur-sm">
            <p
              className="flex-1 min-w-0 text-sm text-foreground truncate"
              title={title || undefined}
            >
              {title || 'Image Preview'}
            </p>
            {canDownload ? (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    if (!previewImage) return;
                    const response = await fetch(previewImage);
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = resolvedDownloadName;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    window.URL.revokeObjectURL(url);
                  } catch (error) {
                    console.error('Failed to download image:', error);
                    toast.error('Failed to download image');
                  }
                }}
              >
                <Download className="h-4 w-4" />
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div
            className="relative flex-1 min-h-0 w-full flex items-center justify-center p-2 sm:p-4 cursor-zoom-out"
            onClick={onClose}
          >
            {previewImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewImage}
                alt={title || 'Preview'}
                className="max-w-full max-h-full object-contain rounded-md select-none cursor-default"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
