'use client';

import { memo } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useObjectUrls } from '@/components/video-page/hooks/use-object-urls';
import type { CommentImage } from '@/components/video-page/types';

interface ImageAttachmentStripProps {
  /** Images already saved on the comment being edited, if any. */
  existingUrls?: string[];
  onRemoveExisting?: (url: string) => void;
  /** Files staged in this editor and not uploaded yet. */
  files: File[];
  onRemoveFile: (index: number) => void;
  compact?: boolean;
  className?: string;
}

/**
 * The row of thumbnails under an editor, showing what will be sent with it.
 * Saved images come first, then the ones staged in this session.
 */
export const ImageAttachmentStrip = memo(function ImageAttachmentStrip({
  existingUrls = [],
  onRemoveExisting,
  files,
  onRemoveFile,
  compact = false,
  className,
}: ImageAttachmentStripProps) {
  const previewUrls = useObjectUrls(files);

  if (existingUrls.length === 0 && previewUrls.length === 0) return null;

  const tileSize = compact ? 'h-14 w-14' : 'h-20 w-20';
  const buttonSize = compact ? 'h-5 w-5' : 'h-6 w-6';
  const iconSize = compact ? 'h-2.5 w-2.5' : 'h-3 w-3';

  const tile = (key: string, src: string, alt: string, onRemove: () => void) => (
    <div
      key={key}
      className={cn(
        'group/attachment relative shrink-0 overflow-hidden rounded-md border bg-muted',
        tileSize
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="h-full w-full object-cover" />
      <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover/attachment:opacity-100">
        <Button size="icon" variant="destructive" className={buttonSize} onClick={onRemove}>
          <Trash2 className={iconSize} />
        </Button>
      </div>
    </div>
  );

  return (
    <div className={cn('mb-2 flex flex-wrap gap-2', className)}>
      {existingUrls.map((url, index) =>
        tile(url, url, `Attachment ${index + 1}`, () => onRemoveExisting?.(url))
      )}
      {previewUrls.map((url, index) =>
        tile(`staged-${index}`, url, `Preview ${index + 1}`, () => onRemoveFile(index))
      )}
    </div>
  );
});

interface CommentImageGalleryProps {
  images: CommentImage[];
  onOpen: (image: CommentImage) => void;
  commentId: string;
  attachmentCommentCounts: Record<string, number>;
  compact?: boolean;
  className?: string;
}

/** The images saved on a comment. One fills the width; several tile into a grid. */
export const CommentImageGallery = memo(function CommentImageGallery({
  images,
  onOpen,
  commentId,
  attachmentCommentCounts,
  compact = false,
  className,
}: CommentImageGalleryProps) {
  if (images.length === 0) return null;

  if (images.length === 1) {
    return (
      <button
        type="button"
        className={cn(
          'relative flex w-full cursor-pointer items-center justify-center overflow-hidden rounded-md bg-muted transition-opacity hover:opacity-90',
          compact ? 'max-h-40' : 'max-h-60',
          className
        )}
        onClick={() => onOpen(images[0])}
        aria-label="Open image preview"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={images[0].url}
          alt="Attachment"
          className={cn('max-w-full object-contain', compact ? 'max-h-40' : 'max-h-60')}
        />
        {(attachmentCommentCounts[`comment-image:${commentId}:${images[0].url}`] || 0) > 0 && (
          <span
            className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-background/90 px-1.5 py-0.5 text-xs text-foreground"
            aria-label={`${attachmentCommentCounts[`comment-image:${commentId}:${images[0].url}`]} comments on image attachment`}
          >
            <MessageSquare className="h-3 w-3" />
            {attachmentCommentCounts[`comment-image:${commentId}:${images[0].url}`]}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className={cn('grid grid-cols-2 gap-1.5', className)}>
      {images.map((image, index) => (
        <button
          type="button"
          key={image.id}
          className={cn(
            'relative min-w-0 cursor-pointer overflow-hidden rounded-md bg-muted transition-opacity hover:opacity-90',
            compact ? 'h-20' : 'h-24'
          )}
          onClick={() => onOpen(image)}
          aria-label={`Open image preview ${index + 1}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={`Attachment ${index + 1}`}
            className="h-full w-full object-cover"
          />
          {(attachmentCommentCounts[`comment-image:${commentId}:${image.url}`] || 0) > 0 && (
            <span
              className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-background/90 px-1.5 py-0.5 text-xs text-foreground"
              aria-label={`${attachmentCommentCounts[`comment-image:${commentId}:${image.url}`]} comments on image attachment`}
            >
              <MessageSquare className="h-3 w-3" />
              {attachmentCommentCounts[`comment-image:${commentId}:${image.url}`]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
});
