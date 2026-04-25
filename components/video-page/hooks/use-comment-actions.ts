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
  CommentReply,
  CommentTag,
  Version,
  VideoData,
} from '@/components/video-page/types';
import {
  extractPastedImageFile,
  validateImageFile,
} from '@/components/video-page/image-upload-utils';
import { validateAnnotationStrokes } from '@/lib/validation';

interface UseCommentActionsParams extends CommentActionsConfig {
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

export function useCommentActions({
  videoId,
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
  const [imageBlob, setImageBlob] = useState<File | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [commentRangeStart, setCommentRangeStart] = useState<number | null>(null);
  const [commentRangeEnd, setCommentRangeEnd] = useState<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [isReplyRecording, setIsReplyRecording] = useState(false);
  const [replyRecordingTime, setReplyRecordingTime] = useState(0);
  const [replyAudioBlob, setReplyAudioBlob] = useState<Blob | null>(null);
  const [isUploadingReplyAudio, setIsUploadingReplyAudio] = useState(false);
  const [replyImageBlob, setReplyImageBlob] = useState<File | null>(null);
  const [isUploadingReplyImage, setIsUploadingReplyImage] = useState(false);
  const [replyRangeStart, setReplyRangeStart] = useState<number | null>(null);
  const [replyRangeEnd, setReplyRangeEnd] = useState<number | null>(null);
  const replyImageInputRef = useRef<HTMLInputElement>(null);
  const replyMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const replyAudioChunksRef = useRef<Blob[]>([]);
  const replyRecordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editTagId, setEditTagId] = useState<string | null>(null);
  const [editAnnotationData, setEditAnnotationData] = useState<string | null | undefined>(
    undefined
  );
  const [isEditingAnnotation, setIsEditingAnnotation] = useState(false);
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
        throw new Error(payload?.error || 'Failed to prepare upload');
      }
      return token;
    },
    [isGuest, videoId]
  );

  const handleAddComment = useCallback(
    async (voiceData?: { url: string; duration: number }) => {
      if (!voiceData && !imageBlob && !commentText.trim() && !annotationStrokes && !isAnnotating)
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
      const commentTimestamp = commentRangeStart ?? currentTime;
      const serializedAnnotation = effectiveStrokes ? JSON.stringify(effectiveStrokes) : null;
      const optimisticComment: Comment = {
        id: tempId,
        content: voiceData || imageBlob ? commentText.trim() || null : commentText,
        timestamp: commentTimestamp,
        timestampEnd: commentRangeEnd,
        voiceUrl: voiceData?.url ?? null,
        voiceDuration: voiceData?.duration ?? null,
        imageUrl: imageBlob ? URL.createObjectURL(imageBlob) : null,
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
      setImageBlob(null);
      setAnnotationStrokes(null);
      setIsAnnotating(false);
      clearCommentRangeSelection();
      setViewingAnnotation(effectiveStrokes || null);

      setIsSubmittingComment(true);
      isMutatingRef.current = true;

      try {
        let imageData: { url: string } | undefined;

        if (imageBlob) {
          setIsUploadingImage(true);
          const imageFormData = new FormData();
          imageFormData.append('image', imageBlob);
          imageFormData.append('videoId', videoId);
          const uploadToken = await getGuestUploadToken('image');
          if (uploadToken) imageFormData.append('uploadToken', uploadToken);

          const imageRes = await fetch('/api/upload/image', {
            method: 'POST',
            body: imageFormData,
          });

          if (!imageRes.ok) throw new Error('Failed to upload image');
          const imageDataResponse = await imageRes.json();
          imageData = { url: imageDataResponse.data.url };
        }

        const res = await fetch(`/api/versions/${activeVersion.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: voiceData || imageBlob ? commentText.trim() || null : commentText,
            timestamp: commentTimestamp,
            ...(commentRangeEnd !== null && { timestampEnd: commentRangeEnd }),
            ...(voiceData && { voiceUrl: voiceData.url, voiceDuration: voiceData.duration }),
            ...(imageData && { imageUrl: imageData.url }),
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

          // If an image was attached, refresh the assets list
          if (imageData) {
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
          toast.error('Failed to add comment');
        }
      } catch {
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
        toast.error('Failed to add comment');
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
      currentTime,
      activeVersion,
      activeVersionId,
      isGuest,
      normalizedGuestName,
      currentUserName,
      selectedTagId,
      availableTags,
      imageBlob,
      annotationStrokes,
      isAnnotating,
      videoId,
      getGuestUploadToken,
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
    async (e: ChangeEvent<HTMLInputElement>, isReply: boolean = false) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const imageError = await validateImageFile(file);
      if (imageError) {
        toast.error(imageError);
        return;
      }

      if (isReply) {
        setReplyImageBlob(file);
      } else {
        setImageBlob(file);
      }
    },
    []
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>, isReply: boolean = false) => {
      const file = extractPastedImageFile(e.clipboardData);
      if (!file) return;
      e.preventDefault();

      const imageError = await validateImageFile(file);
      if (imageError) {
        toast.error(imageError);
        return;
      }

      if (isReply) {
        setReplyImageBlob(file);
      } else {
        setImageBlob(file);
      }
    },
    []
  );

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>, isReply: boolean = false) => {
    e.preventDefault();
    const file = extractPastedImageFile(e.dataTransfer);
    if (!file) return;

    const imageError = await validateImageFile(file);
    if (imageError) {
      toast.error(imageError);
      return;
    }

    if (isReply) {
      setReplyImageBlob(file);
    } else {
      setImageBlob(file);
    }
  }, []);

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

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        stream.getTracks().forEach((track) => track.stop());
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
      };

      mediaRecorder.start(100);
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 0.1);
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
      formData.append('audio', audioBlob, 'recording.webm');
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

    if (audioBlob && !imageBlob && !commentText.trim()) {
      submitVoiceComment();
      return;
    }

    if (audioBlob) setIsUploadingAudio(true);
    if (imageBlob) setIsUploadingImage(true);

    try {
      let voiceData: { url: string; duration: number } | undefined;
      if (audioBlob) {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
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
      setImageBlob(null);
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
    imageBlob,
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
      setVideo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === activeVersionId
              ? {
                  ...v,
                  comments: v.comments.map((c) =>
                    c.id === commentId ? { ...c, isResolved: !c.isResolved } : c
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
          body: JSON.stringify({ isResolved: !currentlyResolved }),
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
      imageData?: { url: string }
    ) => {
      if (!voiceData && !replyImageBlob && !replyText.trim()) return;
      if (!activeVersion || !activeVersionId) return;

      const tempId = `temp-reply-${Date.now()}`;
      const replyTimestamp = replyRangeStart ?? currentTime;
      const optimisticReply: CommentReply = {
        id: tempId,
        content: voiceData || replyImageBlob ? replyText.trim() || null : replyText,
        timestamp: replyTimestamp,
        timestampEnd: replyRangeEnd,
        voiceUrl: voiceData?.url ?? null,
        voiceDuration: voiceData?.duration ?? null,
        imageUrl: replyImageBlob ? URL.createObjectURL(replyImageBlob) : null,
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
      setReplyImageBlob(null);
      clearReplyRangeSelection();

      setIsSubmittingReply(true);
      isMutatingRef.current = true;

      try {
        let submittedImageData: { url: string } | undefined = imageData;

        if (replyImageBlob && !imageData) {
          setIsUploadingReplyImage(true);
          const imageFormData = new FormData();
          imageFormData.append('image', replyImageBlob);
          imageFormData.append('videoId', videoId);
          const uploadToken = await getGuestUploadToken('image');
          if (uploadToken) imageFormData.append('uploadToken', uploadToken);

          const imageRes = await fetch('/api/upload/image', {
            method: 'POST',
            body: imageFormData,
          });

          if (!imageRes.ok) throw new Error('Failed to upload image reply');
          const imageDataResponse = await imageRes.json();
          submittedImageData = { url: imageDataResponse.data.url };
        }

        const res = await fetch(`/api/versions/${activeVersion.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: voiceData || submittedImageData ? replyText.trim() || null : replyText,
            timestamp: replyTimestamp,
            ...(replyRangeEnd !== null && { timestampEnd: replyRangeEnd }),
            parentId,
            ...(voiceData && { voiceUrl: voiceData.url, voiceDuration: voiceData.duration }),
            ...(submittedImageData && { imageUrl: submittedImageData.url }),
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

          // If an image was attached, refresh the assets list
          if (submittedImageData) {
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
      activeVersion,
      activeVersionId,
      currentTime,
      isGuest,
      normalizedGuestName,
      currentUserName,
      replyImageBlob,
      videoId,
      getGuestUploadToken,
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
      mediaRecorder.onstop = () => {
        const blob = new Blob(replyAudioChunksRef.current, { type: 'audio/webm' });
        setReplyAudioBlob(blob);
        stream.getTracks().forEach((track) => track.stop());
        if (replyRecordingTimerRef.current) {
          clearInterval(replyRecordingTimerRef.current);
          replyRecordingTimerRef.current = null;
        }
      };
      mediaRecorder.start(100);
      setIsReplyRecording(true);
      setReplyRecordingTime(0);
      replyRecordingTimerRef.current = setInterval(() => {
        setReplyRecordingTime((prev) => prev + 0.1);
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
        formData.append('audio', replyAudioBlob, 'recording.webm');
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

      if (replyAudioBlob && !replyImageBlob && !replyText.trim()) {
        submitVoiceReply(parentId);
        return;
      }

      if (replyAudioBlob) setIsUploadingReplyAudio(true);
      if (replyImageBlob) setIsUploadingReplyImage(true);

      try {
        let voiceData: { url: string; duration: number } | undefined;

        if (replyAudioBlob) {
          const formData = new FormData();
          formData.append('audio', replyAudioBlob, 'recording.webm');
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
        setReplyImageBlob(null);
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
      replyImageBlob,
      activeVersion,
      replyRecordingTime,
      replyText,
      submitVoiceReply,
      handleReplyComment,
      videoId,
      getGuestUploadToken,
    ]
  );

  const handleEditComment = useCallback(
    async (commentId: string) => {
      if (!editText.trim() && !editAnnotationData) return;
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
        const body: Record<string, unknown> = { content: editText };
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
        if (res.ok) {
          const editedTag = editTagId
            ? availableTags.find((t) => t.id === editTagId) || null
            : null;
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
                            tag: editTagId !== undefined ? editedTag : c.tag,
                            annotationData:
                              finalAnnotationData !== undefined
                                ? finalAnnotationData
                                : c.annotationData,
                          };
                        return {
                          ...c,
                          replies: (c.replies || []).map((r) =>
                            r.id === commentId ? { ...r, content: editText.trim() } : r
                          ),
                        };
                      }),
                    }
                  : v
              ),
            };
          });
          setEditingCommentId(null);
          setEditText('');
          setEditTagId(null);
          setEditAnnotationData(undefined);
          setIsEditingAnnotation(false);
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
        }
      } catch (err) {
        console.error('Failed to edit comment:', err);
      } finally {
        setIsSubmittingEdit(false);
        isMutatingRef.current = false;
      }
    },
    [
      editText,
      editTagId,
      editAnnotationData,
      isEditingAnnotation,
      activeVersionId,
      availableTags,
      isGuest,
      normalizedGuestName,
      editAnnotationCanvasRef,
      setVideo,
      setViewingAnnotation,
    ]
  );

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!activeVersionId) return;

      isMutatingRef.current = true;

      const previousVideoRef: { current: VideoData | null } = { current: null };
      setVideo((prev) => {
        previousVideoRef.current = prev;
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
    imageBlob,
    setImageBlob,
    commentRangeStart,
    commentRangeEnd,
    toggleCommentRangeSelection,
    clearCommentRangeSelection,
    isUploadingImage,
    imageInputRef,
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
    replyImageBlob,
    setReplyImageBlob,
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
    isSubmittingEdit,
    handleEditComment,
    handleDeleteComment,
    handleResolveComment,

    previewImage,
    setPreviewImage,
  };
}
