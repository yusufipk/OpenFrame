'use client';

import { memo, type ReactNode } from 'react';
import {
  Download,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Play,
  Trash2,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { AssetDownloadPreference, VideoAsset } from '@/components/video-page/types';

interface AssetListSectionProps {
  assets: VideoAsset[];
  isLoadingAssets: boolean;
  focusedAssetId: string | null;
  bunnyProcessingByAssetId: Record<string, boolean>;
  bunnyReadyByAssetId: Record<string, boolean>;
  activeDownloadAssetId: string | null;
  deletingAssetIds: string[];
  canDownloadAssets: boolean;
  hasMoreAssets: boolean;
  isLoadingMoreAssets: boolean;
  onViewAsset: (asset: VideoAsset) => void;
  onDownloadAsset: (asset: VideoAsset, preference?: AssetDownloadPreference) => void;
  onDeleteAsset: (assetId: string) => void;
  onLoadMoreAssets: () => void;
  renderAssetPreview: (asset: VideoAsset) => ReactNode;
  attachmentCommentCounts: Record<string, number>;
}

/**
 * Three shapes of download. A Bunny video offers the original or the compressed
 * rendition; a voice note offers WAV (converted in the browser, because no
 * editing suite opens the WebM/Opus we store) or the file as recorded;
 * everything else is a single button.
 */
function AssetDownloadControl({
  asset,
  isBusy,
  onDownloadAsset,
}: {
  asset: VideoAsset;
  isBusy: boolean;
  onDownloadAsset: (asset: VideoAsset, preference?: AssetDownloadPreference) => void;
}) {
  const options: { preference: AssetDownloadPreference; label: string; hint?: string }[] =
    asset.provider === 'BUNNY' && asset.kind !== 'AUDIO'
      ? [
          { preference: 'original', label: 'Original' },
          { preference: 'compressed', label: 'Compressed' },
        ]
      : asset.provider === 'R2_AUDIO'
        ? [
            { preference: 'wav', label: 'WAV', hint: 'for editing software' },
            { preference: 'original', label: 'Original' },
          ]
        : [];

  if (options.length === 0) {
    return (
      <Button
        size="icon"
        variant="outline"
        className="h-7 w-7"
        title="Download asset"
        aria-label="Download asset"
        disabled={isBusy}
        onClick={() => onDownloadAsset(asset)}
      >
        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="outline"
          className="h-7 w-7"
          title="Download asset"
          aria-label="Download asset"
          disabled={isBusy}
        >
          {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.preference}
            onClick={() => onDownloadAsset(asset, option.preference)}
          >
            <Download className="h-3 w-3 mr-2" />
            {option.label}
            {option.hint && (
              <span className="ml-1 text-xs text-muted-foreground">{option.hint}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const AssetListSection = memo(function AssetListSection({
  assets,
  isLoadingAssets,
  focusedAssetId,
  bunnyProcessingByAssetId,
  bunnyReadyByAssetId,
  activeDownloadAssetId,
  deletingAssetIds,
  canDownloadAssets,
  hasMoreAssets,
  isLoadingMoreAssets,
  onViewAsset,
  onDownloadAsset,
  onDeleteAsset,
  onLoadMoreAssets,
  renderAssetPreview,
  attachmentCommentCounts,
}: AssetListSectionProps) {
  if (isLoadingAssets) {
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading assets...
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center border rounded-lg">
        No assets uploaded yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {assets.map((asset) => {
        const commentCount = attachmentCommentCounts[`asset:${asset.id}`] || 0;
        const isBunnyProcessing =
          asset.provider === 'BUNNY' &&
          !!bunnyProcessingByAssetId[asset.id] &&
          !bunnyReadyByAssetId[asset.id];
        return (
          <div
            key={asset.id}
            id={`asset-card-${asset.id}`}
            className={cn(
              'rounded-lg border p-2 flex gap-3 transition-colors',
              focusedAssetId === asset.id && 'ring-2 ring-primary border-primary/60 bg-primary/5'
            )}
          >
            <button className="shrink-0" onClick={() => onViewAsset(asset)}>
              {renderAssetPreview(asset)}
            </button>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium truncate">{asset.displayName}</p>
                <div className="flex items-center gap-1 shrink-0">
                  {isBunnyProcessing ? (
                    <Badge variant="secondary" className="text-[10px] gap-1">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      Processing
                    </Badge>
                  ) : null}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {asset.uploadedByUser?.name || asset.uploadedByGuestName || 'Unknown'} •{' '}
                {new Date(asset.createdAt).toLocaleDateString()}
              </p>
              <div className="pt-1 flex flex-wrap items-center gap-1">
                <Button
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  title={
                    asset.kind === 'VIDEO'
                      ? 'Play video'
                      : asset.kind === 'AUDIO'
                        ? 'Play recording'
                        : 'View image'
                  }
                  aria-label={
                    asset.kind === 'VIDEO'
                      ? 'Play video'
                      : asset.kind === 'AUDIO'
                        ? 'Play recording'
                        : 'View image'
                  }
                  onClick={() => onViewAsset(asset)}
                >
                  {asset.kind === 'IMAGE' ? (
                    <ImageIcon className="h-3 w-3" />
                  ) : asset.kind === 'AUDIO' ? (
                    <Volume2 className="h-3 w-3" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                </Button>

                {commentCount > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 gap-1 px-2 text-xs"
                    aria-label={`${commentCount} comments on ${asset.displayName}`}
                    onClick={() => onViewAsset(asset)}
                  >
                    <MessageSquare className="h-3 w-3" />
                    {commentCount}
                  </Button>
                )}

                {canDownloadAssets && asset.provider !== 'YOUTUBE' && (
                  <AssetDownloadControl
                    asset={asset}
                    isBusy={activeDownloadAssetId === asset.id || isBunnyProcessing}
                    onDownloadAsset={onDownloadAsset}
                  />
                )}

                {asset.canDelete && (
                  <Button
                    size="icon"
                    variant="destructive"
                    className="h-7 w-7"
                    title="Delete asset"
                    aria-label="Delete asset"
                    disabled={deletingAssetIds.includes(asset.id)}
                    onClick={() => onDeleteAsset(asset.id)}
                  >
                    {deletingAssetIds.includes(asset.id) ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {hasMoreAssets ? (
        <Button
          variant="outline"
          className="w-full"
          disabled={isLoadingMoreAssets}
          onClick={onLoadMoreAssets}
        >
          {isLoadingMoreAssets ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          {isLoadingMoreAssets ? 'Loading more...' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
});
