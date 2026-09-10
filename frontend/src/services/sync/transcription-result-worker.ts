import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  getNextEligibleTranscriptionResultRequest,
  getNextTranscriptionResultWakeAt,
  markTranscriptionRequestCancelled,
  markTranscriptionRequestFailed,
  persistCompletedTranscriptionResult,
  persistTerminalTranscriptionResult,
  persistTranscriptionResultProgress,
  rescheduleTranscriptionResultAfterFailure,
  type TranscriptionRequestQueueRow,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  fetchRemoteTranscriptionResult,
  normalizeTranscriptionResultClientError,
  type TranscriptionResultClientError,
} from "@/src/services/transcription/result-client";
import {
  TranscriptionResultReconciliationError,
} from "@/src/services/transcription/result-reconciliation";
import type { TranscriptionResultSnapshot } from "@/src/services/transcription/result-types";
import { nextBackoffMs } from "@/src/services/upload-queue/backoff";
import { useAuthStore } from "@/src/stores/auth-store";

import { notifyTranscriptionSyncChanges } from "./transcription-sync-events";

export interface TranscriptionResultSyncRunResult {
  state:
    | "completed"
    | "offline"
    | "authentication_required"
    | "web_skipped";
  processed: number;
  synchronized: number;
  pending: number;
  retried: number;
  failed: number;
  cancelled: number;
  cleanupRequired: number;
}

export interface TranscriptionResultWorkerDependencies {
  platform: string;
  getConnectionState: () => Promise<NetInfoState>;
  getAuthenticatedUserId: () => Promise<string | null>;
  getNextOperation: (
    userId: string,
    now: string,
  ) => Promise<TranscriptionRequestQueueRow | null>;
  getNextWakeAt: (userId: string, now: string) => Promise<string | null>;
  fetchRemoteResult: (input: {
    serverJobId: string;
    expectedUserId: string;
  }) => Promise<TranscriptionResultSnapshot>;
  persistProgress: typeof persistTranscriptionResultProgress;
  persistCompleted: typeof persistCompletedTranscriptionResult;
  persistTerminal: typeof persistTerminalTranscriptionResult;
  rescheduleFailure: typeof rescheduleTranscriptionResultAfterFailure;
  markFailed: typeof markTranscriptionRequestFailed;
  markCancelled: typeof markTranscriptionRequestCancelled;
  normalizeError: (error: unknown) => TranscriptionResultClientError;
  now: () => Date;
  random: () => number;
  maxOperationsPerRun: number;
  notifyChanged: () => void;
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearScheduled: (handle: ReturnType<typeof setTimeout>) => void;
}

const defaultDependencies: TranscriptionResultWorkerDependencies = {
  platform: Platform.OS,
  getConnectionState: () => NetInfo.fetch(),
  getAuthenticatedUserId: async () => {
    const storeUser = useAuthStore.getState().user?.id;
    if (storeUser) return storeUser;
    const client = getSupabase();
    if (!client) return null;
    const response = await client.auth.getSession();
    if (response.error) return null;
    return response.data.session?.user.id ?? null;
  },
  getNextOperation: getNextEligibleTranscriptionResultRequest,
  getNextWakeAt: getNextTranscriptionResultWakeAt,
  fetchRemoteResult: fetchRemoteTranscriptionResult,
  persistProgress: persistTranscriptionResultProgress,
  persistCompleted: persistCompletedTranscriptionResult,
  persistTerminal: persistTerminalTranscriptionResult,
  rescheduleFailure: rescheduleTranscriptionResultAfterFailure,
  markFailed: markTranscriptionRequestFailed,
  markCancelled: markTranscriptionRequestCancelled,
  normalizeError: normalizeTranscriptionResultClientError,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 5,
  notifyChanged: notifyTranscriptionSyncChanges,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  clearScheduled: (handle) => clearTimeout(handle),
};

const emptyResult = (
  state: TranscriptionResultSyncRunResult["state"],
): TranscriptionResultSyncRunResult => ({
  state,
  processed: 0,
  synchronized: 0,
  pending: 0,
  retried: 0,
  failed: 0,
  cancelled: 0,
  cleanupRequired: 0,
});

const isOnline = (state: NetInfoState): boolean =>
  state.isConnected !== false && state.isInternetReachable !== false;

