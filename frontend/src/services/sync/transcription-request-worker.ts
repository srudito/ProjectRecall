import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import { isTranscriptionMutationReleased } from "@/src/config/transcription-release";
import { recordingSchema, sessionSchema } from "@/src/domain/models";
import {
  claimTranscriptionRequest,
  deferTranscriptionRequest,
  getNextEligibleTranscriptionRequest,
  getRecording,
  getSession,
  markTranscriptionRequestCancelled,
  markTranscriptionRequestFailed,
  markTranscriptionRequestSubmitted,
  resetSubmittingTranscriptionRequests,
  rescheduleTranscriptionRequest,
  type RecordingRecord,
  type SessionRecord,
  type TranscriptionRequestQueueRow,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  invokeRemoteTranscriptionRequest,
  normalizeTranscriptionRequestClientError,
  type RemoteTranscriptionRequestResult,
  type TranscriptionRequestClientError,
} from "@/src/services/transcription/request-client";
import {
  prepareTranscriptionRequest,
  TranscriptionRequestErrorCode,
} from "@/src/services/transcription/contracts";
import { nextBackoffMs } from "@/src/services/upload-queue/backoff";
import { useAuthStore } from "@/src/stores/auth-store";

import {
  notifyTranscriptionRequestSubmitted,
  notifyTranscriptionSyncChanges,
} from "./transcription-sync-events";

export interface TranscriptionRequestSyncRunResult {
  state:
    | "completed"
    | "offline"
    | "authentication_required"
    | "release_locked"
    | "web_skipped";
  processed: number;
  submitted: number;
  retried: number;
  deferred: number;
  failed: number;
  cancelled: number;
}

export interface TranscriptionRequestWorkerDependencies {
  platform: string;
  isMutationReleased: () => boolean;
  getConnectionState: () => Promise<NetInfoState>;
  getAuthenticatedUserId: () => Promise<string | null>;
  resetSubmitting: (userId: string) => Promise<number>;
  getNextOperation: (
    userId: string,
    now: string,
  ) => Promise<TranscriptionRequestQueueRow | null>;
  claimOperation: (id: string) => Promise<TranscriptionRequestQueueRow | null>;
  getLocalSession: (id: string) => Promise<SessionRecord | null>;
  getLocalRecording: (id: string) => Promise<RecordingRecord | null>;
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
  markSubmitted: (id: string, serverJobId: string) => Promise<void>;
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
  submitRemoteRequest: (input: {
    recordingId: string;
    expectedUserId: string;
  }) => Promise<RemoteTranscriptionRequestResult>;
  normalizeRemoteError: (
    error: unknown,
  ) => Promise<TranscriptionRequestClientError>;
  now: () => Date;
  random: () => number;
  maxOperationsPerRun: number;
  maxAttempts: number;
  notifyChanged: () => void;
}

const defaultDependencies: TranscriptionRequestWorkerDependencies = {
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
  resetSubmitting: resetSubmittingTranscriptionRequests,
  getNextOperation: getNextEligibleTranscriptionRequest,
  claimOperation: claimTranscriptionRequest,
  getLocalSession: getSession,
  getLocalRecording: getRecording,
  deferOperation: deferTranscriptionRequest,
  rescheduleOperation: rescheduleTranscriptionRequest,
  markSubmitted: markTranscriptionRequestSubmitted,
  markFailed: markTranscriptionRequestFailed,
  markCancelled: markTranscriptionRequestCancelled,
  submitRemoteRequest: invokeRemoteTranscriptionRequest,
  normalizeRemoteError: normalizeTranscriptionRequestClientError,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 10,
  maxAttempts: 5,
  notifyChanged: notifyTranscriptionSyncChanges,
};

const emptyResult = (
  state: TranscriptionRequestSyncRunResult["state"],
): TranscriptionRequestSyncRunResult => ({
  state,
  processed: 0,
  submitted: 0,
  retried: 0,
  deferred: 0,
  failed: 0,
  cancelled: 0,
});

const isOnline = (state: NetInfoState): boolean =>
  state.isConnected !== false && state.isInternetReachable !== false;

const retryAt = (
  dependencies: TranscriptionRequestWorkerDependencies,
  attempt: number,
): string =>
  new Date(
    dependencies.now().getTime() +
      nextBackoffMs(attempt, { random: dependencies.random }),
  ).toISOString();

