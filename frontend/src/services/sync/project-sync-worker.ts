import NetInfo from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { nextBackoffMs, shouldGiveUp } from "@/src/services/upload-queue/backoff";
import {
  claimMetadataOperation,
  deferMetadataOperationForDependency,
  deleteCompletedMetadataOperation,
  getNextEligibleMetadataOperation,
  getProject,
  getSession,
  markMetadataOperationFailed,
  resetInProgressMetadataOperations,
  rescheduleMetadataOperation,
  updateProjectSyncStatus,
  updateSessionSyncStatus,
  upsertProject,
  upsertSession,
  type MetadataQueueRow,
  type ProjectRecord,
  type SessionRecord,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  normalizeProjectSyncError,
  ProjectSyncError,
  upsertRemoteProject,
} from "@/src/services/supabase/project-repository";
import { upsertRemoteSession } from "@/src/services/supabase/session-repository";

import { notifyMetadataSyncChanges } from "./project-sync-events";

export interface MetadataSyncRunResult {
  state: "completed" | "offline" | "authentication_required" | "web_skipped";
  processed: number;
  synchronized: number;
  retried: number;
  deferred: number;
  failed: number;
}

// Backward-compatible public name retained for the verified Project Sync v1
// integration. The worker now processes both project and session metadata.
export type ProjectSyncRunResult = MetadataSyncRunResult;

interface ConnectionState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}

export interface MetadataSyncWorkerDependencies {
  platform: string;
  getConnectionState: () => Promise<ConnectionState>;
  getAuthenticatedUserId: () => Promise<string | null>;
  resetInProgress: () => Promise<number>;
  getNextOperation: (
    nowIso: string,
    userId: string,
  ) => Promise<MetadataQueueRow | null>;
  claimOperation: (id: string) => Promise<MetadataQueueRow | null>;
  getLocalProject: (id: string) => Promise<ProjectRecord | null>;
  getLocalSession: (id: string) => Promise<SessionRecord | null>;
  updateProjectStatus: typeof updateProjectSyncStatus;
  updateSessionStatus: typeof updateSessionSyncStatus;
  saveLocalProject: typeof upsertProject;
  saveLocalSession: typeof upsertSession;
  upsertCloudProject: (project: ProjectRecord) => Promise<ProjectRecord>;
  upsertCloudSession: (session: SessionRecord) => Promise<SessionRecord>;
  markOperationFailed: typeof markMetadataOperationFailed;
  rescheduleOperation: typeof rescheduleMetadataOperation;
  deferOperation: typeof deferMetadataOperationForDependency;
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

const defaultDependencies: MetadataSyncWorkerDependencies = {
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
  getLocalSession: getSession,
  updateProjectStatus: updateProjectSyncStatus,
  updateSessionStatus: updateSessionSyncStatus,
  saveLocalProject: upsertProject,
  saveLocalSession: upsertSession,
  upsertCloudProject: upsertRemoteProject,
  upsertCloudSession: upsertRemoteSession,
  markOperationFailed: markMetadataOperationFailed,
  rescheduleOperation: rescheduleMetadataOperation,
  deferOperation: deferMetadataOperationForDependency,
  deleteCompletedOperation: deleteCompletedMetadataOperation,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 50,
  maxAttempts: 8,
  notifyChanged: notifyMetadataSyncChanges,
};

const isOffline = (state: ConnectionState): boolean =>
  state.isConnected === false || state.isInternetReachable === false;

const safeUnknownError = (error: unknown): ProjectSyncError =>
  normalizeProjectSyncError(error);

const nextRetryAt = (
  dependencies: MetadataSyncWorkerDependencies,
  attemptCount: number,
): string => {
  const delayMs = nextBackoffMs(attemptCount, {
    random: dependencies.random,
  });
  return new Date(dependencies.now().getTime() + delayMs).toISOString();
};

const parentRetryAt = (dependencies: MetadataSyncWorkerDependencies): string =>
  new Date(dependencies.now().getTime() + 2_000).toISOString();

export const createMetadataSyncWorker = (
  overrides: Partial<MetadataSyncWorkerDependencies> = {},
) => {
  const dependencies: MetadataSyncWorkerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  let activeRun: Promise<MetadataSyncRunResult> | null = null;

  const processProject = async (
    claimed: MetadataQueueRow,
    result: MetadataSyncRunResult,
  ): Promise<"continue" | "break"> => {
    const project = await dependencies.getLocalProject(claimed.entity_id);
    if (!project) {
      await dependencies.markOperationFailed(
        claimed.id,
        "LOCAL_PROJECT_NOT_FOUND",
        "The local project no longer exists.",
      );
      result.failed += 1;
      return "continue";
    }

    await dependencies.updateProjectStatus(project.id, {
      local_sync_status: "synchronizing",
      cloud_sync_status: "pending",
      last_sync_error_code: null,
      last_sync_error_message: null,
    });

    try {
      const remote = await dependencies.upsertCloudProject(project);
      const latest = await dependencies.getLocalProject(project.id);

      // A newer local edit requeued the same stable operation while the remote
      // request was in flight. Do not overwrite it or delete its pending row.
      if (latest && latest.updated_at !== project.updated_at) {
        result.deferred += 1;
        return "continue";
      }

      await dependencies.saveLocalProject({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: dependencies.now().toISOString(),
      });
      await dependencies.deleteCompletedOperation(claimed.id);
      result.synchronized += 1;
      return "continue";
    } catch (error) {
      const normalized = safeUnknownError(error);
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
        await dependencies.updateProjectStatus(project.id, {
          local_sync_status: "pending",
          cloud_sync_status: "failed",
          last_sync_error_code: normalized.code,
          last_sync_error_message: normalized.message,
        });
        result.retried += 1;
        return "break";
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
      return "continue";
    }
  };

  const processSession = async (
    claimed: MetadataQueueRow,
    result: MetadataSyncRunResult,
  ): Promise<"continue" | "break"> => {
    const session = await dependencies.getLocalSession(claimed.entity_id);
    if (!session || session.deleted_at != null) {
      await dependencies.deleteCompletedOperation(claimed.id);
      if (!session) result.failed += 1;
      return "continue";
    }

    if (session.project_id) {
      const parent = await dependencies.getLocalProject(session.project_id);
      if (!parent) {
        const code = "LOCAL_PARENT_PROJECT_NOT_FOUND";
        const message = "The session project is not available locally.";
        await dependencies.markOperationFailed(claimed.id, code, message);
        await dependencies.updateSessionStatus(session.id, {
          local_sync_status: "failed",
          cloud_sync_status: "failed",
          last_sync_error_code: code,
          last_sync_error_message: message,
        });
        result.failed += 1;
        return "continue";
      }

      const parentSynchronized =
        parent.local_sync_status === "synchronized" &&
        parent.cloud_sync_status === "synchronized";

      if (!parentSynchronized) {
        if (parent.local_sync_status === "failed") {
          const code = "PARENT_PROJECT_SYNC_FAILED";
          const message =
            "Synchronize the project before retrying this session.";
          await dependencies.markOperationFailed(claimed.id, code, message);
          await dependencies.updateSessionStatus(session.id, {
            local_sync_status: "failed",
            cloud_sync_status: "failed",
            last_sync_error_code: code,
            last_sync_error_message: message,
          });
          result.failed += 1;
          return "continue";
        }

        const code = "PARENT_PROJECT_PENDING";
        const message = "Waiting for the project to synchronize first.";
        await dependencies.deferOperation(
          claimed.id,
          parentRetryAt(dependencies),
          code,
          message,
        );
        await dependencies.updateSessionStatus(session.id, {
          local_sync_status: "pending",
          cloud_sync_status: "pending",
          last_sync_error_code: code,
          last_sync_error_message: message,
        });
        result.deferred += 1;
        return "break";
      }
    }

    await dependencies.updateSessionStatus(session.id, {
      local_sync_status: "synchronizing",
      cloud_sync_status: "pending",
      last_sync_error_code: null,
      last_sync_error_message: null,
    });

    try {
      const remote = await dependencies.upsertCloudSession(session);
      const latest = await dependencies.getLocalSession(session.id);

      if (latest && latest.updated_at !== session.updated_at) {
        result.deferred += 1;
        return "continue";
      }

      await dependencies.saveLocalSession({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: dependencies.now().toISOString(),
      });
      await dependencies.deleteCompletedOperation(claimed.id);
      result.synchronized += 1;
      return "continue";
    } catch (error) {
      const normalized = safeUnknownError(error);
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
        await dependencies.updateSessionStatus(session.id, {
          local_sync_status: "pending",
          cloud_sync_status: "failed",
          last_sync_error_code: normalized.code,
          last_sync_error_message: normalized.message,
        });
        result.retried += 1;
        return "break";
      }

      await dependencies.markOperationFailed(
        claimed.id,
        normalized.code,
        normalized.message,
      );
      await dependencies.updateSessionStatus(session.id, {
        local_sync_status: "failed",
        cloud_sync_status: "failed",
        last_sync_error_code: normalized.code,
        last_sync_error_message: normalized.message,
      });
      result.failed += 1;
      return "continue";
    }
  };

