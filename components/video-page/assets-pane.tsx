'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as tus from 'tus-js-client';
import { toast } from 'sonner';
import { Download, FileVideo, Image as ImageIcon, Loader2, Mic, Pause, Play, Square, UploadCloud, Volume2, X, Youtube } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ImagePreviewDialog } from '@/components/video-page/image-preview-dialog';
import { BunnyPreviewPlayer, type BunnyPreviewPlayerHandle } from '@/components/video-page/bunny-preview-player';
import { AssetListSection } from '@/components/video-page/asset-list-section';
import type { VideoAsset } from '@/components/video-page/types';
import { extractPastedImageFile, validateImageFile } from '@/components/video-page/image-upload-utils';
import { useCommentMedia } from '@/components/video-page/hooks/use-comment-media';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { cn } from '@/lib/utils';

const MAX_AUDIO_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_AUDIO_UPLOAD_SIZE_MESSAGE = 'File too large. Maximum size is 10MB.';

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

type UploadAudioResponse = {
  data?: { url?: string };
  error?: string;
};

function getAudioUploadValidationError(file: Blob): string | null {
  if (file.size > MAX_AUDIO_UPLOAD_SIZE) {
    return MAX_AUDIO_UPLOAD_SIZE_MESSAGE;
  }
  return null;
}

async function readUploadAudioResponse(response: Response): Promise<UploadAudioResponse | null> {
  const raw = await response.text().catch(() => '');
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as UploadAudioResponse;
  } catch {
    if (trimmed.startsWith('<')) return null;
    return { error: trimmed };
  }
}

interface AssetsPaneProps {
  videoId: string;
  assets: VideoAsset[];
  isLoadingAssets: boolean;
  isCreatingAsset: boolean;
  activeDeleteAssetId: string | null;
  activeDownloadAssetId: string | null;
  canUploadAssets: boolean;
  canDownloadAssets: boolean;
  getGuestUploadToken: (intent: 'image' | 'audio') => Promise<string | null>;
  createAsset: (payload: {
    provider: 'R2_IMAGE' | 'YOUTUBE' | 'BUNNY' | 'R2_AUDIO';
    displayName?: string;
    sourceUrl: string;
    providerVideoId?: string;
    thumbnailUrl?: string;
    uploadToken?: string;
  }) => Promise<VideoAsset | null>;
  deleteAsset: (assetId: string) => Promise<boolean>;
  downloadAsset: (asset: VideoAsset, preference?: 'original' | 'compressed') => Promise<void>;
  hasMoreAssets: boolean;
  isLoadingMoreAssets: boolean;
  loadMoreAssets: () => Promise<void>;
  highlightedAssetId: string | null;
  onHighlightedAssetHandled: () => void;
}