const deferAt = (
  dependencies: TranscriptionRequestWorkerDependencies,
  delayMs: number,
): string => new Date(dependencies.now().getTime() + delayMs).toISOString();

const reachedAttemptLimit = (
  claimed: TranscriptionRequestQueueRow,
  dependencies: TranscriptionRequestWorkerDependencies,
): boolean =>
  claimed.attempt_count >= Math.min(claimed.max_attempts, dependencies.maxAttempts);

export const createTranscriptionRequestWorker = (
  overrides: Partial<TranscriptionRequestWorkerDependencies> = {},
) => {
  const dependencies: TranscriptionRequestWorkerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  let activeRun: Promise<TranscriptionRequestSyncRunResult> | null = null;

  const execute = async (): Promise<TranscriptionRequestSyncRunResult> => {
    if (dependencies.platform === "web") {
      return emptyResult("web_skipped");
    }

    if (!dependencies.isMutationReleased()) {
      return emptyResult("release_locked");
    }

    if (isAccountDeletionLocallyPending()) {
      return emptyResult("completed");
    }

    const connection = await dependencies.getConnectionState();
    if (!isOnline(connection)) return emptyResult("offline");

    const userId = await dependencies.getAuthenticatedUserId();
    if (!userId) return emptyResult("authentication_required");

    // A prior process/run may have stopped after claiming a row but before
    // persisting its outcome. Server-side request idempotency makes recovery
    // safe, so restore any local submitting rows before every single-flight run.
    await dependencies.resetSubmitting(userId);

    const result = emptyResult("completed");

    for (
      let index = 0;
      index < dependencies.maxOperationsPerRun;
      index += 1
    ) {
      if (isAccountDeletionLocallyPending()) break;

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
          "TRANSCRIPTION_REQUEST_USER_MISMATCH",
          "This transcription request belongs to another signed-in user.",
        );
        result.failed += 1;
        continue;
      }

      const [session, recording] = await Promise.all([
        dependencies.getLocalSession(claimed.session_id),
        dependencies.getLocalRecording(claimed.recording_id),
      ]);

      if (!session || session.deleted_at != null) {
        await dependencies.markCancelled(
          claimed.id,
          "TRANSCRIPTION_SESSION_UNAVAILABLE",
          "The session is no longer available for transcription.",
        );
        result.cancelled += 1;
        continue;
      }

      if (!recording || recording.session_id !== session.id) {
        await dependencies.markFailed(
          claimed.id,
          "TRANSCRIPTION_RECORDING_NOT_FOUND",
          "The local recording could not be found.",
        );
        result.failed += 1;
        continue;
      }

      if (
        session.local_sync_status !== "synchronized" ||
        session.cloud_sync_status !== "synchronized" ||
        recording.upload_status === "pending" ||
        recording.upload_status === "uploading" ||
        recording.upload_status === "uploaded" ||
        recording.upload_status === "local_only"
      ) {
        await dependencies.deferOperation(
          claimed.id,
          deferAt(dependencies, 2_000),
          "TRANSCRIPTION_RECORDING_UPLOAD_PENDING",
          "Waiting for the session and recording to finish cloud synchronization.",
        );
        result.deferred += 1;
        continue;
      }

      if (
        recording.upload_status === "failed" ||
        recording.upload_status === "cancelled"
      ) {
        await dependencies.markFailed(
          claimed.id,
          "TRANSCRIPTION_RECORDING_UPLOAD_FAILED",
          "Retry the recording upload before requesting transcription.",
        );
        result.failed += 1;
        continue;
      }

      if (
        !Number.isSafeInteger(recording.duration_ms) ||
        recording.duration_ms <= 0 ||
        !/^(audio|video)\/[A-Za-z0-9.+-]+$/.test(recording.mime_type)
      ) {
        await dependencies.markFailed(
          claimed.id,
          "TRANSCRIPTION_LOCAL_STATE_INVALID",
          "The local recording media metadata is not valid for transcription.",
        );
        result.failed += 1;
        continue;
      }

      const parsedSession = sessionSchema.safeParse(session);
      const parsedRecording = recordingSchema.safeParse(recording);
      if (!parsedSession.success || !parsedRecording.success) {
        await dependencies.markFailed(
          claimed.id,
          "TRANSCRIPTION_LOCAL_STATE_INVALID",
          "The local recording metadata is not valid for transcription.",
        );
        result.failed += 1;
        continue;
      }

      const prepared = prepareTranscriptionRequest({
        session: parsedSession.data,
        recording: parsedRecording.data,
      });
      if (!prepared.ok) {
        if (
          prepared.code ===
          TranscriptionRequestErrorCode.RECORDING_NOT_SYNCHRONIZED
        ) {
          await dependencies.deferOperation(
            claimed.id,
            deferAt(dependencies, 2_000),
            prepared.code,
            prepared.reason,
          );
          result.deferred += 1;
          continue;
        }

        const cancellation =
          prepared.code === TranscriptionRequestErrorCode.SESSION_UNAVAILABLE;
        if (cancellation) {
          await dependencies.markCancelled(
            claimed.id,
            prepared.code,
            prepared.reason,
          );
          result.cancelled += 1;
        } else {
          await dependencies.markFailed(
            claimed.id,
            prepared.code,
            prepared.reason,
          );
          result.failed += 1;
        }
        continue;
      }

      if (
        prepared.value.workspaceId !== claimed.workspace_id ||
        prepared.value.sessionId !== claimed.session_id ||
        prepared.value.recordingId !== claimed.recording_id ||
        prepared.value.idempotencyKey !== claimed.idempotency_key
      ) {
        await dependencies.markFailed(
          claimed.id,
          "TRANSCRIPTION_REQUEST_SCOPE_CHANGED",
          "The recording settings changed before transcription could be requested. Request it again.",
        );
        result.failed += 1;
        continue;
      }

      try {
        const remote = await dependencies.submitRemoteRequest({
          recordingId: claimed.recording_id,
          expectedUserId: userId,
        });

        if (
          remote.workspaceId !== claimed.workspace_id ||
          remote.sessionId !== claimed.session_id ||
          remote.recordingId !== claimed.recording_id
        ) {
          await dependencies.markFailed(
            claimed.id,
            "TRANSCRIPTION_RESPONSE_SCOPE_MISMATCH",
            "The transcription service returned an unexpected recording scope.",
          );
          result.failed += 1;
          continue;
        }

        if (remote.status === "failed") {
          await dependencies.markFailed(
            claimed.id,
            "TRANSCRIPTION_REMOTE_JOB_FAILED",
            "The server already has an unsuccessful transcription job for these settings.",
          );
          result.failed += 1;
          continue;
        }

        if (remote.status === "cancelled") {
          await dependencies.markCancelled(
            claimed.id,
            "TRANSCRIPTION_REMOTE_JOB_CANCELLED",
            "The server transcription job was cancelled.",
          );
          result.cancelled += 1;
          continue;
        }

        await dependencies.markSubmitted(claimed.id, remote.jobId);
        result.submitted += 1;
      } catch (error) {
        const normalized = await dependencies.normalizeRemoteError(error);

        if (normalized.code === "TRANSCRIPTION_FEATURE_DISABLED") {
          await dependencies.deferOperation(
            claimed.id,
            deferAt(dependencies, 60_000),
            normalized.code,
            normalized.message,
          );
          result.deferred += 1;
          break;
        }

        if (normalized.code === "TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED") {
          await dependencies.deferOperation(
            claimed.id,
            deferAt(dependencies, 2_000),
            normalized.code,
            normalized.message,
          );
          result.deferred += 1;
          continue;
        }

        if (normalized.code === "TRANSCRIPTION_AUTHENTICATION_REQUIRED") {
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

        if (normalized.retryable && !reachedAttemptLimit(claimed, dependencies)) {
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
    run: (): Promise<TranscriptionRequestSyncRunResult> => {
      if (activeRun) return activeRun;
      const run = execute()
        .then((result) => {
          if (result.processed > 0) dependencies.notifyChanged();
          if (result.submitted > 0) notifyTranscriptionRequestSubmitted();
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

const defaultWorker = createTranscriptionRequestWorker();

export const runTranscriptionRequestWorker = (): Promise<TranscriptionRequestSyncRunResult> =>
  defaultWorker.run();

export const waitForTranscriptionRequestSyncIdle = (): Promise<void> =>
  defaultWorker.waitForIdle();

export const requestTranscriptionRequestSync = (): void => {
  void runTranscriptionRequestWorker().catch(() => {
    // Queue rows retain safe diagnostics. Background lifecycle sync must not
    // create unhandled promise rejections in the UI.
  });
};
