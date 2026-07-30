import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { uploadRetry } from "@/src/config/limits";
import {
  claimUploadOperation,
  deleteCompletedUploadOperation,
  getNextEligibleUploadOperation,
  getPreference,
  getRecording,
  getSession,
  markUploadOperationFailed,
  resetInProgressUploadOperations,
  rescheduleUploadOperation,
  updateRecordingUploadStatus,
  upsertRecording,
  type RecordingRecord,
  type RecordingUploadStatusUpdate,
  type SessionRecord,
  type UploadQueueRow,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  normalizeRecordingSyncError,
  type RecordingSyncError,
  upsertRemoteRecording,
} from "@/src/services/supabase/recording-repository";
import {
  removePrivateSessionAssets,
  uploadPrivateSessionAsset,
} from "@/src/services/supabase/session-assets";
import { nextBackoffMs, shouldGiveUp } from "@/src/services/upload-queue/backoff";
import { useAuthStore } from "@/src/stores/auth-store";

import { notifyMetadataSyncChanges } from "./project-sync-events";

const WIFI_ONLY_KEY = "upload.wifiOnly";

export interface RecordingUploadRunResult {
  state:
    | "completed"
    | "offline"
    | "waiting_for_wifi"
    | "authentication_required"
    | "web_skipped";
  processed: number;
  synchronized: number;
  retried: number;
  deferred: number;
  failed: number;
  cancelled: number;
}

export interface RecordingUploadWorkerDependencies {
  platform: string;
  getConnectionState: () => Promise<NetInfoState>;
  getWifiOnly: () => Promise<boolean>;
  getAuthenticatedUserId: () => Promise<string | null>;
  resetInProgress: (userId: string) => Promise<number>;
  getNextOperation: (
    userId: string,
    now: string,
  ) => Promise<UploadQueueRow | null>;
  claimOperation: (id: string) => Promise<UploadQueueRow | null>;
  getLocalRecording: (id: string) => Promise<RecordingRecord | null>;
  getLocalSession: (id: string) => Promise<SessionRecord | null>;
  updateRecordingStatus: (
    id: string,
    patch: RecordingUploadStatusUpdate,
  ) => Promise<void>;
  saveLocalRecording: (recording: RecordingRecord) => Promise<void>;
  uploadAsset: (input: {
    path: string;
    fileUri: string;
    mimeType: string;
  }) => Promise<void>;
  removeUploadedAsset: (path: string) => Promise<void>;
  upsertCloudRecording: (
    recording: RecordingRecord,
  ) => Promise<RecordingRecord>;
  rescheduleOperation: (
    id: string,
    nextRetryAt: string,
    errorCode: string,
    safeError: string,
  ) => Promise<void>;
  markOperationFailed: (
    id: string,
    errorCode: string,
    safeError: string,
  ) => Promise<void>;
  deleteCompletedOperation: (id: string) => Promise<void>;
  now: () => Date;
  random: () => number;
  maxOperationsPerRun: number;
  maxAttempts: number;
  notifyChanged: () => void;
}

const defaultDependencies = (): RecordingUploadWorkerDependencies => ({
  platform: Platform.OS,
  getConnectionState: () => NetInfo.fetch(),
  getWifiOnly: () => getPreference<boolean>(WIFI_ONLY_KEY, true),
  getAuthenticatedUserId: async () => {
    const storeUser = useAuthStore.getState().user?.id;
    if (storeUser) return storeUser;
    const client = getSupabase();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  },
  resetInProgress: (userId) =>
    resetInProgressUploadOperations(userId, "recording"),
  getNextOperation: (userId, now) =>
    getNextEligibleUploadOperation(userId, now, "recording"),
  claimOperation: claimUploadOperation,
  getLocalRecording: getRecording,
  getLocalSession: getSession,
  updateRecordingStatus: updateRecordingUploadStatus,
  saveLocalRecording: upsertRecording,
  uploadAsset: (input) => uploadPrivateSessionAsset(input),
  removeUploadedAsset: (path) =>
    removePrivateSessionAssets({ paths: [path] }),
  upsertCloudRecording: (recording) => upsertRemoteRecording(recording),
  rescheduleOperation: rescheduleUploadOperation,
  markOperationFailed: markUploadOperationFailed,
  deleteCompletedOperation: deleteCompletedUploadOperation,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 20,
  maxAttempts: uploadRetry.maxAttempts,
  notifyChanged: notifyMetadataSyncChanges,
});

