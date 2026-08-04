import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { uploadRetry } from "@/src/config/limits";
import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  claimSessionDeletion,
  deleteCompletedSessionDeletion,
  getNextEligibleSessionDeletion,
  hardDeleteLocalSessionData,
  listLocalFileUrisForSession,
  markSessionDeletionFailed,
  resetInProgressSessionDeletions,
  rescheduleSessionDeletion,
  updateSessionDeletionProgress,
  type SessionDeletionQueueRow,
  type SessionDeletionProgressUpdate,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import { deleteRemoteSessionCascade } from "@/src/services/supabase/session-deletion-repository";
import {
  listPrivateSessionAssetPaths,
  removePrivateSessionAssets,
} from "@/src/services/supabase/session-assets";
import { normalizeSessionSyncError } from "@/src/services/supabase/session-repository";
import { nextBackoffMs, shouldGiveUp } from "@/src/services/upload-queue/backoff";
import { useAuthStore } from "@/src/stores/auth-store";

import { notifyMetadataSyncChanges } from "./project-sync-events";

export interface SessionDeletionRunResult {
  state:
    | "completed"
    | "offline"
    | "authentication_required"
    | "web_skipped";
  processed: number;
  deleted: number;
  retried: number;
  failed: number;
}

export interface SessionDeletionWorkerDependencies {
  platform: string;
  getConnectionState: () => Promise<NetInfoState>;
  getAuthenticatedUserId: () => Promise<string | null>;
  resetInProgress: (userId: string) => Promise<number>;
  getNextOperation: (
    userId: string,
    now: string,
  ) => Promise<SessionDeletionQueueRow | null>;
  claimOperation: (id: string) => Promise<SessionDeletionQueueRow | null>;
  discoverStoragePaths: (input: {
    workspaceId: string;
    sessionId: string;
  }) => Promise<string[]>;
  removeStoragePaths: (paths: readonly string[]) => Promise<void>;
  deleteCloudSession: (input: {
    workspaceId: string;
    sessionId: string;
  }) => Promise<void>;
  discoverLocalFileUris: (sessionId: string) => Promise<string[]>;
  deleteLocalFiles: (
    uris: readonly string[],
    sessionId: string,
  ) => Promise<void>;
  hardDeleteLocalData: (sessionId: string) => Promise<void>;
  updateProgress: (
    id: string,
    patch: SessionDeletionProgressUpdate,
  ) => Promise<void>;
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

const uniqueStrings = (values: readonly string[]): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))];

const deleteLocalFiles = async (
  uris: readonly string[],
  sessionId: string,
): Promise<void> => {
  for (const uri of uniqueStrings(uris)) {
    if (!uri.startsWith("file://")) continue;
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }

  const documentDirectory = FileSystem.documentDirectory;
  if (documentDirectory) {
    await FileSystem.deleteAsync(
      `${documentDirectory}sessions/${sessionId}`,
      { idempotent: true },
    );
  }
};

const defaultDependencies = (): SessionDeletionWorkerDependencies => ({
  platform: Platform.OS,
  getConnectionState: () => NetInfo.fetch(),
  getAuthenticatedUserId: async () => {
    const storeUser = useAuthStore.getState().user?.id;
    if (storeUser) return storeUser;
    const client = getSupabase();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  },
  resetInProgress: resetInProgressSessionDeletions,
  getNextOperation: getNextEligibleSessionDeletion,
  claimOperation: claimSessionDeletion,
  discoverStoragePaths: ({ workspaceId, sessionId }) =>
    listPrivateSessionAssetPaths({ workspaceId, sessionId }),
  removeStoragePaths: (paths) => removePrivateSessionAssets({ paths }),
  deleteCloudSession: ({ workspaceId, sessionId }) =>
    deleteRemoteSessionCascade({ workspaceId, sessionId }),
  discoverLocalFileUris: listLocalFileUrisForSession,
  deleteLocalFiles,
  hardDeleteLocalData: hardDeleteLocalSessionData,
  updateProgress: updateSessionDeletionProgress,
  rescheduleOperation: rescheduleSessionDeletion,
  markOperationFailed: markSessionDeletionFailed,
  deleteCompletedOperation: deleteCompletedSessionDeletion,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 10,
  maxAttempts: uploadRetry.maxAttempts,
  notifyChanged: notifyMetadataSyncChanges,
});

