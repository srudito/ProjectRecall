import NetInfo from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { nextBackoffMs, shouldGiveUp } from "@/src/services/upload-queue/backoff";
import {
  claimMetadataOperation,
  deleteCompletedMetadataOperation,
  getNextEligibleMetadataOperation,
  getProject,
  markMetadataOperationFailed,
  resetInProgressMetadataOperations,
  rescheduleMetadataOperation,
  updateProjectSyncStatus,
  upsertProject,
  type MetadataQueueRow,
  type ProjectRecord,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  normalizeProjectSyncError,
  ProjectSyncError,
  upsertRemoteProject,
} from "@/src/services/supabase/project-repository";

import { notifyProjectSyncChanges } from "./project-sync-events";

export interface ProjectSyncRunResult {
  state: "completed" | "offline" | "authentication_required" | "web_skipped";
  processed: number;
  synchronized: number;
  retried: number;
  failed: number;
}

interface ConnectionState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}

export interface ProjectSyncWorkerDependencies {
  platform: string;
  getConnectionState: () => Promise<ConnectionState>;
  getAuthenticatedUserId: () => Promise<string | null>;
  resetInProgress: () => Promise<number>;
  getNextOperation: (nowIso: string, userId: string) => Promise<MetadataQueueRow | null>;
  claimOperation: (id: string) => Promise<MetadataQueueRow | null>;
  getLocalProject: (id: string) => Promise<ProjectRecord | null>;
  updateProjectStatus: typeof updateProjectSyncStatus;
  saveLocalProject: typeof upsertProject;
  upsertCloudProject: (project: ProjectRecord) => Promise<ProjectRecord>;
  markOperationFailed: typeof markMetadataOperationFailed;
  rescheduleOperation: typeof rescheduleMetadataOperation;
  deleteCompletedOperation: typeof deleteCompletedMetadataOperation;
  now: () => Date;
  random: () => number;
  maxOperationsPerRun: number;
  maxAttempts: number;
  notifyChanged: () => void;
}

const getDefaultAuthenticatedUserId = async (): Promise<string | null> => {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw normalizeProjectSyncError(error, 401);
  return data.session?.user.id ?? null;
};

const defaultDependencies: ProjectSyncWorkerDependencies = {
  platform: Platform.OS,
  getConnectionState: async () => {
    const state = await NetInfo.fetch();
    return {
      isConnected: state.isConnected,
      isInternetReachable: state.isInternetReachable,
    };
  },
  getAuthenticatedUserId: getDefaultAuthenticatedUserId,
  resetInProgress: resetInProgressMetadataOperations,
  getNextOperation: getNextEligibleMetadataOperation,
  claimOperation: claimMetadataOperation,
  getLocalProject: getProject,
  updateProjectStatus: updateProjectSyncStatus,
  saveLocalProject: upsertProject,
  upsertCloudProject: upsertRemoteProject,
  markOperationFailed: markMetadataOperationFailed,
  rescheduleOperation: rescheduleMetadataOperation,
  deleteCompletedOperation: deleteCompletedMetadataOperation,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 50,
  maxAttempts: 8,
  notifyChanged: notifyProjectSyncChanges,
};

const isOffline = (state: ConnectionState): boolean =>
  state.isConnected === false || state.isInternetReachable === false;

const safeUnknownError = (error: unknown): ProjectSyncError =>
  normalizeProjectSyncError(error);

