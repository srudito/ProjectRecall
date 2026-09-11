import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { AppState, Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import { isTranscriptionMutationReleased } from "@/src/config/transcription-release";
import {
  canSubmitTranscriptEditQueue,
  claimTranscriptEditQueue,
  completeTranscriptEditQueueSuccess,
  deferTranscriptEditQueue,
  getNextEligibleTranscriptEditQueue,
  getNextTranscriptEditWakeAt,
  markTranscriptEditQueueCancelled,
  markTranscriptEditQueueConflict,
  markTranscriptEditQueueFailed,
  resetSubmittingTranscriptEditQueue,
  rescheduleTranscriptEditQueue,
  type TranscriptCurrentVersionSyncTarget,
  type TranscriptEditQueueGuard,
  type TranscriptEditQueueRow,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  invokeRemoteTranscriptEdit,
  normalizeTranscriptEditClientError,
  type RemoteTranscriptEditResult,
  type TranscriptEditClientError,
} from "@/src/services/transcription/edit-client";
import { nextBackoffMs } from "@/src/services/upload-queue/backoff";
import { useAuthStore } from "@/src/stores/auth-store";

import { requestTranscriptCurrentVersionSync } from "./transcript-current-version-worker";
import { notifyTranscriptionSyncChanges } from "./transcription-sync-events";

export interface TranscriptEditSyncRunResult {
  state:
    | "completed"
    | "paused"
    | "offline"
    | "authentication_required"
    | "release_locked"
    | "web_skipped";
  processed: number;
  succeeded: number;
  retried: number;
  deferred: number;
  conflicts: number;
  failed: number;
  cancelled: number;
}

export interface TranscriptEditWorkerDependencies {
  platform: string;
  isMutationReleased: () => boolean;
  getConnectionState: () => Promise<NetInfoState>;
  getAuthenticatedUserId: () => Promise<string | null>;
  isDeletionPending: () => boolean;
  getCurrentUserId: () => string | null;
  isAppActive: () => boolean;
  resetSubmitting: typeof resetSubmittingTranscriptEditQueue;
  getNextOperation: typeof getNextEligibleTranscriptEditQueue;
  getNextWakeAt: typeof getNextTranscriptEditWakeAt;
  claimOperation: typeof claimTranscriptEditQueue;
  canSubmitOperation: typeof canSubmitTranscriptEditQueue;
  deferOperation: typeof deferTranscriptEditQueue;
  rescheduleOperation: typeof rescheduleTranscriptEditQueue;
  completeOperation: typeof completeTranscriptEditQueueSuccess;
  markConflict: typeof markTranscriptEditQueueConflict;
  markFailed: typeof markTranscriptEditQueueFailed;
  markCancelled: typeof markTranscriptEditQueueCancelled;
  scheduleWake: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearWake: (handle: ReturnType<typeof setTimeout>) => void;
  submitRemoteEdit: (input: {
    sessionId: string;
    expectedCurrentVersionId: string;
    clientVersionId: string;
    plainText: string;
    expectedUserId: string;
  }) => Promise<RemoteTranscriptEditResult>;
  normalizeRemoteError: (error: unknown) => TranscriptEditClientError;
  now: () => Date;
  random: () => number;
  maxOperationsPerRun: number;
  maxAttempts: number;
  notifyChanged: () => void;
  requestCurrentVersionSync: (
    target: TranscriptCurrentVersionSyncTarget,
  ) => void;
}

const defaultDependencies: TranscriptEditWorkerDependencies = {
  platform: Platform.OS,
  isMutationReleased: isTranscriptionMutationReleased,
  getConnectionState: () => NetInfo.fetch(),
  getAuthenticatedUserId: async () => {
    const storeUser = useAuthStore.getState().user?.id;
    if (storeUser) return storeUser;
    const client = getSupabase();
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) return null;
    return data.session?.user.id ?? null;
  },
  isDeletionPending: isAccountDeletionLocallyPending,
  getCurrentUserId: () => useAuthStore.getState().user?.id ?? null,
  isAppActive: () => AppState.currentState === "active",
  getNextWakeAt: getNextTranscriptEditWakeAt,
  canSubmitOperation: canSubmitTranscriptEditQueue,
  scheduleWake: (callback, delayMs) => setTimeout(callback, delayMs),
  clearWake: (handle) => clearTimeout(handle),
  resetSubmitting: resetSubmittingTranscriptEditQueue,
  getNextOperation: getNextEligibleTranscriptEditQueue,
  claimOperation: claimTranscriptEditQueue,
  deferOperation: deferTranscriptEditQueue,
  rescheduleOperation: rescheduleTranscriptEditQueue,
  completeOperation: completeTranscriptEditQueueSuccess,
  markConflict: markTranscriptEditQueueConflict,
  markFailed: markTranscriptEditQueueFailed,
  markCancelled: markTranscriptEditQueueCancelled,
  submitRemoteEdit: invokeRemoteTranscriptEdit,
  normalizeRemoteError: normalizeTranscriptEditClientError,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 10,
  maxAttempts: 5,
  notifyChanged: notifyTranscriptionSyncChanges,
  requestCurrentVersionSync: requestTranscriptCurrentVersionSync,
};

