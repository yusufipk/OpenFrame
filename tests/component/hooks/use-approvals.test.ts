import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { useApprovals } from '@/components/video-page/hooks/use-approvals';
import type { ApprovalDecision, ApprovalRequest } from '@/components/video-page/types';

type Params = Parameters<typeof useApprovals>[0];

const VERSION_ID = 'ver1';
const PROJECT_ID = 'proj1';

function makeDecision(overrides: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    id: 'dec1',
    approverId: 'user2',
    status: 'PENDING',
    note: null,
    respondedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    approver: { id: 'user2', name: 'Linus', email: 'linus@example.test', image: null },
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req1',
    status: 'PENDING',
    requestedById: 'user1',
    message: null,
    resolvedAt: null,
    canceledAt: null,
    canceledById: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    requestedBy: { id: 'user1', name: 'Ada', email: 'ada@example.test', image: null },
    canceledBy: null,
    decisions: [makeDecision()],
    ...overrides,
  };
}

function ok(payload: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

function fail(status: number, payload: unknown = {}) {
  return { ok: false, status, json: () => Promise.resolve(payload) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;
/** What the approvals GET answers with. Reassign to change it mid-test. */
let listedRequests: ApprovalRequest[];
let listedCandidates: unknown[];

function callsTo(url: string, method?: string) {
  return fetchMock.mock.calls.filter(
    (call) => call[0] === url && (call[1]?.method ?? undefined) === method
  );
}

function bodyOf(call: unknown[]): unknown {
  const init = call[1] as { body?: string };
  return init.body === undefined ? undefined : JSON.parse(init.body);
}

type Harness = RenderHookResult<ReturnType<typeof useApprovals>, Params>;

function renderApprovals(overrides: Partial<Params> = {}): Harness {
  const initialProps: Params = {
    projectId: PROJECT_ID,
    activeVersionId: VERSION_ID,
    currentUserId: 'user1',
    ...overrides,
  };
  return renderHook((props: Params) => useApprovals(props), { initialProps });
}

beforeEach(() => {
  listedRequests = [makeRequest()];
  listedCandidates = [{ id: 'user2', name: 'Linus', email: 'linus@example.test', image: null }];
  fetchMock = vi.fn((url: string) => {
    if (url === `/api/versions/${VERSION_ID}/approvals`) {
      return Promise.resolve(ok({ data: { requests: listedRequests } }));
    }
    if (url === `/api/projects/${PROJECT_ID}/approval-candidates?versionId=ver1`) {
      return Promise.resolve(ok({ data: { candidates: listedCandidates } }));
    }
    return Promise.resolve(ok({ data: {} }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useApprovals reading the request list', () => {
  it('reads the approvals of the active version, bypassing the cache', async () => {
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/versions/${VERSION_ID}/approvals`, {
      cache: 'no-store',
    });
    expect(harness.result.current.requests).toEqual(listedRequests);
    expect(harness.result.current.error).toBe('');
  });

  it('does not read anything before a version is selected', async () => {
    const harness = renderApprovals({ activeVersionId: null });

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.result.current.requests).toEqual([]);
  });

  it('flags loading while the read is in flight and clears it afterwards', async () => {
    const pending = deferred<unknown>();
    fetchMock.mockReturnValue(pending.promise);
    const harness = renderApprovals();

    let read: Promise<void> | undefined;
    act(() => {
      read = harness.result.current.fetchRequests();
    });
    expect(harness.result.current.isLoadingRequests).toBe(true);

    await act(async () => {
      pending.resolve(ok({ data: { requests: [] } }));
      await read;
    });
    expect(harness.result.current.isLoadingRequests).toBe(false);
  });

  it('shows the message the server sent when the caller is forbidden', async () => {
    fetchMock.mockResolvedValue(fail(403, { error: 'Access denied' }));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.error).toBe('Access denied');
    expect(harness.result.current.requests).toEqual([]);
    expect(harness.result.current.isLoadingRequests).toBe(false);
  });

  it('falls back to a generic message when a 500 carries no error string', async () => {
    fetchMock.mockResolvedValue(fail(500, {}));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.error).toBe('Failed to fetch approval requests');
  });

  it('reports a network failure instead of leaving the panel spinning', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.error).toBe('Failed to fetch approval requests');
    expect(harness.result.current.isLoadingRequests).toBe(false);
  });

  it('clears a previous error when the next read succeeds', async () => {
    fetchMock.mockResolvedValueOnce(fail(500, { error: 'Boom' }));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });
    expect(harness.result.current.error).toBe('Boom');

    await act(async () => {
      await harness.result.current.fetchRequests();
    });
    expect(harness.result.current.error).toBe('');
  });

  // A failed read must not silently empty a list the user is looking at.
  it('keeps the requests already on screen when a later read fails', async () => {
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });
    expect(harness.result.current.requests).toHaveLength(1);

    fetchMock.mockResolvedValue(fail(500, {}));
    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.requests).toHaveLength(1);
  });

  it('treats a body with no requests key as an empty list', async () => {
    fetchMock.mockResolvedValue(ok({ data: {} }));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.requests).toEqual([]);
  });
});

describe('useApprovals reading the candidate list', () => {
  it('reads the approvers of the project, bypassing the cache', async () => {
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchCandidates();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${PROJECT_ID}/approval-candidates?versionId=ver1`,
      {
        cache: 'no-store',
      }
    );
    expect(harness.result.current.candidates).toEqual(listedCandidates);
  });

  it('does not read approvers without a project', async () => {
    const harness = renderApprovals({ projectId: undefined });

    await act(async () => {
      await harness.result.current.fetchCandidates();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the message the server sent when the caller cannot manage the project', async () => {
    fetchMock.mockResolvedValue(fail(403, { error: 'Access denied' }));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchCandidates();
    });

    expect(harness.result.current.error).toBe('Access denied');
    expect(harness.result.current.isLoadingCandidates).toBe(false);
  });

  it('reports a network failure while reading approvers', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchCandidates();
    });

    expect(harness.result.current.error).toBe('Failed to fetch approvers');
  });
});

describe('useApprovals creating a request', () => {
  it('posts the approvers to the active version and re-reads the list', async () => {
    const harness = renderApprovals();

    let created: boolean | undefined;
    await act(async () => {
      created = await harness.result.current.createRequest(['user2', 'user3'], 'Please review');
    });

    const post = callsTo(`/api/versions/${VERSION_ID}/approvals`, 'POST')[0];
    expect(bodyOf(post)).toEqual({ approverIds: ['user2', 'user3'], message: 'Please review' });
    expect(created).toBe(true);
    // The POST answers with the created row, but the hook trusts only the
    // re-read, so the list has to come back from the GET that follows.
    expect(callsTo(`/api/versions/${VERSION_ID}/approvals`, undefined)).toHaveLength(1);
    expect(harness.result.current.requests).toEqual(listedRequests);
  });

  it('omits the message entirely when none was typed', async () => {
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.createRequest(['user2'], '');
    });

    const post = callsTo(`/api/versions/${VERSION_ID}/approvals`, 'POST')[0];
    expect(bodyOf(post)).toEqual({ approverIds: ['user2'] });
  });

  it('refuses to post before a version is selected', async () => {
    const harness = renderApprovals({ activeVersionId: null });

    let created: boolean | undefined;
    await act(async () => {
      created = await harness.result.current.createRequest(['user2']);
    });

    expect(created).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error and skips the re-read when the post is rejected', async () => {
    fetchMock.mockResolvedValue(fail(403, { error: 'Only editors can request approval' }));
    const harness = renderApprovals();

    let created: boolean | undefined;
    await act(async () => {
      created = await harness.result.current.createRequest(['user2']);
    });

    expect(created).toBe(false);
    expect(harness.result.current.error).toBe('Only editors can request approval');
    expect(callsTo(`/api/versions/${VERSION_ID}/approvals`, undefined)).toHaveLength(0);
    expect(harness.result.current.isSubmittingRequest).toBe(false);
  });

  it('reports a network failure without hanging the submit flag', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderApprovals();

    let created: boolean | undefined;
    await act(async () => {
      created = await harness.result.current.createRequest(['user2']);
    });

    expect(created).toBe(false);
    expect(harness.result.current.error).toBe('Failed to create approval request');
    expect(harness.result.current.isSubmittingRequest).toBe(false);
  });

  // KNOWN FRAGILITY, pinned rather than fixed. `createRequest` has no in-flight
  // guard of its own, so a double-clicked "Request approval" button sends two
  // POSTs. The route de-duplicates server side, which is why this has not
  // surfaced; the hook must at least settle cleanly afterwards.
  it('sends one post per click and still settles when clicked twice', async () => {
    const harness = renderApprovals();

    await act(async () => {
      await Promise.all([
        harness.result.current.createRequest(['user2']),
        harness.result.current.createRequest(['user2']),
      ]);
    });

    expect(callsTo(`/api/versions/${VERSION_ID}/approvals`, 'POST')).toHaveLength(2);
    expect(harness.result.current.isSubmittingRequest).toBe(false);
    expect(harness.result.current.requests).toEqual(listedRequests);
  });
});

