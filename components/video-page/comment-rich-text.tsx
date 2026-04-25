'use client';

import React from 'react';
import { Image as ImageIcon, Video, Volume2 } from 'lucide-react';
import type { VideoAsset } from '@/components/video-page/types';

const URL_REGEX = /(https?:\/\/[^\s]+)/g;
const ASSET_MENTION_REGEX = /@\[(.+?)\]\(asset:([a-z0-9]+)\)/gi;

interface CommentRichTextProps {
  text: string;
  onAssetMentionClick?: (assetId: string) => void;
  assets?: VideoAsset[];
}

function renderUrls(text: string): React.ReactNode[] {
  const parts = text.split(URL_REGEX);
  return parts.map((part, index) => {
    if (/^https?:\/\/[^\s]+$/.test(part)) {
      return (
        <a
          key={`url-${index}`}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline break-all"
          onClick={(event) => event.stopPropagation()}
        >
          {part}
        </a>
      );
    }
    return <React.Fragment key={`txt-${index}`}>{part}</React.Fragment>;
  });
}

export function CommentRichText({ text, onAssetMentionClick, assets = [] }: CommentRichTextProps) {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(ASSET_MENTION_REGEX)) {
    const mentionIndex = match.index ?? -1;
    if (mentionIndex < 0) continue;

    if (mentionIndex > lastIndex) {
      nodes.push(...renderUrls(text.slice(lastIndex, mentionIndex)));
    }

    const fallbackLabel = match[1] || 'asset';
    const assetId = match[2] || '';
    const matchedAsset = assets.find((asset) => asset.id === assetId);
    const label = matchedAsset?.displayName || fallbackLabel;
    const assetKind = matchedAsset?.kind;

    nodes.push(
      <button
        key={`mention-${assetId}-${mentionIndex}`}
        type="button"
        className="inline-flex max-w-full items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary hover:bg-primary/20 transition-colors align-middle"
        onClick={(event) => {
          event.stopPropagation();
          if (assetId && onAssetMentionClick) onAssetMentionClick(assetId);
        }}
        title={label}
      >
        <span
          className={
            assetKind === 'VIDEO'
              ? 'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-violet-500/25 text-violet-200'
              : assetKind === 'AUDIO'
                ? 'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-blue-500/25 text-blue-200'
                : 'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-emerald-500/25 text-emerald-200'
          }
        >
          {assetKind === 'VIDEO' ? (
            <Video className="h-2.5 w-2.5" />
          ) : assetKind === 'AUDIO' ? (
            <Volume2 className="h-2.5 w-2.5" />
          ) : (
            <ImageIcon className="h-2.5 w-2.5" />
          )}
        </span>
        <span className="truncate max-w-[190px] sm:max-w-[240px]">@{label}</span>
      </button>
    );

    lastIndex = mentionIndex + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderUrls(text.slice(lastIndex)));
  }

  return <>{nodes}</>;
}