const emptyResult = (
  state: TranscriptEditSyncRunResult["state"],
): TranscriptEditSyncRunResult => ({
  state,
  processed: 0,
  succeeded: 0,
  retried: 0,
  deferred: 0,
  conflicts: 0,
  failed: 0,
  cancelled: 0,
});

const isOnline = (state: NetInfoState): boolean =>
  state.isConnected !== false && state.isInternetReachable !== false;

const retryAt = (
  dependencies: TranscriptEditWorkerDependencies,
  attempt: number,
): string =>
  new Date(
    dependencies.now().getTime() +
      nextBackoffMs(attempt, { random: dependencies.random }),
  ).toISOString();

const deferAt = (
  dependencies: TranscriptEditWorkerDependencies,
  delayMs: number,
): string => new Date(dependencies.now().getTime() + delayMs).toISOString();

const reachedAttemptLimit = (
  claimed: TranscriptEditQueueRow,
  dependencies: TranscriptEditWorkerDependencies,
): boolean =>
  claimed.attempt_count >=
  Math.min(claimed.max_attempts, dependencies.maxAttempts);

const MIN_WAKE_DELAY_MS = 250;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

class TranscriptEditRunInterrupted extends Error {
  constructor(readonly state: "paused" | "authentication_required") {
    super("Transcript edit synchronization was interrupted.");
  }
}

