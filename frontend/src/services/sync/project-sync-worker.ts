import NetInfo from "@react-native-community/netinfo";
import { Platform } from "react-native";

import {
  claimMetadataOperation,
  deferMetadataOperationForDependency,
  deleteCompletedMetadataOperation,
  getBookmark,
  getNextEligibleMetadataOperation,
  getNote,
  getProject,
  getSession,
  getTimelineEvent,
  markMetadataOperationFailed,
  resetInProgressMetadataOperations,
  rescheduleMetadataOperation,
  updateBookmarkSyncStatus,
  updateNoteSyncStatus,
  updateProjectSyncStatus,
  updateSessionSyncStatus,
  updateTimelineEventSyncStatus,
  upsertBookmark,
  upsertNote,
  upsertProject,
  upsertSession,
  upsertTimelineEvent,
  type BookmarkRecord,
  type ContentSyncStatusUpdate,
  type MetadataQueueRow,
  type NoteRecord,
  type ProjectRecord,
  type SessionRecord,
  type TimelineEventRecord,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  normalizeProjectSyncError,
  ProjectSyncError,
  upsertRemoteProject,
} from "@/src/services/supabase/project-repository";
import {
  upsertRemoteBookmark,
  upsertRemoteNote,
  upsertRemoteTimelineEvent,
} from "@/src/services/supabase/session-content-repository";
import { upsertRemoteSession } from "@/src/services/supabase/session-repository";
import { nextBackoffMs, shouldGiveUp } from "@/src/services/upload-queue/backoff";

import { notifyMetadataSyncChanges } from "./project-sync-events";

export interface MetadataSyncRunResult {
  state: "completed" | "offline" | "authentication_required" | "web_skipped";
  processed: number;
  synchronized: number;
  retried: number;
  deferred: number;
  failed: number;
}

// Backward-compatible public name retained for Project/Session Sync callers.
export type ProjectSyncRunResult = MetadataSyncRunResult;

interface ConnectionState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}

