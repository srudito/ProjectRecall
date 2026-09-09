import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  persistPreparedTranscriptHistoryCache,
  waitForHistoryCacheWritesIdle,
} from "@/src/services/sqlite/history-cache";
import { useAuthStore } from "@/src/stores/auth-store";

import { fetchTranscriptHistoryBundle } from "./history-bundle-client";
import { HISTORY_BUNDLE_SOURCE, TranscriptHistoryBundleError } from "./history-bundle-types";
import {
  HistoryCacheError,
  historyCacheError,
  historyCacheResult,
  prepareHistoryCacheCommand,
  revokeHistoryCacheCommand,
  type HistoryCacheErrorCode,
  type HistoryCacheResult,
  type PreparedHistoryCacheCommand,
} from "./history-cache-types";
import {
  captureHistoryCloudVersion,
  TranscriptHistoryCloudError,
  type TranscriptHistoryCloudVersionRequest,
} from "./history-cloud-types";

export interface TranscriptHistoryCacheRequest extends TranscriptHistoryCloudVersionRequest {
  /** The future caller must supply its own workspace/session/request lifetime guard. */
  assertActive: () => void;
}
export interface HistoryCacheServiceDependencies {
  collect: typeof fetchTranscriptHistoryBundle;
  persist: typeof persistPreparedTranscriptHistoryCache;
  waitForWritesIdle: typeof waitForHistoryCacheWritesIdle;
  identity: () => { initialized: boolean; userId: string | null };
  subscribeIdentity: (listener: () => void) => () => void;
  deletionPending: () => boolean;
}
interface CacheOwner {
  sessionId: string;
  stop: (code: HistoryCacheErrorCode) => void;
  drained: Promise<void>;
}
const failureResult = (failure: unknown): HistoryCacheResult => {
  if (failure instanceof HistoryCacheError) {
    return historyCacheResult(failure.code === "HISTORY_CACHE_BUSY" ? "retryable" : "rejected", failure.code);
  }
  if (failure instanceof TranscriptHistoryCloudError) {
    if (failure.code === "HISTORY_CLOUD_AUTH_REQUIRED" || failure.code === "HISTORY_CLOUD_FORBIDDEN") {
      return historyCacheResult("rejected", "HISTORY_CACHE_AUTH_REQUIRED");
    }
    return historyCacheResult(failure.retryable ? "retryable" : "rejected",
      failure.retryable ? "HISTORY_CACHE_FETCH_RETRYABLE" : "HISTORY_CACHE_FETCH_FAILED");
  }
  if (failure instanceof TranscriptHistoryBundleError) {
    return historyCacheResult(failure.retryable ? "retryable" : "rejected",
      failure.code === "HISTORY_BUNDLE_LIMIT_EXCEEDED" ? "HISTORY_CACHE_LIMIT_EXCEEDED" :
        failure.code === "HISTORY_BUNDLE_CHECKSUM_MISMATCH" ? "HISTORY_CACHE_CHECKSUM_MISMATCH" : "HISTORY_CACHE_BUNDLE_INVALID");
  }
  return historyCacheResult("rejected", "HISTORY_CACHE_FETCH_FAILED");
};

/**
 * Internal, on-demand entry point only. Nothing calls it from UI/coordinator.
 * One lifetime spans collector, detached preparation, FIFO wait, SQL, and close.
 * Cancellation is cooperative: NEVER race a native COMMIT against a timeout and
 * report a fictitious rollback. No timers retry work, no queue/cursor is advanced.
 */
