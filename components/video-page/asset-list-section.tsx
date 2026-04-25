'use client';

import { memo, type ReactNode } from 'react';
import { Download, Image as ImageIcon, Loader2, Play, Trash2, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { VideoAsset } from '@/components/video-page/types';

interface AssetListSectionProps {
  assets: VideoAsset[];
  isLoadingAssets: boolean;
  focusedAssetId: string | null;
  bunnyProcessingByAssetId: Record<string, boolean>;
  bunnyReadyByAssetId: Record<string, boolean>;
  activeDownloadAssetId: string | null;
  activeDeleteAssetId: string | null;
  canDownloadAssets: boolean;
  hasMoreAssets: boolean;
  isLoadingMoreAssets: boolean;
  onViewAsset: (asset: VideoAsset) => void;
  onDownloadAsset: (asset: VideoAsset, preference?: 'original' | 'compressed') => void;
  onDeleteAsset: (assetId: string) => void;
  onLoadMoreAssets: () => void;
  renderAssetPreview: (asset: VideoAsset) => ReactNode;
}

export const AssetListSection = memo(function AssetListSection({
  assets,
  isLoadingAssets,
  focusedAssetId,
  bunnyProcessingByAssetId,
  bunnyReadyByAssetId,
  activeDownloadAssetId,
  activeDeleteAssetId,
  canDownloadAssets,
  hasMoreAssets,
  isLoadingMoreAssets,
  onViewAsset,
  onDownloadAsset,
  onDeleteAsset,
  onLoadMoreAssets,
  renderAssetPreview,
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
              <div className="pt-1 flex items-center gap-1">
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

                {canDownloadAssets &&
                  asset.provider !== 'YOUTUBE' &&
                  (asset.provider === 'BUNNY' && asset.kind !== 'AUDIO' ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-7 w-7"
                          title="Download asset"
                          aria-label="Download asset"
                          disabled={activeDownloadAssetId === asset.id || isBunnyProcessing}
                        >
                          {activeDownloadAssetId === asset.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Download className="h-3 w-3" />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem onClick={() => onDownloadAsset(asset, 'original')}>
                          <Download className="h-3 w-3 mr-2" />
                          Original
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onDownloadAsset(asset, 'compressed')}>
                          <Download className="h-3 w-3 mr-2" />
                          Compressed
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      title="Download asset"
                      aria-label="Download asset"
                      disabled={activeDownloadAssetId === asset.id || isBunnyProcessing}
                      onClick={() => onDownloadAsset(asset)}
                    >
                      {activeDownloadAssetId === asset.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Download className="h-3 w-3" />
                      )}
                    </Button>
                  ))}

                {asset.canDelete && (
                  <Button
                    size="icon"
                    variant="destructive"
                    className="h-7 w-7"
                    title="Delete asset"
                    aria-label="Delete asset"
                    disabled={activeDeleteAssetId === asset.id}
                    onClick={() => onDeleteAsset(asset.id)}
                  >
                    {activeDeleteAssetId === asset.id ? (
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
