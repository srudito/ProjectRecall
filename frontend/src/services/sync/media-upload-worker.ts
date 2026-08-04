import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { uploadRetry } from "@/src/config/limits";
import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  claimUploadOperation,
  deleteCompletedUploadOperation,
  getMediaAsset,
  getNextEligibleUploadOperation,
  getPreference,
  getSession,
  markUploadOperationFailed,
  resetInProgressUploadOperations,
  rescheduleUploadOperation,
  updateMediaAssetUploadStatus,
  upsertMediaAsset,
  type MediaAssetRecord,
  type SessionRecord,
  type UploadQueueRow,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  normalizeMediaAssetSyncError,
  type MediaAssetSyncError,
  upsertRemoteMediaAsset,
} from "@/src/services/supabase/media-asset-repository";
import {
  removePrivateSessionAssets,
  uploadPrivateSessionAsset,
} from "@/src/services/supabase/session-assets";
import { nextBackoffMs, shouldGiveUp } from "@/src/services/upload-queue/backoff";
import { useAuthStore } from "@/src/stores/auth-store";

import { notifyMetadataSyncChanges } from "./project-sync-events";
import { requestMetadataSync } from "./project-sync-worker";

const WIFI_ONLY_KEY = "upload.wifiOnly";

export interface MediaUploadRunResult {
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

export interface MediaUploadWorkerDependencies {
  platform: string;
  getConnectionState: () => Promise<NetInfoState>;
  getWifiOnly: () => Promise<boolean>;
  getAuthenticatedUserId: () => Promise<string | null>;
  resetInProgress: (userId: string) => Promise<number>;
  getNextOperation: (
    userId: string,
    nowIso: string,
  ) => Promise<UploadQueueRow | null>;
  claimOperation: (id: string) => Promise<UploadQueueRow | null>;
  getLocalAsset: (id: string) => Promise<MediaAssetRecord | null>;
  getLocalSession: (id: string) => Promise<SessionRecord | null>;
  updateAssetStatus: typeof updateMediaAssetUploadStatus;
  saveLocalAsset: typeof upsertMediaAsset;
  uploadAsset: (input: {
    path: string;
    fileUri: string;
    mimeType: string;
  }) => Promise<void>;
  removeUploadedAsset: (path: string) => Promise<void>;
  upsertCloudAsset: (asset: MediaAssetRecord) => Promise<MediaAssetRecord>;
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
  requestMetadata: () => void;
}

const defaultDependencies = (): MediaUploadWorkerDependencies => ({
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
    resetInProgressUploadOperations(userId, "media_asset"),
  getNextOperation: (userId, now) =>
    getNextEligibleUploadOperation(userId, now, "media_asset"),
  claimOperation: claimUploadOperation,
  getLocalAsset: getMediaAsset,
  getLocalSession: getSession,
  updateAssetStatus: updateMediaAssetUploadStatus,
  saveLocalAsset: upsertMediaAsset,
  uploadAsset: (input) => uploadPrivateSessionAsset(input),
  removeUploadedAsset: (path) =>
    removePrivateSessionAssets({ paths: [path] }),
  upsertCloudAsset: (asset) => upsertRemoteMediaAsset(asset),
  rescheduleOperation: rescheduleUploadOperation,
  markOperationFailed: markUploadOperationFailed,
  deleteCompletedOperation: deleteCompletedUploadOperation,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 20,
  maxAttempts: uploadRetry.maxAttempts,
  notifyChanged: notifyMetadataSyncChanges,
  requestMetadata: requestMetadataSync,
});

const emptyResult = (
  state: MediaUploadRunResult["state"],
): MediaUploadRunResult => ({
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
  dependencies: MediaUploadWorkerDependencies,
  attempt: number,
): string =>
  new Date(
    dependencies.now().getTime() +
      nextBackoffMs(attempt, { random: dependencies.random }),
  ).toISOString();

const dependencyRetryAt = (
  dependencies: MediaUploadWorkerDependencies,
): string => new Date(dependencies.now().getTime() + 2_000).toISOString();

const normalizeUnknown = (error: unknown): MediaAssetSyncError =>
  normalizeMediaAssetSyncError(error);

export const createMediaUploadWorker = (
  dependencies: MediaUploadWorkerDependencies = defaultDependencies(),
) => {
  let running: Promise<MediaUploadRunResult> | null = null;
  let recoveredUserId: string | null = null;

  const runOnce = async (): Promise<MediaUploadRunResult> => {
    if (isAccountDeletionLocallyPending()) {
      return emptyResult("completed");
    }

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
        await dependencies.markOperationFailed(
          claimed.id,
          "UPLOAD_USER_MISMATCH",
          "This evidence upload belongs to another signed-in user.",
        );
        result.failed += 1;
        continue;
      }

      if (claimed.source_entity_type !== "media_asset") {
        await dependencies.markOperationFailed(
          claimed.id,
          "UPLOAD_ENTITY_UNSUPPORTED",
          "This upload type is not supported by the evidence worker.",
        );
        result.failed += 1;
        continue;
      }

      const asset = await dependencies.getLocalAsset(claimed.source_entity_id);
      if (!asset || asset.deleted_at != null) {
        await dependencies.deleteCompletedOperation(claimed.id);
        if (!asset) result.failed += 1;
        continue;
      }

      const session = await dependencies.getLocalSession(asset.session_id);
      if (!session || session.deleted_at != null) {
        try {
          await dependencies.removeUploadedAsset(claimed.target_storage_path);
          await dependencies.deleteCompletedOperation(claimed.id);
          await dependencies.updateAssetStatus(asset.id, {
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
          const message =
            "Synchronize the session before retrying this evidence.";
          await dependencies.markOperationFailed(claimed.id, code, message);
          await dependencies.updateAssetStatus(asset.id, {
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
        await dependencies.updateAssetStatus(asset.id, {
          upload_status: "pending",
          upload_error_code: code,
          upload_error_message: message,
        });
        result.deferred += 1;
        break;
      }

      if (!asset.local_file_uri) {
        const code = "LOCAL_FILE_MISSING";
        const message = "The local evidence file is no longer available.";
        await dependencies.markOperationFailed(claimed.id, code, message);
        await dependencies.updateAssetStatus(asset.id, {
          upload_status: "failed",
          upload_error_code: code,
          upload_error_message: message,
        });
        result.failed += 1;
        continue;
      }

      await dependencies.updateAssetStatus(asset.id, {
        upload_status: "uploading",
        upload_error_code: null,
        upload_error_message: null,
      });
      dependencies.notifyChanged();

      try {
        await dependencies.uploadAsset({
          path: claimed.target_storage_path,
          fileUri: asset.local_file_uri,
          mimeType: asset.mime_type,
        });

        const latestSession = await dependencies.getLocalSession(
          asset.session_id,
        );
        if (!latestSession || latestSession.deleted_at != null) {
          await dependencies.removeUploadedAsset(
            claimed.target_storage_path,
          );
          await dependencies.deleteCompletedOperation(claimed.id);
          await dependencies.updateAssetStatus(asset.id, {
            upload_status: "cancelled",
            upload_error_code: "SESSION_DELETION_PENDING",
            upload_error_message:
              "Upload cancelled because the session is being deleted.",
          });
          result.cancelled += 1;
          dependencies.notifyChanged();
          continue;
        }

        const cloudInput: MediaAssetRecord = {
          ...asset,
          private_storage_path: claimed.target_storage_path,
          upload_status: "synchronized",
          upload_error_code: null,
          upload_error_message: null,
          updated_at: dependencies.now().toISOString(),
        };
        const remote = await dependencies.upsertCloudAsset(cloudInput);

        await dependencies.saveLocalAsset({
          ...remote,
          local_file_uri: asset.local_file_uri,
          private_storage_path: claimed.target_storage_path,
          upload_status: "synchronized",
          upload_error_code: null,
          upload_error_message: null,
        });
        await dependencies.deleteCompletedOperation(claimed.id);
        result.synchronized += 1;
        dependencies.notifyChanged();
        dependencies.requestMetadata();
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
          await dependencies.updateAssetStatus(asset.id, {
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
        await dependencies.updateAssetStatus(asset.id, {
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
    run: (): Promise<MediaUploadRunResult> => {
      if (running) return running;

      const run = runOnce().finally(() => {
        running = null;
      });
      running = run;
      return run;
    },
    waitForIdle: async (): Promise<void> => {
      const run = running;
      if (!run) return;
      await run.then(() => undefined, () => undefined);
    },
  };
};

const worker = createMediaUploadWorker();

export const waitForMediaUploadIdle = (): Promise<void> =>
  worker.waitForIdle();

export const requestMediaUploadSync = (): void => {
  void worker.run().catch(() => {
    // Queue state and safe diagnostics are persisted by the worker.
  });
};
