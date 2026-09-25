'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import type { AnnotationCanvasHandle, AnnotationStroke } from '@/components/annotation-canvas';
import type {
  Comment,
  CommentActionsConfig,
  CommentImage,
  CommentReply,
  CommentTag,
  Version,
  VideoData,
} from '@/components/video-page/types';
import {
  extractPastedImageFiles,
  validateImageFile,
} from '@/components/video-page/image-upload-utils';
import { MAX_COMMENT_IMAGES } from '@/lib/comment-images';
import { validateAnnotationStrokes } from '@/lib/validation';
import { withWebmDuration } from '@/lib/webm-duration';
import { ApiRequestError, apiRequestError, toastApiError } from '@/lib/client/api-error';

interface UseCommentActionsParams extends CommentActionsConfig {
  isImage?: boolean;
  setVideo: Dispatch<SetStateAction<VideoData | null>>;
  activeVersionId: string | null;
  activeVersion: (Version & { comments: Comment[] }) | undefined;
  currentTime: number;
  isGuest: boolean;
  normalizedGuestName: string;
  currentUserName: string | null;
  canResolveComments: boolean;
  availableTags: CommentTag[];
  selectedTagId: string | null;
  setSelectedTagId: Dispatch<SetStateAction<string | null>>;
  annotationStrokes: AnnotationStroke[] | null;
  setAnnotationStrokes: Dispatch<SetStateAction<AnnotationStroke[] | null>>;
  isAnnotating: boolean;
  setIsAnnotating: Dispatch<SetStateAction<boolean>>;
  setViewingAnnotation: Dispatch<SetStateAction<AnnotationStroke[] | null>>;
  annotationCanvasRef: RefObject<AnnotationCanvasHandle | null>;
  editAnnotationCanvasRef: RefObject<AnnotationCanvasHandle | null>;
  fetchVersionComments: (versionId: string, useEtag: boolean) => Promise<void>;
  fetchAssets: () => Promise<void>;
}

/** Which of the three editors an attachment is being staged for. */
export type ImageAttachTarget = 'comment' | 'reply' | 'edit';

function getAudioUploadFilename(blob: Blob): string {
  const mime = blob.type.split(';')[0].trim().toLowerCase();
  if (mime === 'audio/mp4') return 'recording.m4a';
  if (mime === 'audio/ogg' || mime === 'audio/opus') return 'recording.ogg';
  if (mime === 'audio/mpeg') return 'recording.mp3';
  if (mime === 'audio/wav') return 'recording.wav';
  return 'recording.webm';
}