const scopeMatches = (
  row: TranscriptionRequestQueueRow,
  snapshot: TranscriptionResultSnapshot,
): boolean =>
  snapshot.job.id === row.server_job_id &&
  snapshot.job.workspace_id === row.workspace_id &&
  snapshot.job.session_id === row.session_id &&
  snapshot.job.recording_id === row.recording_id;

const pollDelayMs = (snapshot: TranscriptionResultSnapshot): number => {
  if (snapshot.kind === "pending" && snapshot.reason === "result") return 3_000;
  if (snapshot.kind === "pending" && snapshot.reason === "cleanup") return 10_000;
  return 15_000;
};

const pendingCode = (snapshot: Extract<TranscriptionResultSnapshot, { kind: "pending" }>) => {
  if (snapshot.reason === "cleanup") {
    return {
      code: "TRANSCRIPTION_RESULT_CLEANUP_PENDING",
      message: "The transcript is complete and provider cleanup is finishing.",
    };
  }
  if (snapshot.reason === "result") {
    return {
      code: "TRANSCRIPTION_RESULT_COMMIT_PENDING",
      message: "The transcript result is finishing on the server.",
    };
  }
  return {
    code: "TRANSCRIPTION_RESULT_PROCESSING",
    message: "The transcript is still processing.",
  };
};

