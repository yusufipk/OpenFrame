'use client';
// Same exemption as the players themselves: this hook mirrors an external player's
// caption state into React, which is the case the rule cannot distinguish.
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  readStoredSubtitleLanguage,
  writeStoredSubtitleLanguage,
} from '@/components/video-page/hooks/subtitle-preference';
import {
  youtubeCaptionFontSize,
  type SubtitleSize,
} from '@/components/video-page/hooks/subtitle-appearance';
import type { PlayerAdapter, SubtitleTrackOption } from '@/components/video-page/types';

interface UseYoutubeCaptionsParams {
  videoId: string;
  versionId: string | null;
  playerRef: RefObject<YT.Player | PlayerAdapter | null>;
  /** The active version is a YouTube one. */
  enabled: boolean;
  isReady: boolean;
  /** Incremented by the player on every onApiChange. */
  moduleRevision: number;
  /** The viewer's subtitle size. YouTube has no background option, so only this applies. */
  captionSize: SubtitleSize;
}

/** One entry of `getOption('captions', 'tracklist')`. Only these fields are relied on. */
type YoutubeCaptionTrack = {
  languageCode?: string;
  languageName?: string;
  displayName?: string;
};

const CAPTIONS_MODULE = 'captions';

function applyCaptionSize(player: YT.Player, size: SubtitleSize): void {
  try {
    player.setOption(CAPTIONS_MODULE, 'fontSize', youtubeCaptionFontSize(size));
  } catch {
    // A player that refuses the option keeps its default size, which is still readable.
  }
}

function asYoutubePlayer(
  player: YT.Player | PlayerAdapter | null
): (YT.Player & { loadModule?: unknown }) | null {
  if (!player) return null;
  const candidate = player as YT.Player;
  return typeof candidate.loadModule === 'function' ? candidate : null;
}

/**
 * Drives YouTube's own captions from our control bar.
 *
 * A YouTube version plays inside an iframe we do not own, so a <track> element is not an
 * option and neither is an uploaded file: the only captions that exist for it are the ones
 * the video already carries. The player is embedded with controls=0, which hides
 * YouTube's CC button along with the rest of its chrome, so without this the captions
 * would be unreachable even when they exist.
 */
export function useYoutubeCaptions({
  videoId,
  versionId,
  playerRef,
  enabled,
  isReady,
  moduleRevision,
  captionSize,
}: UseYoutubeCaptionsParams) {
  const [tracks, setTracks] = useState<SubtitleTrackOption[]>([]);
  const [activeLanguage, setActiveLanguage] = useState<string | null>(null);

  // Read inside effects that must not re-run when the selection changes.
  const activeLanguageRef = useRef<string | null>(null);
  useEffect(() => {
    activeLanguageRef.current = activeLanguage;
  }, [activeLanguage]);
  const appliedPreferenceForVersionRef = useRef<string | null>(null);
  /**
   * The caption state we last pushed into the player, or `undefined` before the first
   * push. Loading and unloading a module both fire onApiChange, so an effect that reacted
   * to every revision by unloading again would answer its own event forever.
   */
  const appliedLanguageRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    setTracks([]);
    setActiveLanguage(null);
    appliedLanguageRef.current = undefined;
  }, [versionId]);

  // Loading the module is what makes the track list readable, and it also switches
  // captions on. The probe below turns them straight back off for a viewer who has not
  // asked for them: at this point the video is at its first frame with no cue to draw,
  // so there is nothing to flash.
  useEffect(() => {
    if (!enabled || !isReady) return;
    const player = asYoutubePlayer(playerRef.current);
    if (!player) return;
    try {
      player.loadModule(CAPTIONS_MODULE);
    } catch {
      // An older or restricted player without the module API simply has no captions.
    }
  }, [enabled, isReady, playerRef, versionId]);

  useEffect(() => {
    if (!enabled || !isReady || moduleRevision === 0) return;
    const player = asYoutubePlayer(playerRef.current);
    if (!player) return;

    let rawTracks: YoutubeCaptionTrack[] = [];
    try {
      rawTracks = player.getOption<YoutubeCaptionTrack[]>(CAPTIONS_MODULE, 'tracklist') ?? [];
    } catch {
      rawTracks = [];
    }

    const mapped: SubtitleTrackOption[] = rawTracks
      .filter((track): track is YoutubeCaptionTrack & { languageCode: string } =>
        Boolean(track?.languageCode)
      )
      .map((track) => ({
        id: `youtube:${track.languageCode}`,
        language: track.languageCode.toLowerCase(),
        label: track.displayName || track.languageName || track.languageCode.toUpperCase(),
        canDelete: false,
      }));

    setTracks(mapped);

    const stored =
      versionId && appliedPreferenceForVersionRef.current !== versionId
        ? readStoredSubtitleLanguage(videoId)
        : null;
    if (versionId) appliedPreferenceForVersionRef.current = versionId;

    const wanted =
      activeLanguageRef.current ??
      (stored && mapped.some((track) => track.language === stored) ? stored : null);

    if (appliedLanguageRef.current === wanted) return;
    appliedLanguageRef.current = wanted;

    try {
      if (wanted) {
        player.setOption(CAPTIONS_MODULE, 'track', { languageCode: wanted });
        setActiveLanguage(wanted);
      } else {
        player.unloadModule(CAPTIONS_MODULE);
      }
    } catch {
      // Same as above: a player that will not take the option has no captions to give.
    }
  }, [enabled, isReady, moduleRevision, playerRef, versionId, videoId]);

  // Reapplied on every module change as well as on a new size: loading the captions module
  // again (turning them back on, a new track) can reset the player to its default size.
  useEffect(() => {
    if (!enabled || !isReady || !activeLanguage) return;
    const player = asYoutubePlayer(playerRef.current);
    if (player) applyCaptionSize(player, captionSize);
  }, [activeLanguage, captionSize, enabled, isReady, moduleRevision, playerRef]);

  const selectCaptionLanguage = useCallback(
    (language: string | null) => {
      setActiveLanguage(language);
      writeStoredSubtitleLanguage(videoId, language);
      appliedPreferenceForVersionRef.current = versionId;
      appliedLanguageRef.current = language;

      const player = asYoutubePlayer(playerRef.current);
      if (!player) return;
      try {
        if (language) {
          player.loadModule(CAPTIONS_MODULE);
          player.setOption(CAPTIONS_MODULE, 'track', { languageCode: language });
        } else {
          player.unloadModule(CAPTIONS_MODULE);
        }
      } catch {
        // Nothing to recover: the menu already reflects the choice, and a player that
        // refuses the module was never going to show captions.
      }
    },
    [playerRef, versionId, videoId]
  );

  return useMemo(
    () => ({
      youtubeCaptionTracks: enabled ? tracks : [],
      activeYoutubeCaptionLanguage: enabled ? activeLanguage : null,
      selectYoutubeCaptionLanguage: selectCaptionLanguage,
    }),
    [activeLanguage, enabled, selectCaptionLanguage, tracks]
  );
}