describe('useApprovals deciding', () => {
  it('posts the decision to the request and re-reads the list', async () => {
    const harness = renderApprovals();

    let decided: boolean | undefined;
    await act(async () => {
      decided = await harness.result.current.submitDecision('req1', 'APPROVED', 'Looks good');
    });

    const post = callsTo('/api/approvals/req1/decision', 'POST')[0];
    expect(bodyOf(post)).toEqual({ decision: 'APPROVED', note: 'Looks good' });
    expect((post[1] as { headers: Record<string, string> }).headers).toEqual({
      'Content-Type': 'application/json',
    });
    expect(decided).toBe(true);
    expect(callsTo(`/api/versions/${VERSION_ID}/approvals`, undefined)).toHaveLength(1);
  });

  it('rejects without a note when none was written', async () => {
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.submitDecision('req1', 'REJECTED');
    });

    expect(bodyOf(callsTo('/api/approvals/req1/decision', 'POST')[0])).toEqual({
      decision: 'REJECTED',
    });
  });

  it('surfaces the server error when the caller is not an approver', async () => {
    fetchMock.mockResolvedValue(fail(403, { error: 'You are not an approver on this request' }));
    const harness = renderApprovals();

    let decided: boolean | undefined;
    await act(async () => {
      decided = await harness.result.current.submitDecision('req1', 'APPROVED');
    });

    expect(decided).toBe(false);
    expect(harness.result.current.error).toBe('You are not an approver on this request');
    expect(harness.result.current.isSubmittingDecision).toBe(false);
  });

  it('reports a network failure while deciding', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.submitDecision('req1', 'APPROVED');
    });

    expect(harness.result.current.error).toBe('Failed to submit approval decision');
    expect(harness.result.current.isSubmittingDecision).toBe(false);
  });
});