export const createTranscriptionResultWorker = (
  overrides: Partial<TranscriptionResultWorkerDependencies> = {},
) => {
  const dependencies: TranscriptionResultWorkerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  let activeRun: Promise<TranscriptionResultSyncRunResult> | null = null;
  let scheduledWake: ReturnType<typeof setTimeout> | null = null;

  const clearWake = (): void => {
    if (scheduledWake === null) return;
    dependencies.clearScheduled(scheduledWake);
    scheduledWake = null;
  };

  const scheduleWake = (wakeAt: string | null): void => {
    clearWake();
    if (!wakeAt || isAccountDeletionLocallyPending()) return;
    const target = Date.parse(wakeAt);
    if (!Number.isFinite(target)) return;
    const delay = Math.max(
      250,
      Math.min(60_000, target - dependencies.now().getTime()),
    );
    scheduledWake = dependencies.schedule(() => {
      scheduledWake = null;
      void run().catch(() => undefined);
    }, delay);
  };

  const execute = async (): Promise<TranscriptionResultSyncRunResult> => {
    if (isAccountDeletionLocallyPending()) return emptyResult("completed");
    if (dependencies.platform === "web") return emptyResult("web_skipped");

    const connection = await dependencies.getConnectionState();
    if (!isOnline(connection)) return emptyResult("offline");

    const userId = await dependencies.getAuthenticatedUserId();
    if (!userId) return emptyResult("authentication_required");

    const result = emptyResult("completed");
    for (
      let index = 0;
      index < dependencies.maxOperationsPerRun;
      index += 1
    ) {
      if (isAccountDeletionLocallyPending()) break;
      const now = dependencies.now();
      const row = await dependencies.getNextOperation(userId, now.toISOString());
      if (!row) break;
      result.processed += 1;

      if (row.user_id !== userId || !row.server_job_id) {
        await dependencies.markFailed(
          row.id,
          "TRANSCRIPTION_RESULT_LOCAL_SCOPE_INVALID",
          "The local transcript request scope is invalid.",
        );
        result.failed += 1;
        continue;
      }

      try {
        const snapshot = await dependencies.fetchRemoteResult({
          serverJobId: row.server_job_id,
          expectedUserId: userId,
        });
        if (!scopeMatches(row, snapshot)) {
          await dependencies.markFailed(
            row.id,
            "TRANSCRIPTION_RESULT_SCOPE_MISMATCH",
            "The transcript service returned an unexpected recording scope.",
          );
          result.failed += 1;
          continue;
        }

        if (snapshot.kind === "pending") {
          const pending = pendingCode(snapshot);
          await dependencies.persistProgress({
            queueId: row.id,
            job: snapshot.job,
            run: snapshot.run,
            nextRetryAt: new Date(now.getTime() + pollDelayMs(snapshot)).toISOString(),
            errorCode: pending.code,
            safeError: pending.message,
          });
          result.pending += 1;
          continue;
        }

        if (snapshot.kind === "cleanup_required") {
          await dependencies.persistTerminal({
            queueId: row.id,
            job: snapshot.job,
            run: snapshot.run,
            queueStatus: "failed",
            errorCode: "TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED",
            safeError:
              "The transcript completed, but secure provider cleanup requires review.",
          });
          result.cleanupRequired += 1;
          result.failed += 1;
          continue;
        }

        if (snapshot.kind === "terminal") {
          const cancelled = snapshot.status === "cancelled";
          await dependencies.persistTerminal({
            queueId: row.id,
            job: snapshot.job,
            run: snapshot.run,
            queueStatus: cancelled ? "cancelled" : "failed",
            errorCode:
              snapshot.job.last_error_code ??
              (cancelled
                ? "TRANSCRIPTION_REMOTE_JOB_CANCELLED"
                : "TRANSCRIPTION_REMOTE_JOB_FAILED"),
            safeError:
              snapshot.job.last_safe_error ??
              (cancelled
                ? "The server transcription job was cancelled."
                : "The server transcription job did not complete."),
          });
          if (cancelled) result.cancelled += 1;
          else result.failed += 1;
          continue;
        }

        await dependencies.persistCompleted({
          userId,
          queueId: row.id,
          job: snapshot.job,
          run: snapshot.run,
          version: snapshot.version,
          segments: snapshot.segments,
          expectedSegmentCount: snapshot.expectedSegmentCount,
          reconciledAt: dependencies.now().toISOString(),
        });
        result.synchronized += 1;
      } catch (error) {
        const normalized =
          error instanceof TranscriptionResultReconciliationError
            ? error
            : dependencies.normalizeError(error);
        if (
          normalized.code === "TRANSCRIPTION_RESULT_AUTHENTICATION_REQUIRED"
        ) {
          await dependencies.rescheduleFailure({
            queueId: row.id,
            nextRetryAt: new Date(now.getTime() + 30_000).toISOString(),
            errorCode: normalized.code,
            safeError: normalized.message,
          });
          result.retried += 1;
          result.state = "authentication_required";
          break;
        }

        if (
          normalized.code === "TRANSCRIPTION_RESULT_NOT_FOUND" ||
          normalized.code === "RESULT_RECONCILIATION_SESSION_UNAVAILABLE"
        ) {
          await dependencies.markCancelled(
            row.id,
            normalized.code,
            normalized.message,
          );
          result.cancelled += 1;
          continue;
        }

        if (normalized.retryable) {
          const attempt = Math.max(
            1,
            Math.min(row.attempt_count + 1, row.max_attempts),
          );
          await dependencies.rescheduleFailure({
            queueId: row.id,
            nextRetryAt: new Date(
              now.getTime() +
                nextBackoffMs(attempt, { random: dependencies.random }),
            ).toISOString(),
            errorCode: normalized.code,
            safeError: normalized.message,
          });
          result.retried += 1;
          break;
        }

        await dependencies.markFailed(
          row.id,
          normalized.code,
          normalized.message,
        );
        result.failed += 1;
      }
    }

    const nextWakeAt = await dependencies.getNextWakeAt(
      userId,
      dependencies.now().toISOString(),
    );
    scheduleWake(nextWakeAt);
    return result;
  };

  const run = (): Promise<TranscriptionResultSyncRunResult> => {
    if (activeRun) return activeRun;
    clearWake();
    const current = execute()
      .then((result) => {
        if (result.processed > 0) dependencies.notifyChanged();
        return result;
      })
      .finally(() => {
        activeRun = null;
      });
    activeRun = current;
    return current;
  };

  return {
    run,
    waitForIdle: async (): Promise<void> => {
      const current = activeRun;
      if (!current) return;
      await current.then(() => undefined, () => undefined);
    },
    dispose: (): void => clearWake(),
  };
};

const defaultWorker = createTranscriptionResultWorker();

export const runTranscriptionResultWorker = (): Promise<TranscriptionResultSyncRunResult> =>
  defaultWorker.run();

export const waitForTranscriptionResultSyncIdle = (): Promise<void> =>
  defaultWorker.waitForIdle();

export const requestTranscriptionResultSync = (): void => {
  void runTranscriptionResultWorker().catch(() => {
    // Result rows retain safe diagnostics; lifecycle sync must not create an
    // unhandled rejection in the UI.
  });
};