export const createTranscriptHistoryCacheService = (overrides: Partial<HistoryCacheServiceDependencies> = {}) => {
  const dependencies: HistoryCacheServiceDependencies = {
    collect: fetchTranscriptHistoryBundle, persist: persistPreparedTranscriptHistoryCache,
    waitForWritesIdle: waitForHistoryCacheWritesIdle,
    identity: () => { const auth = useAuthStore.getState(); return { initialized: auth.initialized, userId: auth.user?.id ?? null }; },
    subscribeIdentity: (listener) => useAuthStore.subscribe(listener),
    deletionPending: isAccountDeletionLocallyPending,
    ...overrides,
  };
  const owners = new Set<CacheOwner>();
  const paused = new Map<string, number>();
  const invalidate = (sessionId?: string): void => {
    for (const owner of owners) {
      if (sessionId === undefined || owner.sessionId === sessionId.toLowerCase()) owner.stop("HISTORY_CACHE_CONTEXT_INACTIVE");
    }
  };
  const pauseSession = (sessionId: string): (() => void) => {
    const id = sessionId.toLowerCase(); paused.set(id, (paused.get(id) ?? 0) + 1);
    for (const owner of owners) if (owner.sessionId === id) owner.stop("HISTORY_CACHE_DELETION_PENDING");
    let released = false;
    return () => {
      if (released) return;
      released = true; const remaining = (paused.get(id) ?? 1) - 1;
      if (remaining === 0) paused.delete(id); else paused.set(id, remaining);
    };
  };
  const cache = async (input: TranscriptHistoryCacheRequest): Promise<HistoryCacheResult> => {
    let request: ReturnType<typeof captureHistoryCloudVersion>;
    let assertCaller: () => void;
    try {
      if (typeof input?.assertActive !== "function") throw historyCacheError("HISTORY_CACHE_INPUT_INVALID");
      request = captureHistoryCloudVersion(input);
      assertCaller = input.assertActive;
    } catch { return historyCacheResult("rejected", "HISTORY_CACHE_INPUT_INVALID"); }
    const { scope } = request;
    if (owners.size >= 2) return historyCacheResult("retryable", "HISTORY_CACHE_BUSY");
    const controller = new AbortController();
    const deadline = Date.now() + request.timeoutMs;
    let stopped: HistoryCacheError | null = null;
    let finished = false;
    const stop = (code: HistoryCacheErrorCode): void => {
      if (finished || stopped) return;
      stopped = historyCacheError(code);
      controller.abort();
    };
    const guard = (): void => {
      if (stopped) throw stopped;
      if (finished) throw historyCacheError("HISTORY_CACHE_CONTEXT_INACTIVE");
      if (request.signal?.aborted) stop("HISTORY_CACHE_CANCELLED");
      else if (dependencies.deletionPending() || paused.has(scope.sessionId)) stop("HISTORY_CACHE_DELETION_PENDING");
      else {
        const auth = dependencies.identity();
        if (!auth.initialized || auth.userId?.toLowerCase() !== scope.userId) stop("HISTORY_CACHE_AUTH_REQUIRED");
        else if (Date.now() >= deadline) stop("HISTORY_CACHE_TIMEOUT");
        else {
          try {
            assertCaller();
            if (request.isContextActive && request.isContextActive() !== true) stop("HISTORY_CACHE_CONTEXT_INACTIVE");
          } catch { stop("HISTORY_CACHE_CONTEXT_INACTIVE"); }
        }
      }
      if (stopped) throw stopped;
    };
    let markDrained!: () => void;
    const drained = new Promise<void>((resolve) => { markDrained = resolve; });
    const owner = { sessionId: scope.sessionId, stop, drained };
    owners.add(owner);
    let unsubscribe: (() => void) | undefined;
    let command: PreparedHistoryCacheCommand | undefined;
    const cancel = () => stop("HISTORY_CACHE_CANCELLED");
    const timer = setTimeout(() => stop("HISTORY_CACHE_TIMEOUT"), request.timeoutMs);
    try {
      guard();
      unsubscribe = dependencies.subscribeIdentity(() => {
        try {
          const auth = dependencies.identity();
          if (!auth.initialized || auth.userId?.toLowerCase() !== scope.userId) stop("HISTORY_CACHE_CONTEXT_INACTIVE");
        } catch { stop("HISTORY_CACHE_CONTEXT_INACTIVE"); }
      });
      request.signal?.addEventListener("abort", cancel);
      guard();
      const result = await dependencies.collect({ scope, versionId: request.versionId,
        expectedVersion: request.expectedVersion, signal: controller.signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
        isContextActive: () => { try { guard(); return true; } catch { return false; } },
      });
      guard();
      if (!result || !result.scope || result.source !== HISTORY_BUNDLE_SOURCE || result.selectedVersionId !== request.versionId ||
          result.scope.userId !== scope.userId || result.scope.workspaceId !== scope.workspaceId || result.scope.sessionId !== scope.sessionId) {
        throw historyCacheError("HISTORY_CACHE_BUNDLE_INVALID");
      }
      if (result.kind === "not_ready") return historyCacheResult("not_ready", "HISTORY_CACHE_BUNDLE_NOT_READY");
      if (result.kind === "unavailable") return historyCacheResult("unavailable", "HISTORY_CACHE_BUNDLE_UNAVAILABLE");
      if (request.expectedVersion !== undefined && result.bundle.versions[0]?.version !== request.expectedVersion) {
        throw historyCacheError("HISTORY_CACHE_BUNDLE_INVALID");
      }
      command = await prepareHistoryCacheCommand(result, guard);
      guard();
      // This returns only a non-content outcome. Preserve acknowledged commits,
      // even if identity, cancellation, timeout, or close changed while awaiting.
      return await dependencies.persist(command);
    } catch (failure) {
      return failureResult(stopped ?? failure);
    } finally {
      finished = true;
      if (command) revokeHistoryCacheCommand(command);
      clearTimeout(timer);
      try { request.signal?.removeEventListener("abort", cancel); } catch { /* Do not expose raw cleanup failures. */ }
      try { unsubscribe?.(); } catch { /* A finished owner cannot start more writes. */ }
      owners.delete(owner); markDrained();
    }
  };
  const waitForIdle = async (sessionId?: string): Promise<void> => {
    const relevant = () => [...owners].filter((o) => sessionId === undefined || o.sessionId === sessionId.toLowerCase());
    while (relevant().length > 0) await Promise.all(relevant().map((o) => o.drained));
    await dependencies.waitForWritesIdle(sessionId);
  };
  return { cache, invalidate, pauseSession, waitForIdle };
};
const service = createTranscriptHistoryCacheService();
export const cacheTranscriptHistoryVersion = service.cache;
export const invalidateTranscriptHistoryCache = service.invalidate;
export const pauseSessionTranscriptHistoryCache = service.pauseSession;
export const waitForTranscriptHistoryCacheIdle = service.waitForIdle;