const emptyResult = (
  state: RecordingUploadRunResult["state"],
): RecordingUploadRunResult => ({
  state,
  processed: 0,
  synchronized: 0,
  retried: 0,
  deferred: 0,
  failed: 0,
  cancelled: 0,
});

const isOnline = (state: NetInfoState): boolean =>
  state.isConnected !== false && state.isInternetReachable !== false;

const isWifi = (state: NetInfoState): boolean => state.type === "wifi";

const nextRetryAt = (
  dependencies: RecordingUploadWorkerDependencies,
  attempt: number,
): string =>
  new Date(
    dependencies.now().getTime() +
      nextBackoffMs(attempt, { random: dependencies.random }),
  ).toISOString();

const dependencyRetryAt = (
  dependencies: RecordingUploadWorkerDependencies,
): string => new Date(dependencies.now().getTime() + 2_000).toISOString();

const normalizeUnknown = (error: unknown): RecordingSyncError =>
  normalizeRecordingSyncError(error);

export const createRecordingUploadWorker = (
  dependencies: RecordingUploadWorkerDependencies = defaultDependencies(),
) => {
  let running: Promise<RecordingUploadRunResult> | null = null;
  let recoveredUserId: string | null = null;

  const runOnce = async (): Promise<RecordingUploadRunResult> => {
    if (dependencies.platform === "web") {
      return emptyResult("web_skipped");
    }

    const connection = await dependencies.getConnectionState();
    if (!isOnline(connection)) return emptyResult("offline");

    if ((await dependencies.getWifiOnly()) && !isWifi(connection)) {
      return emptyResult("waiting_for_wifi");
    }

    const userId = await dependencies.getAuthenticatedUserId();
    if (!userId) return emptyResult("authentication_required");

    if (recoveredUserId !== userId) {
      await dependencies.resetInProgress(userId);
      recoveredUserId = userId;
    }

    const result = emptyResult("completed");

    for (
      let index = 0;
      index < dependencies.maxOperationsPerRun;
      index += 1
    ) {
      const next = await dependencies.getNextOperation(
        userId,
        dependencies.now().toISOString(),
      );
      if (!next) break;

      const claimed = await dependencies.claimOperation(next.id);
      if (!claimed) continue;
      result.processed += 1;

      if (claimed.user_id !== userId) {
        const code = "UPLOAD_USER_MISMATCH";
        const message = "This upload belongs to another signed-in user.";
        await dependencies.markOperationFailed(claimed.id, code, message);
        result.failed += 1;
        continue;
      }

      if (claimed.source_entity_type !== "recording") {
        const code = "UPLOAD_ENTITY_UNSUPPORTED";
        const message = "This upload type is not supported by the recording worker.";
        await dependencies.markOperationFailed(claimed.id, code, message);
        result.failed += 1;
        continue;
      }

      const recording = await dependencies.getLocalRecording(
        claimed.source_entity_id,
      );
      if (!recording) {
        await dependencies.deleteCompletedOperation(claimed.id);
        result.failed += 1;
        continue;
      }

      const session = await dependencies.getLocalSession(recording.session_id);
      if (!session || session.deleted_at != null) {
        try {
          await dependencies.removeUploadedAsset(claimed.target_storage_path);
          await dependencies.deleteCompletedOperation(claimed.id);
          await dependencies.updateRecordingStatus(recording.id, {
            upload_status: "cancelled",
            upload_error_code: "SESSION_DELETION_PENDING",
            upload_error_message:
              "Upload cancelled because the session is being deleted.",
          });
          result.cancelled += 1;
          dependencies.notifyChanged();
        } catch (error) {
          const normalized = normalizeUnknown(error);
          if (normalized.retryable) {
            await dependencies.rescheduleOperation(
              claimed.id,
              nextRetryAt(dependencies, claimed.attempt_count),
              normalized.code,
              normalized.message,
            );
            result.retried += 1;
            break;
          }
          await dependencies.markOperationFailed(
            claimed.id,
            normalized.code,
            normalized.message,
          );
          result.failed += 1;
        }
        continue;
      }

      const sessionReady =
        session.local_sync_status === "synchronized" &&
        session.cloud_sync_status === "synchronized";
      if (!sessionReady) {
        if (session.local_sync_status === "failed") {
          const code = "PARENT_SESSION_SYNC_FAILED";
          const message = "Synchronize the session before retrying this recording.";
          await dependencies.markOperationFailed(claimed.id, code, message);
          await dependencies.updateRecordingStatus(recording.id, {
            upload_status: "failed",
            upload_error_code: code,
            upload_error_message: message,
          });
          result.failed += 1;
          continue;
        }

        const code = "PARENT_SESSION_PENDING";
        const message = "Waiting for the session to synchronize first.";
        await dependencies.rescheduleOperation(
          claimed.id,
          dependencyRetryAt(dependencies),
          code,
          message,
        );
        await dependencies.updateRecordingStatus(recording.id, {
          upload_status: "pending",
          upload_error_code: code,
          upload_error_message: message,
        });
        result.deferred += 1;
        break;
      }

      if (!recording.local_file_uri) {
        const code = "LOCAL_FILE_MISSING";
        const message = "The local recording file is no longer available.";
        await dependencies.markOperationFailed(claimed.id, code, message);
        await dependencies.updateRecordingStatus(recording.id, {
          upload_status: "failed",
          upload_error_code: code,
          upload_error_message: message,
        });
        result.failed += 1;
        continue;
      }

      await dependencies.updateRecordingStatus(recording.id, {
        upload_status: "uploading",
        upload_error_code: null,
        upload_error_message: null,
      });
      dependencies.notifyChanged();

      try {
        await dependencies.uploadAsset({
          path: claimed.target_storage_path,
          fileUri: recording.local_file_uri,
          mimeType: recording.mime_type,
        });

        const latestSession = await dependencies.getLocalSession(
          recording.session_id,
        );
        if (!latestSession || latestSession.deleted_at != null) {
          await dependencies.removeUploadedAsset(
            claimed.target_storage_path,
          );
          await dependencies.deleteCompletedOperation(claimed.id);
          await dependencies.updateRecordingStatus(recording.id, {
            upload_status: "cancelled",
            upload_error_code: "SESSION_DELETION_PENDING",
            upload_error_message:
              "Upload cancelled because the session is being deleted.",
          });
          result.cancelled += 1;
          dependencies.notifyChanged();
          continue;
        }

        const cloudInput: RecordingRecord = {
          ...recording,
          private_storage_path: claimed.target_storage_path,
          upload_status: "synchronized",
          upload_error_code: null,
          upload_error_message: null,
          updated_at: dependencies.now().toISOString(),
        };
        const remote = await dependencies.upsertCloudRecording(cloudInput);

        await dependencies.saveLocalRecording({
          ...remote,
          local_file_uri: recording.local_file_uri,
          private_storage_path: claimed.target_storage_path,
          upload_status: "synchronized",
          upload_error_code: null,
          upload_error_message: null,
        });
        await dependencies.deleteCompletedOperation(claimed.id);
        result.synchronized += 1;
        dependencies.notifyChanged();
      } catch (error) {
        const normalized = normalizeUnknown(error);
        const exhausted = shouldGiveUp(
          claimed.attempt_count,
          dependencies.maxAttempts,
        );

        if (normalized.retryable && !exhausted) {
          await dependencies.rescheduleOperation(
            claimed.id,
            nextRetryAt(dependencies, claimed.attempt_count),
            normalized.code,
            normalized.message,
          );
          await dependencies.updateRecordingStatus(recording.id, {
            upload_status: "pending",
            upload_error_code: normalized.code,
            upload_error_message: normalized.message,
          });
          result.retried += 1;
          dependencies.notifyChanged();
          break;
        }

        await dependencies.markOperationFailed(
          claimed.id,
          normalized.code,
          normalized.message,
        );
        await dependencies.updateRecordingStatus(recording.id, {
          upload_status: "failed",
          upload_error_code: normalized.code,
          upload_error_message: normalized.message,
        });
        result.failed += 1;
        dependencies.notifyChanged();

        if (normalized.code === "AUTHENTICATION_REQUIRED") {
          result.state = "authentication_required";
          break;
        }
      }
    }

    return result;
  };

  return {
    run: (): Promise<RecordingUploadRunResult> => {
      if (running) return running;

      const run = runOnce().finally(() => {
        running = null;
      });
      running = run;
      return run;
    },
  };
};

const worker = createRecordingUploadWorker();

export const requestRecordingUploadSync = (): void => {
  void worker.run().catch(() => {
    // Queue state and safe diagnostics are persisted by the worker.
  });
};