export const createProjectSyncWorker = (
  overrides: Partial<ProjectSyncWorkerDependencies> = {},
) => {
  const dependencies: ProjectSyncWorkerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  let activeRun: Promise<ProjectSyncRunResult> | null = null;

  const execute = async (): Promise<ProjectSyncRunResult> => {
    const result: ProjectSyncRunResult = {
      state: "completed",
      processed: 0,
      synchronized: 0,
      retried: 0,
      failed: 0,
    };

    if (dependencies.platform === "web") {
      return { ...result, state: "web_skipped" };
    }

    const connection = await dependencies.getConnectionState();
    if (isOffline(connection)) {
      return { ...result, state: "offline" };
    }

    let userId: string | null;
    try {
      userId = await dependencies.getAuthenticatedUserId();
    } catch (error) {
      const normalized = safeUnknownError(error);
      if (normalized.code === "AUTHENTICATION_REQUIRED") {
        return { ...result, state: "authentication_required" };
      }
      throw normalized;
    }

    if (!userId) {
      return { ...result, state: "authentication_required" };
    }

    await dependencies.resetInProgress();

    for (
      let index = 0;
      index < dependencies.maxOperationsPerRun;
      index += 1
    ) {
      const now = dependencies.now();
      const next = await dependencies.getNextOperation(now.toISOString(), userId);
      if (!next) break;

      const claimed = await dependencies.claimOperation(next.id);
      if (!claimed) continue;

      result.processed += 1;

      if (claimed.entity_type !== "project" || claimed.operation !== "UPSERT") {
        await dependencies.markOperationFailed(
          claimed.id,
          "UNSUPPORTED_METADATA_OPERATION",
          "This metadata operation is not supported by the project sync worker.",
        );
        result.failed += 1;
        continue;
      }

      const project = await dependencies.getLocalProject(claimed.entity_id);
      if (!project) {
        await dependencies.markOperationFailed(
          claimed.id,
          "LOCAL_PROJECT_NOT_FOUND",
          "The local project no longer exists.",
        );
        result.failed += 1;
        continue;
      }

      await dependencies.updateProjectStatus(project.id, {
        local_sync_status: "synchronizing",
        cloud_sync_status: "pending",
        last_sync_error_code: null,
        last_sync_error_message: null,
      });

      try {
        const remote = await dependencies.upsertCloudProject(project);
        const synchronizedAt = dependencies.now().toISOString();

        await dependencies.saveLocalProject({
          ...remote,
          local_sync_status: "synchronized",
          cloud_sync_status: "synchronized",
          last_sync_error_code: null,
          last_sync_error_message: null,
          last_synced_at: synchronizedAt,
        });
        await dependencies.deleteCompletedOperation(claimed.id);
        result.synchronized += 1;
      } catch (error) {
        const normalized = safeUnknownError(error);
        const exhausted = shouldGiveUp(
          claimed.attempt_count,
          dependencies.maxAttempts,
        );

        if (normalized.retryable && !exhausted) {
          const delayMs = nextBackoffMs(claimed.attempt_count, {
            random: dependencies.random,
          });
          const nextRetryAt = new Date(
            dependencies.now().getTime() + delayMs,
          ).toISOString();

          await dependencies.rescheduleOperation(
            claimed.id,
            nextRetryAt,
            normalized.code,
            normalized.message,
          );
          await dependencies.updateProjectStatus(project.id, {
            local_sync_status: "pending",
            cloud_sync_status: "failed",
            last_sync_error_code: normalized.code,
            last_sync_error_message: normalized.message,
          });
          result.retried += 1;

          // A transient network/auth/server problem will normally affect the
          // rest of the queue as well. Stop this run and wait for the next
          // app-active/network/auth trigger instead of hammering the service.
          break;
        }

        await dependencies.markOperationFailed(
          claimed.id,
          normalized.code,
          normalized.message,
        );
        await dependencies.updateProjectStatus(project.id, {
          local_sync_status: "failed",
          cloud_sync_status: "failed",
          last_sync_error_code: normalized.code,
          last_sync_error_message: normalized.message,
        });
        result.failed += 1;
      }
    }

    return result;
  };

  return {
    run: (): Promise<ProjectSyncRunResult> => {
      if (activeRun) return activeRun;
      activeRun = execute()
        .then((result) => {
          if (result.processed > 0) {
            dependencies.notifyChanged();
          }
          return result;
        })
        .finally(() => {
          activeRun = null;
        });
      return activeRun;
    },
  };
};

const defaultWorker = createProjectSyncWorker();

export const runProjectSyncWorker = (): Promise<ProjectSyncRunResult> =>
  defaultWorker.run();

export const requestProjectSync = (): void => {
  void runProjectSyncWorker().catch(() => {
    // Queue/project status contains the safe diagnostic. Do not let a
    // background synchronization attempt create an unhandled rejection.
  });
};