type ContentStatusUpdater = (
  id: string,
  patch: ContentSyncStatusUpdate,
) => Promise<void>;

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
  getLocalNote: (id: string) => Promise<NoteRecord | null>;
  getLocalBookmark: (id: string) => Promise<BookmarkRecord | null>;
  getLocalTimelineEvent: (id: string) => Promise<TimelineEventRecord | null>;
  updateProjectStatus: typeof updateProjectSyncStatus;
  updateSessionStatus: typeof updateSessionSyncStatus;
  updateNoteStatus: typeof updateNoteSyncStatus;
  updateBookmarkStatus: typeof updateBookmarkSyncStatus;
  updateTimelineStatus: typeof updateTimelineEventSyncStatus;
  saveLocalProject: typeof upsertProject;
  saveLocalSession: typeof upsertSession;
  saveLocalNote: typeof upsertNote;
  saveLocalBookmark: typeof upsertBookmark;
  saveLocalTimelineEvent: typeof upsertTimelineEvent;
  upsertCloudProject: (project: ProjectRecord) => Promise<ProjectRecord>;
  upsertCloudSession: (session: SessionRecord) => Promise<SessionRecord>;
  upsertCloudNote: (note: NoteRecord) => Promise<NoteRecord>;
  upsertCloudBookmark: (bookmark: BookmarkRecord) => Promise<BookmarkRecord>;
  upsertCloudTimelineEvent: (
    event: TimelineEventRecord,
  ) => Promise<TimelineEventRecord>;
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
  getLocalNote: getNote,
  getLocalBookmark: getBookmark,
  getLocalTimelineEvent: getTimelineEvent,
  updateProjectStatus: updateProjectSyncStatus,
  updateSessionStatus: updateSessionSyncStatus,
  updateNoteStatus: updateNoteSyncStatus,
  updateBookmarkStatus: updateBookmarkSyncStatus,
  updateTimelineStatus: updateTimelineEventSyncStatus,
  saveLocalProject: upsertProject,
  saveLocalSession: upsertSession,
  saveLocalNote: upsertNote,
  saveLocalBookmark: upsertBookmark,
  saveLocalTimelineEvent: upsertTimelineEvent,
  upsertCloudProject: upsertRemoteProject,
  upsertCloudSession: upsertRemoteSession,
  upsertCloudNote: upsertRemoteNote,
  upsertCloudBookmark: upsertRemoteBookmark,
  upsertCloudTimelineEvent: upsertRemoteTimelineEvent,
  markOperationFailed: markMetadataOperationFailed,
  rescheduleOperation: rescheduleMetadataOperation,
  deferOperation: deferMetadataOperationForDependency,
  deleteCompletedOperation: deleteCompletedMetadataOperation,
  now: () => new Date(),
  random: Math.random,
  maxOperationsPerRun: 75,
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

  const failOperation = async (
    claimed: MetadataQueueRow,
    result: MetadataSyncRunResult,
    updateStatus: ContentStatusUpdater | null,
    code: string,
    message: string,
  ): Promise<"continue"> => {
    await dependencies.markOperationFailed(claimed.id, code, message);
    if (updateStatus) {
      await updateStatus(claimed.entity_id, {
        local_sync_status: "failed",
        cloud_sync_status: "failed",
        last_sync_error_code: code,
        last_sync_error_message: message,
      });
    }
    result.failed += 1;
    return "continue";
  };

  const deferOperation = async (
    claimed: MetadataQueueRow,
    result: MetadataSyncRunResult,
    updateStatus: ContentStatusUpdater,
    code: string,
    message: string,
  ): Promise<"break"> => {
    await dependencies.deferOperation(
      claimed.id,
      parentRetryAt(dependencies),
      code,
      message,
    );
    await updateStatus(claimed.entity_id, {
      local_sync_status: "pending",
      cloud_sync_status: "pending",
      last_sync_error_code: code,
      last_sync_error_message: message,
    });
    result.deferred += 1;
    return "break";
  };

  const ensureSessionReady = async (
    sessionId: string,
    claimed: MetadataQueueRow,
    result: MetadataSyncRunResult,
    updateStatus: ContentStatusUpdater,
  ): Promise<"ready" | "continue" | "break"> => {
    const session = await dependencies.getLocalSession(sessionId);
    if (!session || session.deleted_at != null) {
      return failOperation(
        claimed,
        result,
        updateStatus,
        "LOCAL_PARENT_SESSION_NOT_FOUND",
        "The parent session is not available locally.",
      );
    }

    const synchronized =
      session.local_sync_status === "synchronized" &&
      session.cloud_sync_status === "synchronized";
    if (synchronized) return "ready";

    if (session.local_sync_status === "failed") {
      return failOperation(
        claimed,
        result,
        updateStatus,
        "PARENT_SESSION_SYNC_FAILED",
        "Synchronize the session before retrying this item.",
      );
    }

    return deferOperation(
      claimed,
      result,
      updateStatus,
      "PARENT_SESSION_PENDING",
      "Waiting for the session to synchronize first.",
    );
  };

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

  const processMutableContent = async <
    T extends NoteRecord | BookmarkRecord,
  >(
    claimed: MetadataQueueRow,
    result: MetadataSyncRunResult,
    options: {
      getLocal: (id: string) => Promise<T | null>;
      updateStatus: ContentStatusUpdater;
      saveLocal: (record: T) => Promise<void>;
      upsertCloud: (record: T) => Promise<T>;
    },
  ): Promise<"continue" | "break"> => {
    const record = await options.getLocal(claimed.entity_id);
    if (!record || record.deleted_at != null) {
      await dependencies.deleteCompletedOperation(claimed.id);
      if (!record) result.failed += 1;
      return "continue";
    }

    const parentState = await ensureSessionReady(
      record.session_id,
      claimed,
      result,
      options.updateStatus,
    );
    if (parentState !== "ready") return parentState;

    await options.updateStatus(record.id, {
      local_sync_status: "synchronizing",
      cloud_sync_status: "pending",
      last_sync_error_code: null,
      last_sync_error_message: null,
    });

    try {
      const remote = await options.upsertCloud(record);
      const latest = await options.getLocal(record.id);
      if (latest && latest.updated_at !== record.updated_at) {
        result.deferred += 1;
        return "continue";
      }

      await options.saveLocal({
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
        await options.updateStatus(record.id, {
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
      await options.updateStatus(record.id, {
        local_sync_status: "failed",
        cloud_sync_status: "failed",
        last_sync_error_code: normalized.code,
        last_sync_error_message: normalized.message,
      });
      result.failed += 1;
      return "continue";
    }
  };

  const ensureTimelineSourceReady = async (
    event: TimelineEventRecord,
    claimed: MetadataQueueRow,
    result: MetadataSyncRunResult,
  ): Promise<"ready" | "continue" | "break"> => {
    if (!event.source_entity_id || !event.source_entity_type) return "ready";

    if (event.source_entity_type === "note") {
      const note = await dependencies.getLocalNote(event.source_entity_id);
      if (!note) {
        return failOperation(
          claimed,
          result,
          dependencies.updateTimelineStatus,
          "LOCAL_SOURCE_NOTE_NOT_FOUND",
          "The timeline note is not available locally.",
        );
      }
      if (
        note.local_sync_status === "synchronized" &&
        note.cloud_sync_status === "synchronized"
      ) {
        return "ready";
      }
      if (note.local_sync_status === "failed") {
        return failOperation(
          claimed,
          result,
          dependencies.updateTimelineStatus,
          "SOURCE_NOTE_SYNC_FAILED",
          "Synchronize the note before retrying its timeline event.",
        );
      }
      return deferOperation(
        claimed,
        result,
        dependencies.updateTimelineStatus,
        "SOURCE_NOTE_PENDING",
        "Waiting for the note to synchronize first.",
      );
    }

    if (event.source_entity_type === "bookmark") {
      const bookmark = await dependencies.getLocalBookmark(
        event.source_entity_id,
      );
      if (!bookmark) {
        return failOperation(
          claimed,
          result,
          dependencies.updateTimelineStatus,
          "LOCAL_SOURCE_BOOKMARK_NOT_FOUND",
          "The timeline bookmark is not available locally.",
        );
      }
      if (
        bookmark.local_sync_status === "synchronized" &&
        bookmark.cloud_sync_status === "synchronized"
      ) {
        return "ready";
      }
      if (bookmark.local_sync_status === "failed") {
        return failOperation(
          claimed,
          result,
          dependencies.updateTimelineStatus,
          "SOURCE_BOOKMARK_SYNC_FAILED",
          "Synchronize the bookmark before retrying its timeline event.",
        );
      }
      return deferOperation(
        claimed,
        result,
        dependencies.updateTimelineStatus,
        "SOURCE_BOOKMARK_PENDING",
        "Waiting for the bookmark to synchronize first.",
      );
    }

    return "ready";
  };

  const processTimelineEvent = async (
    claimed: MetadataQueueRow,
    result: MetadataSyncRunResult,
  ): Promise<"continue" | "break"> => {
    const event = await dependencies.getLocalTimelineEvent(claimed.entity_id);
    if (!event) {
      await dependencies.deleteCompletedOperation(claimed.id);
      result.failed += 1;
      return "continue";
    }

    const sessionState = await ensureSessionReady(
      event.session_id,
      claimed,
      result,
      dependencies.updateTimelineStatus,
    );
    if (sessionState !== "ready") return sessionState;

    const sourceState = await ensureTimelineSourceReady(event, claimed, result);
    if (sourceState !== "ready") return sourceState;

    await dependencies.updateTimelineStatus(event.id, {
      local_sync_status: "synchronizing",
      cloud_sync_status: "pending",
      last_sync_error_code: null,
      last_sync_error_message: null,
    });

    try {
      const remote = await dependencies.upsertCloudTimelineEvent(event);
      await dependencies.saveLocalTimelineEvent({
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
        await dependencies.updateTimelineStatus(event.id, {
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
      await dependencies.updateTimelineStatus(event.id, {
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
      switch (claimed.entity_type) {
        case "project":
          action = await processProject(claimed, result);
          break;
        case "session":
          action = await processSession(claimed, result);
          break;
        case "note":
          action = await processMutableContent(claimed, result, {
            getLocal: dependencies.getLocalNote,
            updateStatus: dependencies.updateNoteStatus,
            saveLocal: dependencies.saveLocalNote,
            upsertCloud: dependencies.upsertCloudNote,
          });
          break;
        case "bookmark":
          action = await processMutableContent(claimed, result, {
            getLocal: dependencies.getLocalBookmark,
            updateStatus: dependencies.updateBookmarkStatus,
            saveLocal: dependencies.saveLocalBookmark,
            upsertCloud: dependencies.upsertCloudBookmark,
          });
          break;
        case "timeline_event":
          action = await processTimelineEvent(claimed, result);
          break;
        default:
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

// Backward-compatible type/function names retained for earlier callers/tests.
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