export function useCommentActions({
  videoId,
  isImage = false,
  setVideo,
  activeVersionId,
  activeVersion,
  currentTime,
  isGuest,
  normalizedGuestName,
  currentUserName,
  canResolveComments,
  availableTags,
  selectedTagId,
  setSelectedTagId,
  annotationStrokes,
  setAnnotationStrokes,
  isAnnotating,
  setIsAnnotating,
  setViewingAnnotation,
  annotationCanvasRef,
  editAnnotationCanvasRef,
  fetchVersionComments,
  fetchAssets,
}: UseCommentActionsParams) {
  const [commentText, setCommentText] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [commentRangeStart, setCommentRangeStart] = useState<number | null>(null);
  const [commentRangeEnd, setCommentRangeEnd] = useState<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartedAtRef = useRef(0);

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [isReplyRecording, setIsReplyRecording] = useState(false);
  const [replyRecordingTime, setReplyRecordingTime] = useState(0);
  const [replyAudioBlob, setReplyAudioBlob] = useState<Blob | null>(null);
  const [isUploadingReplyAudio, setIsUploadingReplyAudio] = useState(false);
  const [replyImageFiles, setReplyImageFiles] = useState<File[]>([]);
  const [isUploadingReplyImage, setIsUploadingReplyImage] = useState(false);
  const [replyRangeStart, setReplyRangeStart] = useState<number | null>(null);
  const [replyRangeEnd, setReplyRangeEnd] = useState<number | null>(null);
  const replyImageInputRef = useRef<HTMLInputElement>(null);
  const replyMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const replyAudioChunksRef = useRef<Blob[]>([]);
  const replyRecordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const replyRecordingStartedAtRef = useRef(0);

  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // `undefined` means "this editor does not manage a tag", which is the reply editor:
  // replies have no tag picker. `null` means "no tag", which the comment editor seeds
  // from the comment itself. Initialising to `null` made `editTagId !== undefined` always
  // true, so editing a reply's text sent `tagId: null` and cleared its tag, or sent a
  // stale value left over from a previous edit.
  const [editTagId, setEditTagId] = useState<string | null | undefined>(undefined);
  const [editAnnotationData, setEditAnnotationData] = useState<string | null | undefined>(
    undefined
  );
  const [isEditingAnnotation, setIsEditingAnnotation] = useState(false);
  // The images the edited comment keeps, and the ones staged to be added to it.
  const [editImageUrls, setEditImageUrls] = useState<string[]>([]);
  const [editImageFiles, setEditImageFiles] = useState<File[]>([]);
  const editImageInputRef = useRef<HTMLInputElement>(null);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  const isMutatingRef = useRef(false);

  const clearCommentRangeSelection = useCallback(() => {
    setCommentRangeStart(null);
    setCommentRangeEnd(null);
  }, []);

  const clearReplyRangeSelection = useCallback(() => {
    setReplyRangeStart(null);
    setReplyRangeEnd(null);
  }, []);

  const toggleCommentRangeSelection = useCallback(() => {
    if (commentRangeStart === null || commentRangeEnd !== null) {
      setCommentRangeStart(currentTime);
      setCommentRangeEnd(null);
      return;
    }

    setCommentRangeStart(Math.min(commentRangeStart, currentTime));
    setCommentRangeEnd(Math.max(commentRangeStart, currentTime));
  }, [commentRangeEnd, commentRangeStart, currentTime]);

  const toggleReplyRangeSelection = useCallback(() => {
    if (replyRangeStart === null || replyRangeEnd !== null) {
      setReplyRangeStart(currentTime);
      setReplyRangeEnd(null);
      return;
    }

    setReplyRangeStart(Math.min(replyRangeStart, currentTime));
    setReplyRangeEnd(Math.max(replyRangeStart, currentTime));
  }, [currentTime, replyRangeEnd, replyRangeStart]);

  const getGuestUploadToken = useCallback(
    async (intent: 'audio' | 'image') => {
      if (!isGuest) return null;

      const response = await fetch(`/api/watch/${videoId}/upload-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: { token?: string };
        error?: string;
      } | null;
      const token = payload?.data?.token;
      if (!response.ok || !token) {
        throw apiRequestError(payload, 'Failed to prepare upload');
      }
      return token;
    },
    [isGuest, videoId]
  );

  /** Upload a batch of staged images and hand back their URLs, in the same order. */
  const uploadImageFiles = useCallback(
    async (files: File[]): Promise<string[]> => {
      if (files.length === 0) return [];

      // One grant covers the whole batch: it is bound to the intent and the
      // client, not to a single file.
      const uploadToken = await getGuestUploadToken('image');

      return Promise.all(
        files.map(async (file) => {
          const formData = new FormData();
          formData.append('image', file);
          formData.append('videoId', videoId);
          if (uploadToken) formData.append('uploadToken', uploadToken);

          const response = await fetch('/api/upload/image', {
            method: 'POST',
            body: formData,
          });
          if (!response.ok) {
            // The attachments go up before the comment does, so a full account
            // fails here and never reaches the comment at all. Thrown with the
            // code attached so the caller can offer the way out.
            const payload = (await response.json().catch(() => null)) as {
              error?: string;
              code?: string;
            } | null;
            throw apiRequestError(payload, 'Failed to upload image');
          }
          const payload = await response.json();
          return payload.data.url as string;
        })
      );
    },
    [getGuestUploadToken, videoId]
  );

  /** Stage validated images on one of the editors, up to the per-comment cap. */
  const attachImageFiles = useCallback(
    async (files: File[], target: ImageAttachTarget) => {
      if (files.length === 0) return;

      for (const file of files) {
        const imageError = await validateImageFile(file);
        if (imageError) {
          toast.error(imageError);
          return;
        }
      }

      const staged =
        target === 'reply' ? replyImageFiles : target === 'edit' ? editImageFiles : imageFiles;
      // Images the edited comment already has count against the same cap.
      const alreadyOnComment = target === 'edit' ? editImageUrls.length : 0;
      const room = MAX_COMMENT_IMAGES - alreadyOnComment - staged.length;
      if (room <= 0) {
        toast.error(`A comment can have at most ${MAX_COMMENT_IMAGES} images`);
        return;
      }
      if (files.length > room) {
        toast.error(
          room === 1
            ? 'Only 1 more image fits on this comment'
            : `Only ${room} more images fit on this comment`
        );
      }

      const next = [...staged, ...files.slice(0, room)];
      if (target === 'reply') setReplyImageFiles(next);
      else if (target === 'edit') setEditImageFiles(next);
      else setImageFiles(next);
    },
    [editImageFiles, editImageUrls, imageFiles, replyImageFiles]
  );

  const removeImageFile = useCallback((index: number, target: ImageAttachTarget) => {
    const drop = (files: File[]) => files.filter((_, current) => current !== index);
    if (target === 'reply') setReplyImageFiles(drop);
    else if (target === 'edit') setEditImageFiles(drop);
    else setImageFiles(drop);
  }, []);

  const handleAddComment = useCallback(
    async (voiceData?: { url: string; duration: number }) => {
      if (
        !voiceData &&
        imageFiles.length === 0 &&
        !commentText.trim() &&
        !annotationStrokes &&
        !isAnnotating
      )
        return;
      if (!activeVersion || !activeVersionId) return;

      let effectiveStrokes = annotationStrokes;
      if (isAnnotating && annotationCanvasRef.current) {
        const canvasStrokes = annotationCanvasRef.current.getStrokes();
        if (canvasStrokes.length > 0) {
          effectiveStrokes = canvasStrokes;
        }
      }

      const tempId = `temp-${Date.now()}`;
      const commentTimestamp = isImage ? 0 : (commentRangeStart ?? currentTime);
      const serializedAnnotation = effectiveStrokes ? JSON.stringify(effectiveStrokes) : null;
      const hasImages = imageFiles.length > 0;
      const optimisticComment: Comment = {
        id: tempId,
        content: voiceData || hasImages ? commentText.trim() || null : commentText,
        timestamp: commentTimestamp,
        timestampEnd: isImage ? null : commentRangeEnd,
        voiceUrl: voiceData?.url ?? null,
        voiceDuration: voiceData?.duration ?? null,
        images: imageFiles.map((file, index) => ({
          id: `${tempId}-image-${index}`,
          url: URL.createObjectURL(file),
        })),
        annotationData: serializedAnnotation,
        isResolved: false,
        createdAt: new Date().toISOString(),
        author: isGuest ? null : { id: 'current-user', name: currentUserName, image: null },
        guestName: isGuest ? normalizedGuestName : null,
        canEdit: true,
        canDelete: true,
        tag: availableTags.find((t) => t.id === selectedTagId) || null,
        replies: [],
      };

      setVideo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === activeVersionId ? { ...v, comments: [...v.comments, optimisticComment] } : v
          ),
        };
      });

      setCommentText('');
      setSelectedTagId(availableTags.length > 0 ? availableTags[0].id : null);
      setAudioBlob(null);
      setImageFiles([]);
      setAnnotationStrokes(null);
      setIsAnnotating(false);
      clearCommentRangeSelection();
      setViewingAnnotation(effectiveStrokes || null);

      setIsSubmittingComment(true);
      isMutatingRef.current = true;

      try {
        let uploadedImageUrls: string[] = [];

        if (hasImages) {
          setIsUploadingImage(true);
          uploadedImageUrls = await uploadImageFiles(imageFiles);
        }

        const res = await fetch(`/api/versions/${activeVersion.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: voiceData || hasImages ? commentText.trim() || null : commentText,
            timestamp: commentTimestamp,
            ...(!isImage && commentRangeEnd !== null && { timestampEnd: commentRangeEnd }),
            ...(voiceData && { voiceUrl: voiceData.url, voiceDuration: voiceData.duration }),
            ...(uploadedImageUrls.length > 0 && { imageUrls: uploadedImageUrls }),
            ...(isGuest && normalizedGuestName && { guestName: normalizedGuestName }),
            ...(selectedTagId && { tagId: selectedTagId }),
            ...(effectiveStrokes && { annotationData: effectiveStrokes }),
          }),
        });

        if (res.ok) {
          const response = await res.json();
          const newComment = response.data;
          setVideo((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === activeVersionId
                  ? {
                      ...v,
                      comments: v.comments.map((c) =>
                        c.id === tempId
                          ? { ...newComment, replies: newComment.replies || [] }
                          : { ...c, replies: c.replies || [] }
                      ),
                    }
                  : v
              ),
            };
          });

          // If images were attached, refresh the assets list
          if (uploadedImageUrls.length > 0) {
            void fetchAssets();
          }
        } else {
          setVideo((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === activeVersionId
                  ? { ...v, comments: v.comments.filter((c) => c.id !== tempId) }
                  : v
              ),
            };
          });
          const payload = (await res.json().catch(() => null)) as {
            error?: string;
            code?: string;
          } | null;
          toastApiError(payload, 'Failed to add comment');
        }
      } catch (error) {
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? { ...v, comments: v.comments.filter((c) => c.id !== tempId) }
                : v
            ),
          };
        });
        // A network fault has no message anybody wants to see, so only an
        // ApiRequestError speaks for itself; toastApiError falls back for the rest.
        toastApiError(error instanceof ApiRequestError ? error : null, 'Failed to add comment');
      } finally {
        setIsSubmittingComment(false);
        setIsUploadingImage(false);
        isMutatingRef.current = false;
      }
    },
    [
      commentText,
      commentRangeEnd,
      commentRangeStart,
      isImage,
      currentTime,
      activeVersion,
      activeVersionId,
      isGuest,
      normalizedGuestName,
      currentUserName,
      selectedTagId,
      availableTags,
      imageFiles,
      uploadImageFiles,
      annotationStrokes,
      isAnnotating,
      annotationCanvasRef,
      setSelectedTagId,
      setAnnotationStrokes,
      setIsAnnotating,
      clearCommentRangeSelection,
      setViewingAnnotation,
      setVideo,
      fetchAssets,
    ]
  );

  const handleImageSelect = useCallback(
    async (e: ChangeEvent<HTMLInputElement>, target: ImageAttachTarget = 'comment') => {
      const files = Array.from(e.target.files ?? []);
      // Clearing the input lets the same file be picked again after it is removed.
      e.target.value = '';
      await attachImageFiles(files, target);
    },
    [attachImageFiles]
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>, target: ImageAttachTarget = 'comment') => {
      const files = extractPastedImageFiles(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      await attachImageFiles(files, target);
    },
    [attachImageFiles]
  );

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>, target: ImageAttachTarget = 'comment') => {
      e.preventDefault();
      const files = extractPastedImageFiles(e.dataTransfer);
      if (files.length === 0) return;
      await attachImageFiles(files, target);
    },
    [attachImageFiles]
  );

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });

      audioChunksRef.current = [];
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const elapsedMs = Date.now() - recordingStartedAtRef.current;
        const recordedMime = mediaRecorder.mimeType || 'audio/webm';
        const raw = new Blob(audioChunksRef.current, { type: recordedMime });
        // MediaRecorder leaves the WebM duration unset, so stamp it in before the
        // blob reaches a player or the upload.
        setAudioBlob(await withWebmDuration(raw, elapsedMs));
        setRecordingTime(elapsedMs / 1000);
        stream.getTracks().forEach((track) => track.stop());
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
      };

      mediaRecorder.start(100);
      setIsRecording(true);
      setRecordingTime(0);
      // Background tabs throttle timers, so read the clock instead of counting ticks.
      recordingStartedAtRef.current = Date.now();
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((Date.now() - recordingStartedAtRef.current) / 1000);
      }, 100);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setAudioBlob(null);
    setRecordingTime(0);
  }, []);

  const submitVoiceComment = useCallback(async () => {
    if (!audioBlob || !activeVersion) return;
    setIsUploadingAudio(true);

    try {
      const formData = new FormData();
      const uploadFilename = getAudioUploadFilename(audioBlob);
      formData.append('audio', audioBlob, uploadFilename);
      formData.append('videoId', videoId);
      const uploadToken = await getGuestUploadToken('audio');
      if (uploadToken) formData.append('uploadToken', uploadToken);

      const uploadRes = await fetch('/api/upload/audio', {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error('Failed to upload audio');
      }

      const uploadData = await uploadRes.json();
      const { url } = uploadData.data;

      await handleAddComment({ url, duration: recordingTime });
      setAudioBlob(null);
      setRecordingTime(0);
    } catch (err) {
      console.error('Failed to submit voice comment:', err);
    } finally {
      setIsUploadingAudio(false);
    }
  }, [audioBlob, activeVersion, recordingTime, handleAddComment, videoId, getGuestUploadToken]);

  const submitCommentWithMedia = useCallback(async () => {
    if (!activeVersion) return;

    if (audioBlob && imageFiles.length === 0 && !commentText.trim()) {
      submitVoiceComment();
      return;
    }

    if (audioBlob) setIsUploadingAudio(true);
    if (imageFiles.length > 0) setIsUploadingImage(true);

    try {
      let voiceData: { url: string; duration: number } | undefined;
      if (audioBlob) {
        const formData = new FormData();
        formData.append('audio', audioBlob, getAudioUploadFilename(audioBlob));
        formData.append('videoId', videoId);
        const uploadToken = await getGuestUploadToken('audio');
        if (uploadToken) formData.append('uploadToken', uploadToken);
        const uploadRes = await fetch('/api/upload/audio', { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error('Failed to upload audio');
        const uploadData = await uploadRes.json();
        voiceData = { url: uploadData.data.url, duration: recordingTime };
      }

      await handleAddComment(voiceData);

      setAudioBlob(null);
      setRecordingTime(0);
      setImageFiles([]);
      if (imageInputRef.current) imageInputRef.current.value = '';
    } catch (err) {
      console.error('Failed to submit comment with media:', err);
      toast.error('Failed to upload media');
    } finally {
      setIsUploadingAudio(false);
      setIsUploadingImage(false);
    }
  }, [
    audioBlob,
    imageFiles,
    activeVersion,
    recordingTime,
    commentText,
    submitVoiceComment,
    handleAddComment,
    videoId,
    getGuestUploadToken,
  ]);

  const handleResolveComment = useCallback(
    async (commentId: string, currentlyResolved: boolean) => {
      if (!canResolveComments) {
        toast.error('Only admins can resolve comments');
        return;
      }
      if (!activeVersionId) return;

      isMutatingRef.current = true;
      // The optimistic flip, the request body and the rollback all derive from the same
      // value. Flipping relative to the row (`!c.isResolved`) while the body and the
      // rollback came from `currentlyResolved` meant a failed request could leave the
      // comment in a state it was never in whenever the two disagreed.
      const nextResolved = !currentlyResolved;
      setVideo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === activeVersionId
              ? {
                  ...v,
                  comments: v.comments.map((c) =>
                    c.id === commentId ? { ...c, isResolved: nextResolved } : c
                  ),
                }
              : v
          ),
        };
      });

      try {
        const res = await fetch(`/api/comments/${commentId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isResolved: nextResolved }),
        });

        if (!res.ok) {
          setVideo((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === activeVersionId
                  ? {
                      ...v,
                      comments: v.comments.map((c) =>
                        c.id === commentId ? { ...c, isResolved: currentlyResolved } : c
                      ),
                    }
                  : v
              ),
            };
          });
          toast.error('Failed to update comment');
        }
      } catch {
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? {
                    ...v,
                    comments: v.comments.map((c) =>
                      c.id === commentId ? { ...c, isResolved: currentlyResolved } : c
                    ),
                  }
                : v
            ),
          };
        });
        toast.error('Failed to update comment');
      } finally {
        isMutatingRef.current = false;
      }
    },
    [activeVersionId, canResolveComments, setVideo]
  );

  const handleReplyComment = useCallback(
    async (
      parentId: string,
      voiceData?: { url: string; duration: number },
      alreadyUploadedImageUrls?: string[]
    ) => {
      if (!voiceData && replyImageFiles.length === 0 && !replyText.trim()) return;
      if (!activeVersion || !activeVersionId) return;

      const hasReplyImages = replyImageFiles.length > 0;
      const tempId = `temp-reply-${Date.now()}`;
      const replyTimestamp = isImage ? 0 : (replyRangeStart ?? currentTime);
      const optimisticReply: CommentReply = {
        id: tempId,
        content: voiceData || hasReplyImages ? replyText.trim() || null : replyText,
        timestamp: replyTimestamp,
        timestampEnd: isImage ? null : replyRangeEnd,
        voiceUrl: voiceData?.url ?? null,
        voiceDuration: voiceData?.duration ?? null,
        images: replyImageFiles.map((file, index) => ({
          id: `${tempId}-image-${index}`,
          url: URL.createObjectURL(file),
        })),
        annotationData: null,
        createdAt: new Date().toISOString(),
        author: isGuest ? null : { id: 'current-user', name: currentUserName, image: null },
        guestName: isGuest ? normalizedGuestName : null,
        canEdit: true,
        canDelete: true,
        tag: null,
      };

      setVideo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === activeVersionId
              ? {
                  ...v,
                  comments: v.comments.map((c) =>
                    c.id === parentId
                      ? { ...c, replies: [...(c.replies || []), optimisticReply] }
                      : c
                  ),
                }
              : v
          ),
        };
      });

      setReplyText('');
      setReplyingTo(null);
      setReplyAudioBlob(null);
      setReplyRecordingTime(0);
      setReplyImageFiles([]);
      clearReplyRangeSelection();

      setIsSubmittingReply(true);
      isMutatingRef.current = true;

      try {
        let submittedImageUrls: string[] = alreadyUploadedImageUrls ?? [];

        if (hasReplyImages && submittedImageUrls.length === 0) {
          setIsUploadingReplyImage(true);
          submittedImageUrls = await uploadImageFiles(replyImageFiles);
        }

        const res = await fetch(`/api/versions/${activeVersion.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content:
              voiceData || submittedImageUrls.length > 0 ? replyText.trim() || null : replyText,
            timestamp: replyTimestamp,
            ...(!isImage && replyRangeEnd !== null && { timestampEnd: replyRangeEnd }),
            parentId,
            ...(voiceData && { voiceUrl: voiceData.url, voiceDuration: voiceData.duration }),
            ...(submittedImageUrls.length > 0 && { imageUrls: submittedImageUrls }),
            ...(isGuest && normalizedGuestName && { guestName: normalizedGuestName }),
          }),
        });

        if (res.ok) {
          const response = await res.json();
          const newReply = response.data;
          setVideo((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === activeVersionId
                  ? {
                      ...v,
                      comments: v.comments.map((c) =>
                        c.id === parentId
                          ? {
                              ...c,
                              replies: (c.replies || []).map((r) =>
                                r.id === tempId ? newReply : r
                              ),
                            }
                          : { ...c, replies: c.replies || [] }
                      ),
                    }
                  : v
              ),
            };
          });

          // If images were attached, refresh the assets list
          if (submittedImageUrls.length > 0) {
            void fetchAssets();
          }
        } else {
          setVideo((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === activeVersionId
                  ? {
                      ...v,
                      comments: v.comments.map((c) =>
                        c.id === parentId
                          ? { ...c, replies: (c.replies || []).filter((r) => r.id !== tempId) }
                          : c
                      ),
                    }
                  : v
              ),
            };
          });
          toast.error('Failed to add reply');
        }
      } catch {
        setVideo((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            versions: prev.versions.map((v) =>
              v.id === activeVersionId
                ? {
                    ...v,
                    comments: v.comments.map((c) =>
                      c.id === parentId
                        ? { ...c, replies: (c.replies || []).filter((r) => r.id !== tempId) }
                        : c
                    ),
                  }
                : v
            ),
          };
        });
        toast.error('Failed to add reply');
      } finally {
        setIsSubmittingReply(false);
        setIsUploadingReplyImage(false);
        isMutatingRef.current = false;
      }
    },
    [
      replyText,
      replyRangeEnd,
      replyRangeStart,
      isImage,
      activeVersion,
      activeVersionId,
      currentTime,
      isGuest,
      normalizedGuestName,
      currentUserName,
      replyImageFiles,
      uploadImageFiles,
      setVideo,
      fetchAssets,
      clearReplyRangeSelection,
    ]
  );

  const startReplyRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      replyAudioChunksRef.current = [];
      replyMediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) replyAudioChunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        const elapsedMs = Date.now() - replyRecordingStartedAtRef.current;
        const recordedMime = mediaRecorder.mimeType || 'audio/webm';
        const raw = new Blob(replyAudioChunksRef.current, { type: recordedMime });
        setReplyAudioBlob(await withWebmDuration(raw, elapsedMs));
        setReplyRecordingTime(elapsedMs / 1000);
        stream.getTracks().forEach((track) => track.stop());
        if (replyRecordingTimerRef.current) {
          clearInterval(replyRecordingTimerRef.current);
          replyRecordingTimerRef.current = null;
        }
      };
      mediaRecorder.start(100);
      setIsReplyRecording(true);
      setReplyRecordingTime(0);
      replyRecordingStartedAtRef.current = Date.now();
      replyRecordingTimerRef.current = setInterval(() => {
        setReplyRecordingTime((Date.now() - replyRecordingStartedAtRef.current) / 1000);
      }, 100);
    } catch (err) {
      console.error('Failed to start reply recording:', err);
    }
  }, []);

  const stopReplyRecording = useCallback(() => {
    if (replyMediaRecorderRef.current && replyMediaRecorderRef.current.state !== 'inactive') {
      replyMediaRecorderRef.current.stop();
    }
    setIsReplyRecording(false);
  }, []);

  const cancelReplyRecording = useCallback(() => {
    if (replyMediaRecorderRef.current && replyMediaRecorderRef.current.state !== 'inactive') {
      replyMediaRecorderRef.current.stop();
    }
    setIsReplyRecording(false);
    setReplyAudioBlob(null);
    setReplyRecordingTime(0);
  }, []);

  const submitVoiceReply = useCallback(
    async (parentId: string) => {
      if (!replyAudioBlob || !activeVersion) return;
      setIsUploadingReplyAudio(true);
      try {
        const formData = new FormData();
        formData.append('audio', replyAudioBlob, getAudioUploadFilename(replyAudioBlob));
        formData.append('videoId', videoId);
        const uploadToken = await getGuestUploadToken('audio');
        if (uploadToken) formData.append('uploadToken', uploadToken);
        const uploadRes = await fetch('/api/upload/audio', { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error('Failed to upload audio');
        const uploadData = await uploadRes.json();
        const { url } = uploadData.data;
        await handleReplyComment(parentId, { url, duration: replyRecordingTime });
      } catch (err) {
        console.error('Failed to submit voice reply:', err);
      } finally {
        setIsUploadingReplyAudio(false);
      }
    },
    [
      replyAudioBlob,
      activeVersion,
      replyRecordingTime,
      handleReplyComment,
      videoId,
      getGuestUploadToken,
    ]
  );

  const submitReplyWithMedia = useCallback(
    async (parentId: string) => {
      if (!activeVersion) return;

      if (replyAudioBlob && replyImageFiles.length === 0 && !replyText.trim()) {
        submitVoiceReply(parentId);
        return;
      }

      if (replyAudioBlob) setIsUploadingReplyAudio(true);
      if (replyImageFiles.length > 0) setIsUploadingReplyImage(true);

      try {
        let voiceData: { url: string; duration: number } | undefined;

        if (replyAudioBlob) {
          const formData = new FormData();
          formData.append('audio', replyAudioBlob, getAudioUploadFilename(replyAudioBlob));
          formData.append('videoId', videoId);
          const uploadToken = await getGuestUploadToken('audio');
          if (uploadToken) formData.append('uploadToken', uploadToken);
          const uploadRes = await fetch('/api/upload/audio', { method: 'POST', body: formData });
          if (!uploadRes.ok) throw new Error('Failed to upload audio reply');
          const uploadData = await uploadRes.json();
          voiceData = { url: uploadData.data.url, duration: replyRecordingTime };
        }

        await handleReplyComment(parentId, voiceData);

        setReplyAudioBlob(null);
        setReplyRecordingTime(0);
        setReplyImageFiles([]);
        if (replyImageInputRef.current) replyImageInputRef.current.value = '';
      } catch (err) {
        console.error('Failed to submit reply with media:', err);
        toast.error('Failed to upload media');
      } finally {
        setIsUploadingReplyAudio(false);
        setIsUploadingReplyImage(false);
      }
    },
    [
      replyAudioBlob,
      replyImageFiles,
      activeVersion,
      replyRecordingTime,
      replyText,
      submitVoiceReply,
      handleReplyComment,
      videoId,
      getGuestUploadToken,
    ]
  );

  const startEditingComment = useCallback((comment: Comment) => {
    setEditingCommentId(comment.id);
    setEditText(comment.content || '');
    setEditTagId(comment.tag?.id || null);
    setEditImageUrls(comment.images.map((image) => image.url));
    setEditImageFiles([]);
  }, []);

  const startEditingReply = useCallback((reply: CommentReply) => {
    setEditingCommentId(reply.id);
    setEditText(reply.content || '');
    // No tag picker on a reply: undefined keeps the PATCH from carrying a tagId at all.
    setEditTagId(undefined);
    setEditImageUrls(reply.images.map((image) => image.url));
    setEditImageFiles([]);
  }, []);

  const cancelEditingComment = useCallback(() => {
    setEditingCommentId(null);
    setEditText('');
    setEditTagId(undefined);
    setEditAnnotationData(undefined);
    setIsEditingAnnotation(false);
    setEditImageUrls([]);
    setEditImageFiles([]);
  }, []);

  const removeEditImageUrl = useCallback((url: string) => {
    setEditImageUrls((prev) => prev.filter((current) => current !== url));
  }, []);

  const handleEditComment = useCallback(
    async (commentId: string) => {
      const keepsImages = editImageUrls.length > 0 || editImageFiles.length > 0;
      if (!editText.trim() && !editAnnotationData && !keepsImages) return;
      if (!activeVersionId) return;

      setIsSubmittingEdit(true);
      isMutatingRef.current = true;

      let finalAnnotationData = editAnnotationData;
      if (isEditingAnnotation && editAnnotationCanvasRef.current) {
        const strokes = editAnnotationCanvasRef.current.getStrokes();
        if (strokes.length > 0) {
          finalAnnotationData = JSON.stringify(strokes);
        }
      }

      try {
        const uploadedImageUrls = await uploadImageFiles(editImageFiles);
        // The list the comment should end up with: what the editor kept, then
        // whatever was pasted into it while it was open.
        const nextImageUrls = [...editImageUrls, ...uploadedImageUrls];

        const body: Record<string, unknown> = { content: editText, imageUrls: nextImageUrls };
        if (editTagId !== undefined) body.tagId = editTagId;
        if (finalAnnotationData !== undefined) {
          body.annotationData =
            finalAnnotationData !== null ? JSON.parse(finalAnnotationData) : null;
        }
        if (isGuest && normalizedGuestName) body.guestName = normalizedGuestName;
        const res = await fetch(`/api/comments/${commentId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = (await res.json().catch(() => null)) as {
          data?: { images?: CommentImage[] };
          error?: string;
          code?: string;
        } | null;

        if (res.ok) {
          const editedTag = editTagId
            ? availableTags.find((t) => t.id === editTagId) || null
            : null;
          // The response carries the saved rows with their real ids; fall back to
          // the URLs that were sent if it did not come back as JSON.
          const savedImages: CommentImage[] =
            payload?.data?.images ??
            nextImageUrls.map((url, index) => ({ id: `${commentId}-image-${index}`, url }));
          setVideo((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === activeVersionId
                  ? {
                      ...v,
                      comments: v.comments.map((c) => {
                        if (c.id === commentId)
                          return {
                            ...c,
                            content: editText.trim(),
                            images: savedImages,
                            tag: editTagId !== undefined ? editedTag : c.tag,
                            annotationData:
                              finalAnnotationData !== undefined
                                ? finalAnnotationData
                                : c.annotationData,
                          };
                        return {
                          ...c,
                          replies: (c.replies || []).map((r) =>
                            r.id === commentId
                              ? { ...r, content: editText.trim(), images: savedImages }
                              : r
                          ),
                        };
                      }),
                    }
                  : v
              ),
            };
          });
          cancelEditingComment();
          if (uploadedImageUrls.length > 0) {
            void fetchAssets();
          }
          if (finalAnnotationData !== undefined && finalAnnotationData) {
            try {
              const parsed = JSON.parse(finalAnnotationData);
              const safe = validateAnnotationStrokes(parsed);
              if (safe) setViewingAnnotation(safe as AnnotationStroke[]);
            } catch {
              // ignore parse errors
            }
          } else if (finalAnnotationData === null) {
            setViewingAnnotation(null);
          }
        } else {
          toastApiError(payload, 'Failed to save changes');
        }
      } catch (error) {
        // An upload can fail on quota before the comment is ever touched, and
        // that message is worth showing; a network fault falls back.
        toastApiError(error instanceof ApiRequestError ? error : null, 'Failed to save changes');
      } finally {
        setIsSubmittingEdit(false);
        isMutatingRef.current = false;
      }
    },
    [
      editText,
      editTagId,
      editAnnotationData,
      editImageFiles,
      editImageUrls,
      uploadImageFiles,
      cancelEditingComment,
      isEditingAnnotation,
      activeVersionId,
      availableTags,
      isGuest,
      normalizedGuestName,
      editAnnotationCanvasRef,
      fetchAssets,
      setVideo,
      setViewingAnnotation,
    ]
  );

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!activeVersionId) return;

      isMutatingRef.current = true;

      // The snapshot is taken once, however many times React runs the updater. React is
      // free to invoke an updater more than once (StrictMode, and React 19 retries a
      // render that threw), and a second run would otherwise capture the post-delete
      // state, turning a failed delete into a silent confirmation of it.
      const previousVideoRef: { current: VideoData | null } = { current: null };
      let capturedSnapshot = false;
      setVideo((prev) => {
        if (!capturedSnapshot) {
          previousVideoRef.current = prev;
          capturedSnapshot = true;
        }
        if (!prev) return prev;
        return {
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === activeVersionId
              ? {
                  ...v,
                  comments: v.comments
                    .filter((c) => c.id !== commentId)
                    .map((c) => ({
                      ...c,
                      replies: c.replies?.filter((r) => r.id !== commentId) || [],
                    })),
                }
              : v
          ),
        };
      });

      try {
        const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
        if (!res.ok && previousVideoRef.current) {
          setVideo(previousVideoRef.current);
        }
      } catch (err) {
        console.error('Failed to delete comment:', err);
        if (previousVideoRef.current) {
          setVideo(previousVideoRef.current);
        }
      } finally {
        isMutatingRef.current = false;
      }
    },
    [activeVersionId, setVideo]
  );

  useEffect(() => {
    if (!activeVersionId) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let isPageVisible = true;

    const poll = async () => {
      try {
        if (isMutatingRef.current || !isPageVisible) return;
        await fetchVersionComments(activeVersionId, true);
      } catch {
        // silent
      }
    };

    intervalId = setInterval(poll, 10000);

    const handleVisibilityChange = () => {
      isPageVisible = document.visibilityState === 'visible';
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeVersionId, fetchVersionComments]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
      if (replyRecordingTimerRef.current) {
        clearInterval(replyRecordingTimerRef.current);
      }
    };
  }, []);

  return {
    commentText,
    setCommentText,
    isSubmittingComment,
    isRecording,
    recordingTime,
    audioBlob,
    isUploadingAudio,
    imageFiles,
    setImageFiles,
    commentRangeStart,
    commentRangeEnd,
    toggleCommentRangeSelection,
    clearCommentRangeSelection,
    isUploadingImage,
    imageInputRef,
    removeImageFile,
    handleAddComment,
    handleImageSelect,
    handlePaste,
    handleDrop,
    startRecording,
    stopRecording,
    cancelRecording,
    submitCommentWithMedia,

    replyingTo,
    setReplyingTo,
    replyText,
    setReplyText,
    isSubmittingReply,
    isReplyRecording,
    replyRecordingTime,
    replyAudioBlob,
    replyImageFiles,
    setReplyImageFiles,
    replyRangeStart,
    replyRangeEnd,
    toggleReplyRangeSelection,
    clearReplyRangeSelection,
    isUploadingReplyAudio,
    isUploadingReplyImage,
    replyImageInputRef,
    handleReplyComment,
    startReplyRecording,
    stopReplyRecording,
    cancelReplyRecording,
    submitReplyWithMedia,

    editingCommentId,
    setEditingCommentId,
    editText,
    setEditText,
    editTagId,
    setEditTagId,
    editAnnotationData,
    setEditAnnotationData,
    isEditingAnnotation,
    setIsEditingAnnotation,
    editImageUrls,
    editImageFiles,
    editImageInputRef,
    startEditingComment,
    startEditingReply,
    cancelEditingComment,
    removeEditImageUrl,
    isSubmittingEdit,
    handleEditComment,
    handleDeleteComment,
    handleResolveComment,

    previewImage,
    setPreviewImage,
  };
}
