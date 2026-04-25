'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ApprovalRequest } from '@/components/video-page/types';

export interface ApprovalCandidate {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

interface UseApprovalsParams {
  projectId?: string;
  activeVersionId: string | null;
  currentUserId: string | null;
}

export function useApprovals({ projectId, activeVersionId, currentUserId }: UseApprovalsParams) {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [candidates, setCandidates] = useState<ApprovalCandidate[]>([]);
  const [isLoadingRequests, setIsLoadingRequests] = useState(false);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [isSubmittingRequest, setIsSubmittingRequest] = useState(false);
  const [isSubmittingDecision, setIsSubmittingDecision] = useState(false);
  const [isCancelingRequest, setIsCancelingRequest] = useState(false);
  const [error, setError] = useState('');

  const fetchRequests = useCallback(async () => {
    if (!activeVersionId) return;
    setIsLoadingRequests(true);
    setError('');
    try {
      const res = await fetch(`/api/versions/${activeVersionId}/approvals`, { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload?.error || 'Failed to fetch approval requests');
        return;
      }
      setRequests(payload?.data?.requests || []);
    } catch {
      setError('Failed to fetch approval requests');
    } finally {
      setIsLoadingRequests(false);
    }
  }, [activeVersionId]);

  const fetchCandidates = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingCandidates(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/approval-candidates`, {
        cache: 'no-store',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload?.error || 'Failed to fetch approvers');
        return;
      }
      setCandidates(payload?.data?.candidates || []);
    } catch {
      setError('Failed to fetch approvers');
    } finally {
      setIsLoadingCandidates(false);
    }
  }, [projectId]);

  const createRequest = useCallback(
    async (approverIds: string[], message?: string) => {
      if (!activeVersionId) return false;
      setIsSubmittingRequest(true);
      setError('');
      try {
        const res = await fetch(`/api/versions/${activeVersionId}/approvals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approverIds, message: message || undefined }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(payload?.error || 'Failed to create approval request');
          return false;
        }
        await fetchRequests();
        return true;
      } catch {
        setError('Failed to create approval request');
        return false;
      } finally {
        setIsSubmittingRequest(false);
      }
    },
    [activeVersionId, fetchRequests]
  );

  const submitDecision = useCallback(
    async (requestId: string, decision: 'APPROVED' | 'REJECTED', note?: string) => {
      setIsSubmittingDecision(true);
      setError('');
      try {
        const res = await fetch(`/api/approvals/${requestId}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, note: note || undefined }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(payload?.error || 'Failed to submit approval decision');
          return false;
        }
        await fetchRequests();
        return true;
      } catch {
        setError('Failed to submit approval decision');
        return false;
      } finally {
        setIsSubmittingDecision(false);
      }
    },
    [fetchRequests]
  );

  const cancelRequest = useCallback(
    async (requestId: string) => {
      setIsCancelingRequest(true);
      setError('');
      try {
        const res = await fetch(`/api/approvals/${requestId}/cancel`, {
          method: 'POST',
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(payload?.error || 'Failed to cancel approval request');
          return false;
        }
        await fetchRequests();
        return true;
      } catch {
        setError('Failed to cancel approval request');
        return false;
      } finally {
        setIsCancelingRequest(false);
      }
    },
    [fetchRequests]
  );

  const activePendingRequest = useMemo(
    () => requests.find((request) => request.status === 'PENDING') || null,
    [requests]
  );

  const myPendingDecision = useMemo(() => {
    if (!currentUserId || !activePendingRequest) return null;
    return (
      activePendingRequest.decisions.find(
        (decision) => decision.approverId === currentUserId && decision.status === 'PENDING'
      ) || null
    );
  }, [activePendingRequest, currentUserId]);

  return {
    requests,
    candidates,
    isLoadingRequests,
    isLoadingCandidates,
    isSubmittingRequest,
    isSubmittingDecision,
    isCancelingRequest,
    activePendingRequest,
    myPendingDecision,
    error,
    setError,
    fetchRequests,
    fetchCandidates,
    createRequest,
    submitDecision,
    cancelRequest,
  };
}