export const AssetsPane = memo(function AssetsPane({
  videoId,
  assets,
  isLoadingAssets,
  isCreatingAsset,
  activeDeleteAssetId,
  activeDownloadAssetId,
  canUploadAssets,
  canDownloadAssets,
  getGuestUploadToken,
  createAsset,
  deleteAsset,
  downloadAsset,
  hasMoreAssets,
  isLoadingMoreAssets,
  loadMoreAssets,
  highlightedAssetId,
  onHighlightedAssetHandled,
}: AssetsPaneProps) {
  const [uploadTab, setUploadTab] = useState<'image' | 'youtube' | 'bunny' | 'voice'>('image');
  const [imageTitle, setImageTitle] = useState('');
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeTitle, setYoutubeTitle] = useState('');
  const [bunnyTitle, setBunnyTitle] = useState('');
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isUploadingBunny, setIsUploadingBunny] = useState(false);
  const [bunnyProgress, setBunnyProgress] = useState(0);
  const [bunnyProcessingByAssetId, setBunnyProcessingByAssetId] = useState<Record<string, boolean>>({});
  const [bunnyReadyByAssetId, setBunnyReadyByAssetId] = useState<Record<string, boolean>>({});
  const [bunnyThumbnailRetryKeyByAssetId, setBunnyThumbnailRetryKeyByAssetId] = useState<Record<string, number>>({});
  const [bunnyThumbnailLoadErrorByAssetId, setBunnyThumbnailLoadErrorByAssetId] = useState<Record<string, boolean>>({});
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewImageTitle, setPreviewImageTitle] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<VideoAsset | null>(null);
  const bunnyCdnHostname = useMemo(() => resolvePublicBunnyCdnHostname(), []);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const bunnyPreviewPlayerRef = useRef<BunnyPreviewPlayerHandle | null>(null);
  const youtubeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const youtubePreviewStateRef = useRef({ currentTime: 0, isPlaying: false, isMuted: false });
  const imageInputRef = useRef<HTMLInputElement>(null);
  const bunnyInputRef = useRef<HTMLInputElement>(null);

  // Voice recording state
  const [voiceTitle, setVoiceTitle] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [pendingAudioFile, setPendingAudioFile] = useState<File | null>(null);
  const [isUploadingVoice, setIsUploadingVoice] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drag-drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Audio playback for asset preview dialog and recording preview
  const { playingVoiceId, voiceProgress, voiceCurrentTime, voicePlaybackRate, playVoice, stopVoice, toggleVoiceSpeed } = useCommentMedia();

  const sortedAssets = useMemo(() => {
    return [...assets].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [assets]);

  useEffect(() => {
    if (!highlightedAssetId) return;

    const element = document.getElementById(`asset-card-${highlightedAssetId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFocusedAssetId(highlightedAssetId);
      window.setTimeout(() => setFocusedAssetId((prev) => (prev === highlightedAssetId ? null : prev)), 2500);
    }

    onHighlightedAssetHandled();
  }, [highlightedAssetId, onHighlightedAssetHandled]);

  useEffect(() => {
    if (!selectedAsset || selectedAsset.kind !== 'VIDEO') return;

    const sendYouTubeCommand = (func: string, args: unknown[] = []) => {
      const iframe = youtubeIframeRef.current;
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func,
        args,
      }), '*');
    };

    const onMessage = (event: MessageEvent) => {
      if (!selectedAsset || selectedAsset.provider !== 'YOUTUBE') return;
      if (typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const info = (parsed as { info?: { currentTime?: number; playerState?: number; muted?: boolean } })?.info;
      if (!info) return;
      if (typeof info.currentTime === 'number') {
        youtubePreviewStateRef.current.currentTime = info.currentTime;
      }
      if (typeof info.playerState === 'number') {
        youtubePreviewStateRef.current.isPlaying = info.playerState === 1;
      }
      if (typeof info.muted === 'boolean') {
        youtubePreviewStateRef.current.isMuted = info.muted;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!selectedAsset || selectedAsset.kind !== 'VIDEO') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const handledKeys = new Set(['Space', 'KeyK', 'ArrowLeft', 'ArrowRight', 'KeyJ', 'KeyL', 'KeyM', 'Escape']);
      if (!handledKeys.has(event.code)) return;

      event.preventDefault();
      event.stopPropagation();

      if (event.code === 'Escape') {
        setSelectedAsset(null);
        return;
      }

      if (selectedAsset.provider === 'BUNNY') {
        switch (event.code) {
          case 'Space':
          case 'KeyK':
            bunnyPreviewPlayerRef.current?.togglePlayPause();
            break;
          case 'ArrowLeft':
          case 'KeyJ':
            bunnyPreviewPlayerRef.current?.seekBy(-10);
            break;
          case 'ArrowRight':
          case 'KeyL':
            bunnyPreviewPlayerRef.current?.seekBy(10);
            break;
          case 'KeyM':
            bunnyPreviewPlayerRef.current?.toggleMute();
            break;
        }
        return;
      }

      if (selectedAsset.provider === 'YOUTUBE') {
        switch (event.code) {
          case 'Space':
          case 'KeyK': {
            const isPlaying = youtubePreviewStateRef.current.isPlaying;
            sendYouTubeCommand(isPlaying ? 'pauseVideo' : 'playVideo');
            youtubePreviewStateRef.current.isPlaying = !isPlaying;
            break;
          }
          case 'ArrowLeft':
          case 'KeyJ': {
            const next = Math.max(0, youtubePreviewStateRef.current.currentTime - 10);
            sendYouTubeCommand('seekTo', [next, true]);
            youtubePreviewStateRef.current.currentTime = next;
            break;
          }
          case 'ArrowRight':
          case 'KeyL': {
            const next = youtubePreviewStateRef.current.currentTime + 10;
            sendYouTubeCommand('seekTo', [next, true]);
            youtubePreviewStateRef.current.currentTime = next;
            break;
          }
          case 'KeyM': {
            const isMuted = youtubePreviewStateRef.current.isMuted;
            sendYouTubeCommand(isMuted ? 'unMute' : 'mute');
            youtubePreviewStateRef.current.isMuted = !isMuted;
            break;
          }
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('message', onMessage);
    };
  }, [selectedAsset]);

  useEffect(() => {
    if (!selectedAsset || selectedAsset.provider !== 'BUNNY') return;
    if (bunnyReadyByAssetId[selectedAsset.id]) return;
    setBunnyProcessingByAssetId((prev) => (prev[selectedAsset.id] ? prev : { ...prev, [selectedAsset.id]: true }));
  }, [bunnyReadyByAssetId, selectedAsset]);

  const handleImageUpload = useCallback(async (file: File) => {
    if (!file) return;

    const imageError = await validateImageFile(file);
    if (imageError) {
      toast.error(imageError);
      return;
    }

    setIsUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('videoId', videoId);
      const guestUploadToken = await getGuestUploadToken('image');
      if (guestUploadToken) formData.append('uploadToken', guestUploadToken);

      const uploadRes = await fetch('/api/upload/image', {
        method: 'POST',
        body: formData,
      });
      const uploadPayload = (await uploadRes.json().catch(() => null)) as { data?: { url?: string }; error?: string } | null;
      const uploadedImageUrl = uploadPayload?.data?.url;
      if (!uploadRes.ok || !uploadedImageUrl) {
        toast.error(uploadPayload?.error || 'Failed to upload image');
        return;
      }

      await createAsset({
        provider: 'R2_IMAGE',
        sourceUrl: uploadedImageUrl,
        displayName: imageTitle.trim() || file.name,
      });
      if (imageInputRef.current) imageInputRef.current.value = '';
      setImageTitle('');
      setPendingImageFile(null);
    } catch (error) {
      console.error('Failed to upload image asset:', error);
      toast.error('Failed to upload image');
    } finally {
      setIsUploadingImage(false);
    }
  }, [videoId, getGuestUploadToken, createAsset, imageTitle]);

  const handleImageFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageError = await validateImageFile(file);
    if (imageError) {
      toast.error(imageError);
      return;
    }
    setPendingImageFile(file);
    toast.success('Image attached. Click Upload Image to send.');
  };

  const handleImagePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (uploadTab !== 'image' || !canUploadAssets || isCreatingAsset) return;
    const pastedImage = extractPastedImageFile(event.clipboardData);
    if (!pastedImage) return;
    event.preventDefault();
    const imageError = await validateImageFile(pastedImage);
    if (imageError) {
      toast.error(imageError);
      return;
    }
    setPendingImageFile(pastedImage);
    toast.success('Image attached from clipboard. Click Upload Image to send.');
  };

  const handleCreateYoutubeAsset = async () => {
    if (!youtubeUrl.trim()) return;
    const created = await createAsset({
      provider: 'YOUTUBE',
      sourceUrl: youtubeUrl.trim(),
      displayName: youtubeTitle.trim() || undefined,
    });
    if (created) {
      setYoutubeUrl('');
      setYoutubeTitle('');
    }
  };

  const handleBunnyFileUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith('video/')) {
      toast.error('Please select a video file');
      return;
    }

    let uploadedVideoId: string | null = null;
    let uploadToken: string | null = null;
    try {
      setIsUploadingBunny(true);
      setBunnyProgress(0);

      const initRes = await fetch(`/api/videos/${videoId}/assets/bunny-init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: bunnyTitle.trim() || file.name.replace(/\.[^/.]+$/, '') }),
      });
      const initPayload = (await initRes.json().catch(() => null)) as {
        data?: {
          videoId: string;
          libraryId: string;
          signature: string;
          expirationTime: number;
          uploadToken: string;
        };
        error?: string;
      } | null;

      if (!initRes.ok || !initPayload?.data) {
        toast.error(initPayload?.error || 'Failed to initialize Bunny upload');
        return;
      }

      const initData = initPayload.data;
      uploadedVideoId = initData.videoId;
      uploadToken = initData.uploadToken;

      await new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(file, {
          endpoint: 'https://video.bunnycdn.com/tusupload',
          retryDelays: [0, 3000, 5000, 10000, 20000],
          headers: {
            AuthorizationSignature: initData.signature,
            AuthorizationExpire: initData.expirationTime.toString(),
            VideoId: initData.videoId,
            LibraryId: initData.libraryId,
          },
          metadata: {
            filetype: file.type,
            title: file.name,
          },
          onError: (error) => reject(error),
          onProgress: (bytesUploaded, bytesTotal) => {
            const percentage = bytesTotal > 0 ? (bytesUploaded / bytesTotal) * 100 : 0;
            setBunnyProgress(Math.min(100, Math.max(0, percentage)));
          },
          onSuccess: () => resolve(),
        });
        upload.start();
      });

      const sourceUrl = `https://iframe.mediadelivery.net/embed/${initData.libraryId}/${initData.videoId}`;
      const thumbnailUrl = bunnyCdnHostname
        ? `https://${bunnyCdnHostname}/${initData.videoId}/thumbnail.jpg`
        : undefined;
      const createdAsset = await createAsset({
        provider: 'BUNNY',
        sourceUrl,
        providerVideoId: initData.videoId,
        uploadToken: initData.uploadToken,
        thumbnailUrl,
        displayName: bunnyTitle.trim() || file.name,
      });
      if (!createdAsset) {
        throw new Error('Failed to finalize Bunny asset');
      }
      setBunnyReadyByAssetId((prev) => ({ ...prev, [createdAsset.id]: false }));
      setBunnyProcessingByAssetId((prev) => ({ ...prev, [createdAsset.id]: true }));
      if (bunnyInputRef.current) bunnyInputRef.current.value = '';
      setBunnyTitle('');
    } catch (error) {
      console.error('Failed to upload Bunny asset:', error);
      toast.error('Failed to upload Bunny video');
      if (uploadedVideoId && uploadToken) {
        await fetch(`/api/videos/${videoId}/assets/bunny-init`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: uploadedVideoId, uploadToken }),
        }).catch(() => undefined);
      }
    } finally {
      setIsUploadingBunny(false);
      setBunnyProgress(0);
    }
  }, [videoId, bunnyTitle, bunnyCdnHostname, createAsset]);

  const handleBunnyUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await handleBunnyFileUpload(file);
  };

  const handleBunnyThumbnailError = (assetId: string) => {
    const alreadyReady = !!bunnyReadyByAssetId[assetId];
    setBunnyThumbnailLoadErrorByAssetId((prev) => ({ ...prev, [assetId]: true }));
    if (!alreadyReady) {
      setBunnyProcessingByAssetId((prev) => (prev[assetId] ? prev : { ...prev, [assetId]: true }));
      setBunnyReadyByAssetId((prev) => ({ ...prev, [assetId]: false }));
    }
    window.setTimeout(() => {
      setBunnyThumbnailRetryKeyByAssetId((prev) => ({ ...prev, [assetId]: Date.now() }));
      setBunnyThumbnailLoadErrorByAssetId((prev) => ({ ...prev, [assetId]: false }));
    }, 10000);
  };

  const handleBunnyThumbnailLoad = (assetId: string) => {
    setBunnyThumbnailLoadErrorByAssetId((prev) => {
      if (!prev[assetId]) return prev;
      return { ...prev, [assetId]: false };
    });
  };

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        setAudioBlob(blob);
        setAudioBlobUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        stream.getTracks().forEach((t) => t.stop());
      };
      mediaRecorderRef.current = recorder;
      recorder.start(100);
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } catch {
      toast.error('Could not access microphone');
    }
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setIsRecording(false);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  const cancelRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setRecordingTime(0);
    setAudioBlob(null);
    setAudioBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setPendingAudioFile(null);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  const handleVoiceUpload = useCallback(async () => {
    const uploadSource = pendingAudioFile ?? audioBlob;
    if (!uploadSource) return;

    const validationError = getAudioUploadValidationError(uploadSource);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setIsUploadingVoice(true);
    try {
      const formData = new FormData();
      if (pendingAudioFile) {
        formData.append('audio', pendingAudioFile);
      } else {
        formData.append('audio', audioBlob!, 'recording.webm');
      }
      formData.append('videoId', videoId);
      const guestUploadToken = await getGuestUploadToken('audio');
      if (guestUploadToken) formData.append('uploadToken', guestUploadToken);

      const uploadRes = await fetch('/api/upload/audio', {
        method: 'POST',
        body: formData,
      });
      const uploadPayload = await readUploadAudioResponse(uploadRes);
      const uploadedUrl = uploadPayload?.data?.url;
      if (!uploadRes.ok || !uploadedUrl) {
        toast.error(
          uploadPayload?.error
          || (uploadRes.status === 413 ? MAX_AUDIO_UPLOAD_SIZE_MESSAGE : null)
          || 'Failed to upload voice recording'
        );
        return;
      }

      const fallbackName = pendingAudioFile
        ? pendingAudioFile.name.replace(/\.[^/.]+$/, '')
        : 'Voice Recording';
      await createAsset({
        provider: 'R2_AUDIO',
        sourceUrl: uploadedUrl,
        displayName: voiceTitle.trim() || fallbackName,
      });
      setVoiceTitle('');
      setAudioBlob(null);
      setAudioBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      setPendingAudioFile(null);
    } catch (error) {
      console.error('Failed to upload voice asset:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to upload voice recording');
    } finally {
      setIsUploadingVoice(false);
    }
  }, [pendingAudioFile, audioBlob, videoId, getGuestUploadToken, createAsset, voiceTitle]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!canUploadAssets) return;
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
  }, [canUploadAssets]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (!canUploadAssets) return;

    const file = Array.from(e.dataTransfer.files)[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      const imageError = await validateImageFile(file);
      if (imageError) { toast.error(imageError); return; }
      // Stage the file so the user can optionally set a name before uploading
      setUploadTab('image');
      setPendingImageFile(file);
    } else if (file.type.startsWith('video/')) {
      // Videos upload immediately (large files, no staging)
      setUploadTab('bunny');
      await handleBunnyFileUpload(file);
    } else if (file.type.startsWith('audio/')) {
      const audioError = getAudioUploadValidationError(file);
      if (audioError) {
        toast.error(audioError);
        return;
      }
      // Stage the file so the user can optionally set a name before uploading
      setUploadTab('voice');
      setPendingAudioFile(file);
    } else {
      toast.error('Unsupported file type. Drop an image, video, or audio file.');
    }
  }, [canUploadAssets, handleBunnyFileUpload]);

  const renderAssetPreview = (asset: VideoAsset) => {
    if (asset.kind === 'AUDIO') {
      return (
        <div className="h-24 w-36 rounded border bg-muted flex flex-col items-center justify-center gap-1">
          <Volume2 className="h-6 w-6 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground font-medium">Voice Recording</span>
        </div>
      );
    }

    if (asset.kind === 'IMAGE') {
      const imageSrc = asset.thumbnailUrl || asset.sourceUrl;
      return (
        <div className="h-24 w-36 rounded border bg-black/20 flex items-center justify-center overflow-hidden">
          {imageSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageSrc} alt={asset.displayName} className="h-full w-full object-contain" />
          ) : (
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
      );
    }

    if (asset.provider === 'YOUTUBE' && asset.providerVideoId) {
      return (
        <div className="h-24 w-36 rounded border overflow-hidden bg-black/70 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={asset.thumbnailUrl || `https://img.youtube.com/vi/${asset.providerVideoId}/mqdefault.jpg`}
            alt={asset.displayName}
            className="h-full w-full object-contain"
          />
        </div>
      );
    }

    const retryKey = bunnyThumbnailRetryKeyByAssetId[asset.id] || 0;
    const isProcessing = !!bunnyProcessingByAssetId[asset.id];
    const isReadyToPlay = !!bunnyReadyByAssetId[asset.id];
    const hasThumbnailLoadError = !!bunnyThumbnailLoadErrorByAssetId[asset.id];
    const thumbnailSrc = asset.thumbnailUrl ? `${asset.thumbnailUrl}${retryKey ? `?t=${retryKey}` : ''}` : null;
    const showThumbnailImage = !!thumbnailSrc && !hasThumbnailLoadError;

    return (
      <div className="h-24 w-36 rounded border overflow-hidden bg-muted relative flex items-center justify-center">
        {showThumbnailImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailSrc}
            alt=""
            className="h-full w-full object-cover"
            onLoad={() => handleBunnyThumbnailLoad(asset.id)}
            onError={() => handleBunnyThumbnailError(asset.id)}
          />
        ) : isReadyToPlay ? (
          <div className="h-full w-full bg-black/60 flex flex-col items-center justify-center gap-1">
            <Play className="h-4 w-4 text-emerald-300" />
            <span className="text-[10px] text-emerald-100 font-medium">Ready to play</span>
          </div>
        ) : (
          <FileVideo className="h-6 w-6 text-muted-foreground" />
        )}
        {isProcessing && !isReadyToPlay && (
          <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-1">
            <Loader2 className="h-4 w-4 animate-spin text-white" />
            <span className="text-[10px] text-white/90 font-medium">
              Processing...
            </span>
          </div>
        )}
      </div>
    );
  };

  const handleOpenAsset = (asset: VideoAsset) => {
    if (asset.kind === 'IMAGE') {
      if (!asset.sourceUrl) {
        toast.error('Preview is unavailable for this asset');
        return;
      }
      setPreviewImage(asset.sourceUrl);
      setPreviewImageTitle(asset.displayName);
      return;
    }
    if (asset.kind === 'AUDIO') {
      setSelectedAsset(asset);
      return;
    }
    if (asset.provider === 'BUNNY' && !bunnyReadyByAssetId[asset.id]) {
      setBunnyProcessingByAssetId((prev) => (prev[asset.id] ? prev : { ...prev, [asset.id]: true }));
    }
    setSelectedAsset(asset);
  };

  const selectedBunnyAssetId = selectedAsset?.provider === 'BUNNY' ? selectedAsset.id : null;
  const isSelectedBunnyProcessing = selectedBunnyAssetId
    ? !!bunnyProcessingByAssetId[selectedBunnyAssetId] && !bunnyReadyByAssetId[selectedBunnyAssetId]
    : false;

  return (
    <div
      className="space-y-4"
      onPaste={handleImagePaste}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">Assets</span>
          <Badge variant="secondary">{assets.length}</Badge>
        </div>
      </div>

      {canUploadAssets ? (
        <div className={cn('rounded-lg border p-3 space-y-3 relative transition-colors', isDragOver && 'border-primary bg-primary/5')}>
          {isDragOver && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg bg-primary/10 border-2 border-dashed border-primary pointer-events-none">
              <UploadCloud className="h-8 w-8 text-primary" />
              <span className="text-sm font-medium text-primary">Drop to upload</span>
            </div>
          )}
          <Tabs value={uploadTab} onValueChange={(value) => setUploadTab(value as 'image' | 'youtube' | 'bunny' | 'voice')}>
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="image">Image</TabsTrigger>
              <TabsTrigger value="youtube">YouTube</TabsTrigger>
              <TabsTrigger value="bunny">Video</TabsTrigger>
              <TabsTrigger value="voice">Voice</TabsTrigger>
            </TabsList>
          </Tabs>

          {uploadTab === 'image' && (
            <div className="space-y-2">
              <Input
                placeholder="Optional name for mentions/tagging"
                value={imageTitle}
                onChange={(event) => setImageTitle(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">If set, this name will be used in @asset mentions.</p>
              <p className="text-xs text-muted-foreground">Tip: you can paste an image here with Ctrl/Cmd+V.</p>
              {pendingImageFile ? (
                <div className="rounded-md border px-2 py-1.5 text-xs flex items-center justify-between gap-2">
                  <span className="truncate">Attached: {pendingImageFile.name}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2"
                    onClick={() => {
                      setPendingImageFile(null);
                      if (imageInputRef.current) imageInputRef.current.value = '';
                    }}
                  >
                    Clear
                  </Button>
                </div>
              ) : null}
              <Button
                variant="outline"
                className="w-full"
                disabled={isUploadingImage || isCreatingAsset}
                onClick={() => {
                  if (pendingImageFile) {
                    void handleImageUpload(pendingImageFile);
                    return;
                  }
                  imageInputRef.current?.click();
                }}
              >
                {isUploadingImage || isCreatingAsset
                  ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  : <UploadCloud className="h-4 w-4 mr-2" />}
                {isUploadingImage ? 'Uploading...' : isCreatingAsset ? 'Saving...' : pendingImageFile ? 'Upload Image' : 'Select Image'}
              </Button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageFileChange}
              />
            </div>
          )}

          {uploadTab === 'youtube' && (
            <div className="space-y-2">
              <Input
                placeholder="https://youtube.com/watch?v=..."
                value={youtubeUrl}
                onChange={(event) => setYoutubeUrl(event.target.value)}
              />
              <Input
                placeholder="Optional display name"
                value={youtubeTitle}
                onChange={(event) => setYoutubeTitle(event.target.value)}
              />
              <Button
                className="w-full"
                disabled={isCreatingAsset || !youtubeUrl.trim()}
                onClick={handleCreateYoutubeAsset}
              >
                <Youtube className="h-4 w-4 mr-2" />
                Add YouTube Asset
              </Button>
            </div>
          )}

          {uploadTab === 'bunny' && (
            <div className="space-y-2">
              <Input
                placeholder="Optional name for mentions/tagging"
                value={bunnyTitle}
                onChange={(event) => setBunnyTitle(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">If set, this name will be used in @asset mentions.</p>
              <Button
                variant="outline"
                className="w-full"
                disabled={isUploadingBunny || isCreatingAsset}
                onClick={() => bunnyInputRef.current?.click()}
              >
                {isUploadingBunny ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
                {isUploadingBunny ? 'Uploading...' : 'Upload Video'}
              </Button>
              <input
                ref={bunnyInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={handleBunnyUpload}
              />
              {isUploadingBunny && (
                <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                  <div className="bg-primary h-2 rounded-full" style={{ width: `${bunnyProgress}%` }} />
                </div>
              )}
            </div>
          )}

          {uploadTab === 'voice' && (
            <div className="space-y-2">
              <Input
                placeholder="Optional name for this recording"
                value={voiceTitle}
                onChange={(e) => setVoiceTitle(e.target.value)}
                disabled={isRecording || isUploadingVoice}
              />
              {pendingAudioFile ? (
                <div className="space-y-2">
                  <div className="rounded-md border px-2 py-1.5 text-xs flex items-center justify-between gap-2">
                    <span className="truncate">Attached: {pendingAudioFile.name}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2"
                      onClick={() => setPendingAudioFile(null)}
                    >
                      Clear
                    </Button>
                  </div>
                  <Button
                    className="w-full"
                    disabled={isUploadingVoice || isCreatingAsset}
                    onClick={handleVoiceUpload}
                  >
                    {isUploadingVoice ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
                    {isUploadingVoice ? 'Uploading...' : 'Upload File'}
                  </Button>
                </div>
              ) : isRecording ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                    </span>
                    <span className="text-red-500 font-medium">Recording</span>
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {String(Math.floor(recordingTime / 60)).padStart(2, '0')}:{String(recordingTime % 60).padStart(2, '0')}
                    </span>
                  </div>
                  <Button size="icon" variant="outline" className="h-9 w-9 shrink-0" title="Stop recording" onClick={stopRecording}>
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0" title="Cancel recording" onClick={cancelRecording}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : audioBlob ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 p-2 bg-muted rounded">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0"
                      onClick={() => audioBlobUrl && playVoice('recording-preview', audioBlobUrl, recordingTime)}
                    >
                      {playingVoiceId === 'recording-preview' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <div className="flex-1 h-2 bg-primary/20 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: playingVoiceId === 'recording-preview' ? `${voiceProgress}%` : '0%' }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {playingVoiceId === 'recording-preview'
                        ? `${formatTime(voiceCurrentTime)} / ${formatTime(recordingTime)}`
                        : formatTime(recordingTime)}
                    </span>
                    {playingVoiceId === 'recording-preview' && (
                      <button
                        onClick={toggleVoiceSpeed}
                        className="text-[10px] font-bold px-1 py-0.5 rounded bg-muted hover:bg-muted-foreground/20 tabular-nums shrink-0"
                      >
                        {voicePlaybackRate}x
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      disabled={isUploadingVoice || isCreatingAsset}
                      onClick={handleVoiceUpload}
                    >
                      {isUploadingVoice ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
                      {isUploadingVoice ? 'Uploading...' : 'Upload Recording'}
                    </Button>
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Discard and re-record" onClick={cancelRecording}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" className="w-full" onClick={startRecording} disabled={isUploadingVoice || isCreatingAsset}>
                  <Mic className="h-4 w-4 mr-2" />
                  Start Recording
                </Button>
              )}
              <p className="text-xs text-muted-foreground">Or drag an audio file anywhere onto this panel.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border p-3 text-xs text-muted-foreground">
          You do not have permission to upload assets.
        </div>
      )}

      <AssetListSection
        assets={sortedAssets}
        isLoadingAssets={isLoadingAssets}
        focusedAssetId={focusedAssetId}
        bunnyProcessingByAssetId={bunnyProcessingByAssetId}
        bunnyReadyByAssetId={bunnyReadyByAssetId}
        activeDownloadAssetId={activeDownloadAssetId}
        activeDeleteAssetId={activeDeleteAssetId}
        canDownloadAssets={canDownloadAssets}
        hasMoreAssets={hasMoreAssets}
        isLoadingMoreAssets={isLoadingMoreAssets}
        onViewAsset={handleOpenAsset}
        onDownloadAsset={(asset, preference) => void downloadAsset(asset, preference)}
        onDeleteAsset={(assetId) => void deleteAsset(assetId)}
        onLoadMoreAssets={() => void loadMoreAssets()}
        renderAssetPreview={renderAssetPreview}
      />

      <ImagePreviewDialog
        previewImage={previewImage}
        title={previewImageTitle}
        downloadFileName={previewImageTitle}
        canDownload={canDownloadAssets}
        onClose={() => {
          setPreviewImage(null);
          setPreviewImageTitle(null);
        }}
      />

      <Dialog open={selectedAsset?.kind === 'AUDIO'} onOpenChange={(open) => { if (!open) { stopVoice(); setSelectedAsset(null); } }}>
        <DialogContent className="max-w-sm">
          <DialogTitle>{selectedAsset?.displayName || 'Voice Recording'}</DialogTitle>
          {selectedAsset?.sourceUrl ? (
            <div className="flex items-center gap-2 p-2 bg-muted rounded">
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                onClick={() => selectedAsset.sourceUrl && playVoice(selectedAsset.id, selectedAsset.sourceUrl)}
              >
                {playingVoiceId === selectedAsset?.id ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </Button>
              <div className="flex-1 h-2 bg-primary/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full"
                  style={{ width: playingVoiceId === selectedAsset?.id ? `${voiceProgress}%` : '0%' }}
                />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                {playingVoiceId === selectedAsset?.id ? formatTime(voiceCurrentTime) : '00:00'}
              </span>
              {playingVoiceId === selectedAsset?.id && (
                <button
                  onClick={toggleVoiceSpeed}
                  className="text-[10px] font-bold px-1 py-0.5 rounded bg-muted hover:bg-muted-foreground/20 tabular-nums shrink-0"
                >
                  {voicePlaybackRate}x
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Audio preview unavailable.</p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={selectedAsset?.kind === 'VIDEO'} onOpenChange={(open) => !open && setSelectedAsset(null)}>
        <DialogContent
          showCloseButton={false}
          className="max-w-none sm:max-w-none w-screen h-screen max-h-screen p-0 overflow-hidden bg-black/90 border-none shadow-none rounded-none flex items-center justify-center"
          onClick={() => setSelectedAsset(null)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              setSelectedAsset(null);
            }
          }}
        >
          <DialogTitle className="sr-only">{selectedAsset?.displayName || 'Video Preview'}</DialogTitle>

          <div className="w-[min(96vw,1500px)] h-[min(94vh,1000px)] border border-border/60 bg-black/80 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="shrink-0 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 py-1.5 backdrop-blur-sm">
              <p className="flex-1 min-w-0 text-sm text-foreground truncate" title={selectedAsset?.displayName || undefined}>
                {selectedAsset?.displayName || 'Video Preview'}
              </p>
              {selectedAsset?.provider === 'YOUTUBE' && selectedAsset.providerVideoId ? (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                >
                  <a
                    href={`https://www.youtube.com/watch?v=${selectedAsset.providerVideoId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open on YouTube
                  </a>
                </Button>
              ) : null}
              {selectedAsset?.provider === 'BUNNY' && canDownloadAssets ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      title="Download Bunny video"
                      aria-label="Download Bunny video"
                      disabled={
                        activeDownloadAssetId === selectedAsset.id
                        || isSelectedBunnyProcessing
                      }
                    >
                      {activeDownloadAssetId === selectedAsset.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void downloadAsset(selectedAsset, 'original')}>
                      <Download className="h-3 w-3 mr-2" />
                      Original
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void downloadAsset(selectedAsset, 'compressed')}>
                      <Download className="h-3 w-3 mr-2" />
                      Compressed
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setSelectedAsset(null)}
              >
                <span className="sr-only">Close</span>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 min-h-0 w-full p-2 sm:p-4">
            {selectedAsset ? (
              selectedAsset.provider === 'YOUTUBE' && selectedAsset.providerVideoId ? (
                <div className="w-full h-full rounded-md border overflow-hidden bg-black">
                  <iframe
                    ref={youtubeIframeRef}
                    className="w-full h-full"
                    src={`https://www.youtube.com/embed/${selectedAsset.providerVideoId}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1${typeof window !== 'undefined' ? `&origin=${encodeURIComponent(window.location.origin)}` : ''}`}
                    title={selectedAsset.displayName}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    referrerPolicy="strict-origin-when-cross-origin"
                    allowFullScreen
                  />
                </div>
              ) : (
                <BunnyPreviewPlayer
                  ref={bunnyPreviewPlayerRef}
                  providerVideoId={selectedAsset.providerVideoId}
                  isProcessing={isSelectedBunnyProcessing}
                  onReadyToPlay={() => {
                    if (!selectedBunnyAssetId) return;
                    setBunnyReadyByAssetId((prev) => ({ ...prev, [selectedBunnyAssetId]: true }));
                    setBunnyProcessingByAssetId((prev) => ({ ...prev, [selectedBunnyAssetId]: false }));
                  }}
                />
              )
            ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
});