describe('useApprovals canceling', () => {
  it('posts to the cancel endpoint with no body and re-reads the list', async () => {
    const harness = renderApprovals();

    let canceled: boolean | undefined;
    await act(async () => {
      canceled = await harness.result.current.cancelRequest('req1');
    });

    const post = callsTo('/api/approvals/req1/cancel', 'POST')[0];
    expect(post[1]).toEqual({ method: 'POST' });
    expect(canceled).toBe(true);
    expect(callsTo(`/api/versions/${VERSION_ID}/approvals`, undefined)).toHaveLength(1);
  });

  it('surfaces the server error when the request cannot be canceled', async () => {
    fetchMock.mockResolvedValue(fail(409, { error: 'Request is already resolved' }));
    const harness = renderApprovals();

    let canceled: boolean | undefined;
    await act(async () => {
      canceled = await harness.result.current.cancelRequest('req1');
    });

    expect(canceled).toBe(false);
    expect(harness.result.current.error).toBe('Request is already resolved');
    expect(harness.result.current.isCancelingRequest).toBe(false);
  });

  it('reports a network failure while canceling', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.cancelRequest('req1');
    });

    expect(harness.result.current.error).toBe('Failed to cancel approval request');
    expect(harness.result.current.isCancelingRequest).toBe(false);
  });
});

describe('useApprovals derived state', () => {
  it('finds the one pending request among resolved ones', async () => {
    listedRequests = [
      makeRequest({ id: 'req-new', status: 'PENDING' }),
      makeRequest({ id: 'req-old', status: 'APPROVED' }),
      makeRequest({ id: 'req-older', status: 'CANCELED' }),
    ];
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.activePendingRequest?.id).toBe('req-new');
  });

  it('reports no pending request once everything is resolved', async () => {
    listedRequests = [makeRequest({ id: 'req-old', status: 'REJECTED' })];
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.activePendingRequest).toBeNull();
    expect(harness.result.current.myPendingDecision).toBeNull();
  });

  it('surfaces the current user own undecided slot', async () => {
    listedRequests = [
      makeRequest({
        decisions: [
          makeDecision({ id: 'dec-other', approverId: 'user2', status: 'PENDING' }),
          makeDecision({ id: 'dec-mine', approverId: 'user1', status: 'PENDING' }),
        ],
      }),
    ];
    const harness = renderApprovals({ currentUserId: 'user1' });

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.myPendingDecision?.id).toBe('dec-mine');
  });

  it('hides the decide prompt once the user has already answered', async () => {
    listedRequests = [
      makeRequest({
        decisions: [
          makeDecision({ id: 'dec-mine', approverId: 'user1', status: 'APPROVED' }),
          makeDecision({ id: 'dec-other', approverId: 'user2', status: 'PENDING' }),
        ],
      }),
    ];
    const harness = renderApprovals({ currentUserId: 'user1' });

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.myPendingDecision).toBeNull();
  });

  it('never offers a decision to an anonymous viewer', async () => {
    const harness = renderApprovals({ currentUserId: null });

    await act(async () => {
      await harness.result.current.fetchRequests();
    });

    expect(harness.result.current.activePendingRequest?.id).toBe('req1');
    expect(harness.result.current.myPendingDecision).toBeNull();
  });

  it('lets a caller clear the error banner by hand', async () => {
    fetchMock.mockResolvedValue(fail(500, { error: 'Boom' }));
    const harness = renderApprovals();

    await act(async () => {
      await harness.result.current.fetchRequests();
    });
    expect(harness.result.current.error).toBe('Boom');

    act(() => harness.result.current.setError(''));
    expect(harness.result.current.error).toBe('');
  });
});