  const execute = async (): Promise<MetadataSyncRunResult> => {
    const result: MetadataSyncRunResult = {
      state: "completed",
      processed: 0,
      synchronized: 0,
      retried: 0,
      deferred: 0,
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
      const next = await dependencies.getNextOperation(
        dependencies.now().toISOString(),
        userId,
      );
      if (!next) break;

      const claimed = await dependencies.claimOperation(next.id);
      if (!claimed) continue;
      result.processed += 1;

      if (claimed.operation !== "UPSERT") {
        await dependencies.markOperationFailed(
          claimed.id,
          "UNSUPPORTED_METADATA_OPERATION",
          "This metadata operation is not supported yet.",
        );
        result.failed += 1;
        continue;
      }

      let action: "continue" | "break";
      if (claimed.entity_type === "project") {
        action = await processProject(claimed, result);
      } else if (claimed.entity_type === "session") {
        action = await processSession(claimed, result);
      } else {
        await dependencies.markOperationFailed(
          claimed.id,
          "UNSUPPORTED_METADATA_ENTITY",
          "This metadata entity is not supported yet.",
        );
        result.failed += 1;
        continue;
      }

      if (action === "break") break;
    }

    return result;
  };

  return {
    run: (): Promise<MetadataSyncRunResult> => {
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
  };
};


// Backward-compatible type/function names retained for Project Sync v1 callers
// and tests while the worker now processes multiple metadata entity types.
export type ProjectSyncWorkerDependencies = MetadataSyncWorkerDependencies;
export const createProjectSyncWorker = createMetadataSyncWorker;

const defaultWorker = createMetadataSyncWorker();

export const runMetadataSyncWorker = (): Promise<MetadataSyncRunResult> =>
  defaultWorker.run();

export const runProjectSyncWorker = runMetadataSyncWorker;

export const requestMetadataSync = (): void => {
  void runMetadataSyncWorker().catch(() => {
    // Entity/queue status contains the safe diagnostic. Background sync must
    // never create an unhandled rejection in the UI lifecycle.
  });
};

export const requestProjectSync = requestMetadataSync;