const emptyResult = (
  state: SessionDeletionRunResult["state"],
): SessionDeletionRunResult => ({
  state,
  processed: 0,
  deleted: 0,
  retried: 0,
  failed: 0,
});

const isOnline = (state: NetInfoState): boolean =>
  state.isConnected !== false && state.isInternetReachable !== false;

const nextRetryAt = (
  dependencies: SessionDeletionWorkerDependencies,
  attempt: number,
): string =>
  new Date(
    dependencies.now().getTime() +
      nextBackoffMs(attempt, { random: dependencies.random }),
  ).toISOString();

interface NormalizedDeletionError {
  code: string;
  message: string;
  retryable: boolean;
}

const normalizeDeletionError = (
  error: unknown,
): NormalizedDeletionError => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "retryable" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  ) {
    return {
      code: (error as { code: string }).code,
      message:
        error instanceof Error
          ? error.message
          : "The session cleanup could not be completed.",
      retryable: (error as { retryable: boolean }).retryable,
    };
  }

  const normalized = normalizeSessionSyncError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
  };
};

export const createSessionDeletionWorker = (
  dependencies: SessionDeletionWorkerDependencies = defaultDependencies(),
) => {
  let running: Promise<SessionDeletionRunResult> | null = null;
  let recoveredUserId: string | null = null;

  const runOnce = async (): Promise<SessionDeletionRunResult> => {
    if (isAccountDeletionLocallyPending()) {
      return emptyResult("completed");
    }

    if (dependencies.platform === "web") {
      return emptyResult("web_skipped");
    }

    const connection = await dependencies.getConnectionState();
    if (!isOnline(connection)) return emptyResult("offline");

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
          "DELETE_USER_MISMATCH",
          "This cleanup belongs to another signed-in user.",
        );
        result.failed += 1;
        break;
      }

      try {
        let current = claimed;

        if (!current.storage_deleted) {
          const discovered = await dependencies.discoverStoragePaths({
            workspaceId: current.workspace_id,
            sessionId: current.session_id,
          });
          const paths = uniqueStrings([
            ...current.storage_paths,
            ...discovered,
          ]);
          await dependencies.removeStoragePaths(paths);
          await dependencies.updateProgress(current.id, {
            storage_paths: paths,
            storage_deleted: true,
            last_error_code: null,
            last_safe_error: null,
          });
          current = { ...current, storage_paths: paths, storage_deleted: true };
        }

        if (!current.cloud_metadata_deleted) {
          await dependencies.deleteCloudSession({
            workspaceId: current.workspace_id,
            sessionId: current.session_id,
          });
          await dependencies.updateProgress(current.id, {
            cloud_metadata_deleted: true,
            last_error_code: null,
            last_safe_error: null,
          });
          current = { ...current, cloud_metadata_deleted: true };
        }

        if (!current.local_files_deleted) {
          const discoveredLocalUris =
            await dependencies.discoverLocalFileUris(current.session_id);
          const localFileUris = uniqueStrings([
            ...current.local_file_uris,
            ...discoveredLocalUris,
          ]);
          await dependencies.deleteLocalFiles(
            localFileUris,
            current.session_id,
          );
          await dependencies.updateProgress(current.id, {
            local_file_uris: localFileUris,
            local_files_deleted: true,
            last_error_code: null,
            last_safe_error: null,
          });
        }

        await dependencies.hardDeleteLocalData(current.session_id);
        await dependencies.deleteCompletedOperation(current.id);
        result.deleted += 1;
        dependencies.notifyChanged();
      } catch (error) {
        const normalized = normalizeDeletionError(error);
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
          result.retried += 1;
        } else {
          await dependencies.markOperationFailed(
            claimed.id,
            normalized.code,
            normalized.message,
          );
          result.failed += 1;
        }
        dependencies.notifyChanged();

        if (normalized.code === "AUTHENTICATION_REQUIRED") {
          result.state = "authentication_required";
        }
        // Avoid repeatedly claiming the same failed job in a single run.
        break;
      }
    }

    return result;
  };

  return {
    run: (): Promise<SessionDeletionRunResult> => {
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

const worker = createSessionDeletionWorker();

export const runSessionDeletionSync = (): Promise<SessionDeletionRunResult> =>
  worker.run();

export const waitForSessionDeletionIdle = (): Promise<void> =>
  worker.waitForIdle();

export const requestSessionDeletionSync = (): void => {
  void worker.run().catch(() => {
    // Durable queue state and safe diagnostics are persisted by the worker.
  });
};
