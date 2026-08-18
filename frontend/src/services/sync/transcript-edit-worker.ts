import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  claimTranscriptEditQueue,
  completeTranscriptEditQueueSuccess,
  deferTranscriptEditQueue,
  getNextEligibleTranscriptEditQueue,
  markTranscriptEditQueueCancelled,
  markTranscriptEditQueueConflict,
  markTranscriptEditQueueFailed,
  resetSubmittingTranscriptEditQueue,
  rescheduleTranscriptEditQueue,
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

import { notifyTranscriptionSyncChanges } from "./transcription-sync-events";

export interface TranscriptEditSyncRunResult {
  state:
    | "completed"
    | "offline"
    | "authentication_required"
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
  getConnectionState: () => Promise<NetInfoState>;
  getAuthenticatedUserId: () => Promise<string | null>;
  isDeletionPending: () => boolean;
  resetSubmitting: (userId: string) => Promise<number>;
  getNextOperation: (
    userId: string,
    now: string,
  ) => Promise<TranscriptEditQueueRow | null>;
  claimOperation: (id: string) => Promise<TranscriptEditQueueRow | null>;
  deferOperation: (
    id: string,
    nextRetryAt: string,
    errorCode: string,
    safeError: string,
  ) => Promise<void>;
  rescheduleOperation: (
    id: string,
    nextRetryAt: string,
    errorCode: string,
    safeError: string,
  ) => Promise<void>;
  completeOperation: (input: {
    queueId: string;
    userId: string;
    workspaceId: string;
    sessionId: string;
    expectedCurrentVersionId: string;
    plainText: string;
  }) => Promise<void>;
  markConflict: (
    id: string,
    errorCode: string,
    safeError: string,
  ) => Promise<void>;
  markFailed: (
    id: string,
    errorCode: string,
    safeError: string,
  ) => Promise<void>;
  markCancelled: (
    id: string,
    errorCode: string,
    safeError: string,
  ) => Promise<void>;
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
}

const defaultDependencies: TranscriptEditWorkerDependencies = {
  platform: Platform.OS,
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

export const createTranscriptEditWorker = (
  overrides: Partial<TranscriptEditWorkerDependencies> = {},
) => {
  const dependencies: TranscriptEditWorkerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  let activeRun: Promise<TranscriptEditSyncRunResult> | null = null;

  const execute = async (): Promise<TranscriptEditSyncRunResult> => {
    if (dependencies.isDeletionPending()) {
      return emptyResult("completed");
    }

    if (dependencies.platform === "web") {
      return emptyResult("web_skipped");
    }

    const connection = await dependencies.getConnectionState();
    if (!isOnline(connection)) return emptyResult("offline");

    const userId = await dependencies.getAuthenticatedUserId();
    if (!userId) return emptyResult("authentication_required");

    // If the app stopped after the server RPC committed but before local
    // completion, stable client-version UUID idempotency makes this safe:
    // restore the row and replay the same immutable request.
    await dependencies.resetSubmitting(userId);

    const result = emptyResult("completed");

    for (
      let index = 0;
      index < dependencies.maxOperationsPerRun;
      index += 1
    ) {
      if (dependencies.isDeletionPending()) break;

      const next = await dependencies.getNextOperation(
        userId,
        dependencies.now().toISOString(),
      );
      if (!next) break;

      const claimed = await dependencies.claimOperation(next.id);
      if (!claimed) continue;
      result.processed += 1;

      if (claimed.user_id !== userId) {
        await dependencies.markFailed(
          claimed.id,
          "TRANSCRIPT_EDIT_USER_MISMATCH",
          "This transcript edit belongs to another signed-in user.",
        );
        result.failed += 1;
        continue;
      }

      try {
        // The RPC may report a different currentVersionId on a late idempotent
        // replay because another valid edit can become current afterwards.
        // transcriptVersionId is the stable identity that must match this row.
        const remote = await dependencies.submitRemoteEdit({
          sessionId: claimed.session_id,
          expectedCurrentVersionId: claimed.expected_current_version_id,
          clientVersionId: claimed.id,
          plainText: claimed.plain_text,
          expectedUserId: userId,
        });

        if (remote.transcriptVersionId !== claimed.id.toLowerCase()) {
          await dependencies.markFailed(
            claimed.id,
            "TRANSCRIPT_EDIT_RESPONSE_SCOPE_MISMATCH",
            "The transcript edit service returned an unexpected version identity.",
          );
          result.failed += 1;
          continue;
        }

        await dependencies.completeOperation({
          queueId: claimed.id,
          userId: claimed.user_id,
          workspaceId: claimed.workspace_id,
          sessionId: claimed.session_id,
          expectedCurrentVersionId: claimed.expected_current_version_id,
          plainText: claimed.plain_text,
        });
        result.succeeded += 1;
      } catch (error) {
        const normalized = dependencies.normalizeRemoteError(error);

        if (normalized.code === "TRANSCRIPT_EDIT_BASE_CONFLICT") {
          await dependencies.markConflict(
            claimed.id,
            normalized.code,
            normalized.message,
          );
          result.conflicts += 1;
          continue;
        }

        if (normalized.code === "TRANSCRIPT_EDIT_FEATURE_DISABLED") {
          await dependencies.deferOperation(
            claimed.id,
            deferAt(dependencies, 60_000),
            normalized.code,
            normalized.message,
          );
          result.deferred += 1;
          break;
        }

        if (normalized.code === "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED") {
          await dependencies.deferOperation(
            claimed.id,
            deferAt(dependencies, 30_000),
            normalized.code,
            normalized.message,
          );
          result.deferred += 1;
          result.state = "authentication_required";
          break;
        }

        if (normalized.code === "TRANSCRIPT_EDIT_SESSION_UNAVAILABLE") {
          await dependencies.markCancelled(
            claimed.id,
            normalized.code,
            normalized.message,
          );
          result.cancelled += 1;
          continue;
        }

        if (
          normalized.retryable &&
          !reachedAttemptLimit(claimed, dependencies)
        ) {
          await dependencies.rescheduleOperation(
            claimed.id,
            retryAt(dependencies, claimed.attempt_count),
            normalized.code,
            normalized.message,
          );
          result.retried += 1;
          break;
        }

        await dependencies.markFailed(
          claimed.id,
          normalized.code,
          normalized.message,
        );
        result.failed += 1;
      }
    }

    return result;
  };

  return {
    run: (): Promise<TranscriptEditSyncRunResult> => {
      if (activeRun) return activeRun;
      const run = execute()
        .then((result) => {
          if (result.processed > 0) dependencies.notifyChanged();
          return result;
        })
        .finally(() => {
          activeRun = null;
        });
      activeRun = run;
      return run;
    },
    waitForIdle: async (): Promise<void> => {
      const run = activeRun;
      if (!run) return;
      await run.then(() => undefined, () => undefined);
    },
  };
};

const defaultWorker = createTranscriptEditWorker();

export const runTranscriptEditWorker = (): Promise<TranscriptEditSyncRunResult> =>
  defaultWorker.run();

export const waitForTranscriptEditSyncIdle = (): Promise<void> =>
  defaultWorker.waitForIdle();

export const requestTranscriptEditSync = (): void => {
  void runTranscriptEditWorker().catch(() => {
    // Durable queue rows retain safe diagnostics. Lifecycle sync must not
    // create unhandled promise rejections in the UI.
  });
};
