'use client';

import { useCallback, useState } from 'react';
import type { CommentExportFormat, NleExportOptions } from '@/lib/nle-comment-export';
import { toast } from 'sonner';

interface UseCommentExportParams {
  activeVersionId: string | null;
  showResolved: boolean;
}

export function useCommentExport({ activeVersionId, showResolved }: UseCommentExportParams) {
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingNle, setIsExportingNle] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  const exportComments = useCallback(
    async (format: CommentExportFormat, options?: NleExportOptions) => {
      if (!activeVersionId) return;

      if (format === 'csv') {
        setIsExportingCsv(true);
      } else if (format === 'pdf') {
        setIsExportingPdf(true);
      } else {
        setIsExportingNle(true);
      }

      try {
        const extra = options
          ? `&${new URLSearchParams({ fps: options.fps, origin: options.origin, dropFrame: String(options.dropFrame) })}`
          : '';
        const response = await fetch(
          `/api/versions/${activeVersionId}/comments/export?format=${format}&includeResolved=${showResolved}${extra}`
        );

        if (!response.ok) {
          let message = 'Failed to export comments';
          try {
            const data = await response.json();
            if (typeof data?.error === 'string') {
              message = data.error;
            }
          } catch {
            // Keep fallback message when response is not JSON.
          }
          throw new Error(message);
        }

        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition');
        const fallbackName = `comments.${format}`;
        const matched = disposition?.match(/filename="?([^"]+)"?/i);
        const filename = matched?.[1] || fallbackName;

        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(downloadUrl);

        toast.success(`Comments exported as ${format.toUpperCase()}`);
      } catch (error) {
        console.error('Failed to export comments:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to export comments');
      } finally {
        if (format === 'csv') {
          setIsExportingCsv(false);
        } else if (format === 'pdf') {
          setIsExportingPdf(false);
        } else {
          setIsExportingNle(false);
        }
      }
    },
    [activeVersionId, showResolved]
  );

  return {
    isExportingNle,
    isExportingCsv,
    isExportingPdf,
    exportComments,
  };
}