export const createTranscriptEditWorker = (
  overrides: Partial<TranscriptEditWorkerDependencies> = {},
) => {
  const dependencies: TranscriptEditWorkerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  if (!Number.isSafeInteger(dependencies.maxOperationsPerRun) ||
      dependencies.maxOperationsPerRun < 1 ||
      !Number.isSafeInteger(dependencies.maxAttempts) || dependencies.maxAttempts < 1) {
    throw new Error("The transcript edit worker limits are invalid.");
  }

  let activeRun: Promise<TranscriptEditSyncRunResult> | null = null;
  let scheduledWake: ReturnType<typeof setTimeout> | null = null;
  let wakeSerial = 0;
  let generation = 0;
  let paused = false;
  let disposed = false;
  let rerunRequested = false;

  const currentUserId = () => dependencies.getCurrentUserId()?.toLowerCase() ?? null;
  const blockedState = (): TranscriptEditSyncRunResult["state"] | null => {
    if (dependencies.platform !== "android" && dependencies.platform !== "ios") return "web_skipped";
    if (!dependencies.isMutationReleased()) return "release_locked";
    if (paused || disposed || dependencies.isDeletionPending() || !dependencies.isAppActive()) return "paused";
    if (!currentUserId()) return "authentication_required";
    return null;
  };

  const clearScheduledWake = (): void => {
    wakeSerial += 1;
    if (scheduledWake !== null) dependencies.clearWake(scheduledWake);
    scheduledWake = null;
  };

  const notify = (guard: TranscriptEditQueueGuard): void => {
    try { guard.assertActive(); dependencies.notifyChanged(); } catch {
      // Listener/lifecycle changes never turn a durable outcome into failure.
    }
  };

  const execute = async (
    userId: string,
    runGeneration: number,
  ): Promise<{ result: TranscriptEditSyncRunResult; wakeAt: number | null }> => {
    const result = emptyResult("completed");
    const guard: TranscriptEditQueueGuard = {
      userId,
      assertActive: () => {
        if (currentUserId() !== userId) throw new TranscriptEditRunInterrupted("authentication_required");
        if (runGeneration !== generation || blockedState() !== null) throw new TranscriptEditRunInterrupted("paused");
      },
    };

    try {
      guard.assertActive();
      const connection = await dependencies.getConnectionState();
      guard.assertActive();
      if (!isOnline(connection)) return { result: emptyResult("offline"), wakeAt: null };
      const authenticatedUserId = await dependencies.getAuthenticatedUserId();
      guard.assertActive();
      if (authenticatedUserId?.toLowerCase() !== userId) {
        return { result: emptyResult("authentication_required"), wakeAt: null };
      }

      // One singleton run owns recovery. A paused/in-flight RPC is never reset
      // by a parallel run. Replays retain the same immutable UUID/base/payload.
      const recovered = await dependencies.resetSubmitting(userId, guard);
      guard.assertActive();
      if (recovered > 0) notify(guard);

      for (let index = 0; index < dependencies.maxOperationsPerRun; index += 1) {
        guard.assertActive();
        if (index > 0) {
          const latestConnection = await dependencies.getConnectionState();
          guard.assertActive();
          if (!isOnline(latestConnection)) {
            result.state = "offline";
            return { result, wakeAt: null };
          }
        }
        const next = await dependencies.getNextOperation(
          userId, dependencies.now().toISOString(), dependencies.maxAttempts, guard,
        );
        guard.assertActive();
        if (!next) break;
        if (next.user_id !== userId) throw new Error("The transcript edit queue returned another user.");

        const claimed = await dependencies.claimOperation(next.id, guard, dependencies.maxAttempts);
        guard.assertActive();
        if (!claimed) continue;
        if (claimed.id !== next.id || claimed.user_id !== userId ||
            claimed.workspace_id !== next.workspace_id || claimed.session_id !== next.session_id ||
            claimed.expected_current_version_id !== next.expected_current_version_id ||
            claimed.plain_text !== next.plain_text || claimed.queue_status !== "submitting" ||
            !Number.isSafeInteger(claimed.attempt_count) || claimed.attempt_count < 1 ||
            !Number.isSafeInteger(claimed.max_attempts) || claimed.max_attempts < 1 ||
            claimed.attempt_count > Math.min(claimed.max_attempts, dependencies.maxAttempts)) {
          throw new Error("The transcript edit claim scope changed.");
        }
        result.processed += 1;
        notify(guard);
        guard.assertActive();

        const canSubmit = await dependencies.canSubmitOperation(claimed, guard);
        guard.assertActive();
        if (!canSubmit) {
          await dependencies.markCancelled(claimed.id, "TRANSCRIPT_EDIT_SESSION_UNAVAILABLE",
            "This session is no longer available for transcript editing.", guard);
          result.cancelled += 1;
          notify(guard);
          continue;
        }

        let remote: RemoteTranscriptEditResult;
        try {
          // Network starts only after claim and scope transactions COMMIT.
          remote = await dependencies.submitRemoteEdit({
            sessionId: claimed.session_id,
            expectedCurrentVersionId: claimed.expected_current_version_id,
            clientVersionId: claimed.id,
            plainText: claimed.plain_text,
            expectedUserId: userId,
          });
        } catch (error) {
          guard.assertActive();
          // Only RPC failures use transport normalization. A local COMMIT
          // failure after remote success must not be mislabeled as RPC failure.
          const normalized = dependencies.normalizeRemoteError(error);
          if (normalized.code === "TRANSCRIPT_EDIT_BASE_CONFLICT") {
            await dependencies.markConflict(claimed.id, normalized.code, normalized.message, guard);
            result.conflicts += 1;
          } else if (normalized.code === "TRANSCRIPT_EDIT_FEATURE_DISABLED" ||
                     normalized.code === "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED") {
            const authenticationRequired = normalized.code === "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED";
            await dependencies.deferOperation(claimed.id,
              deferAt(dependencies, authenticationRequired ? 30_000 : 60_000),
              normalized.code, normalized.message, guard);
            result.deferred += 1;
            notify(guard);
            if (authenticationRequired) {
              result.state = "authentication_required";
              return { result, wakeAt: null };
            }
            break;
          } else if (normalized.code === "TRANSCRIPT_EDIT_SESSION_UNAVAILABLE") {
            await dependencies.markCancelled(claimed.id, normalized.code, normalized.message, guard);
            result.cancelled += 1;
          } else if (normalized.retryable && !reachedAttemptLimit(claimed, dependencies)) {
            await dependencies.rescheduleOperation(claimed.id,
              retryAt(dependencies, claimed.attempt_count), normalized.code, normalized.message, guard);
            result.retried += 1;
            notify(guard);
            break;
          } else {
            await dependencies.markFailed(claimed.id, normalized.code, normalized.message, guard);
            result.failed += 1;
          }
          notify(guard);
          continue;
        }

        guard.assertActive();
        if (remote.transcriptVersionId !== claimed.id.toLowerCase()) {
          await dependencies.markFailed(claimed.id, "TRANSCRIPT_EDIT_RESPONSE_SCOPE_MISMATCH",
            "The transcript edit service returned an unexpected version identity.", guard);
          result.failed += 1;
          notify(guard);
          continue;
        }
        await dependencies.completeOperation({
          queueId: claimed.id, userId: claimed.user_id, workspaceId: claimed.workspace_id,
          sessionId: claimed.session_id, expectedCurrentVersionId: claimed.expected_current_version_id,
          plainText: claimed.plain_text,
        }, guard);
        result.succeeded += 1;
        notify(guard);
        try {
          guard.assertActive();
          // A late idempotent replay can succeed without becoming current.
          dependencies.requestCurrentVersionSync({
            workspace_id: claimed.workspace_id, session_id: claimed.session_id,
          });
        } catch { /* Best-effort cache refresh cannot undo a committed Save. */ }
      }

      guard.assertActive();
      const wakeAt = await dependencies.getNextWakeAt(
        userId, dependencies.now().toISOString(), dependencies.maxAttempts, guard,
      );
      guard.assertActive();
      if (wakeAt !== null && !Number.isFinite(Date.parse(wakeAt))) {
        throw new Error("The transcript edit retry time is invalid.");
      }
      return { result, wakeAt: wakeAt === null ? null : Date.parse(wakeAt) };
    } catch (error) {
      if (error instanceof TranscriptEditRunInterrupted) {
        result.state = error.state;
        return { result, wakeAt: null };
      }
      // Stop self-scheduling on local read/write failures. A later explicit
      // lifecycle wake recovers submitting rows; do not loop RPCs on disk failure.
      throw error;
    }
  };

  const schedule = (delayMs: number): void => {
    clearScheduledWake();
    const serial = wakeSerial;
    const owner = currentUserId();
    const scheduledGeneration = generation;
    scheduledWake = dependencies.scheduleWake(() => {
      if (serial !== wakeSerial || generation !== scheduledGeneration || currentUserId() !== owner) return;
      scheduledWake = null;
      void run().catch(() => { /* Durable state retries on the next lifecycle wake. */ });
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_WAKE_DELAY_MS, delayMs)));
  };

  const run = (): Promise<TranscriptEditSyncRunResult> => {
    clearScheduledWake();
    const blocked = blockedState();
    if (blocked) return Promise.resolve(emptyResult(blocked));
    if (activeRun) {
      rerunRequested = true;
      return activeRun;
    }
    const owner = currentUserId();
    if (!owner) return Promise.resolve(emptyResult("authentication_required"));
    const runGeneration = generation;
    let nextWake: number | null = null;
    const pending = execute(owner, runGeneration)
      .then(({ result, wakeAt }) => { nextWake = wakeAt; return result; })
      .finally(() => {
        activeRun = null;
        const requested = rerunRequested;
        rerunRequested = false;
        if (blockedState() !== null) return;
        // Retain a NEW wake even when the older pass exits offline or was
        // invalidated by pause/resume. Eligibility still enforces due-time.
        try {
          if (requested) schedule(MIN_WAKE_DELAY_MS);
          else if (generation === runGeneration && currentUserId() === owner && nextWake !== null) {
            schedule(nextWake - dependencies.now().getTime());
          }
        } catch {
          // Scheduling is reconstructible. Never change a durable Save outcome
          // just because a timer could not be installed.
        }
      });
    activeRun = pending;
    return pending;
  };

  const pause = (): void => {
    paused = true;
    generation += 1;
    rerunRequested = false;
    clearScheduledWake();
  };

  return {
    run,
    pause,
    resume: (): Promise<TranscriptEditSyncRunResult> => {
      if (!disposed) paused = false;
      return run();
    },
    // After pause(), there are no timers or admitted new runs. This waits for
    // the actual in-flight promise, NOT a timeout pretending the RPC stopped.
    waitForIdle: async (): Promise<void> => {
      const pending = activeRun;
      if (pending) await pending.then(() => undefined, () => undefined);
    },
    dispose: (): void => { disposed = true; pause(); },
  };
};

const defaultWorker = createTranscriptEditWorker();

export const runTranscriptEditWorker = (): Promise<TranscriptEditSyncRunResult> =>
  defaultWorker.run();

export const waitForTranscriptEditSyncIdle = (): Promise<void> =>
  defaultWorker.waitForIdle();

export const pauseTranscriptEditSync = (): void => defaultWorker.pause();

export const resumeTranscriptEditSync = (): void => {
  void defaultWorker.resume().catch(() => { /* Queue remains durable. */ });
};

export const requestTranscriptEditSync = (): void => {
  void runTranscriptEditWorker().catch(() => {
    // Durable queue rows retain safe diagnostics. Lifecycle sync must not
    // create unhandled promise rejections in the UI.
  });
};
