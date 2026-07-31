import {
  createProjectSyncWorker,
  type ProjectSyncWorkerDependencies,
} from "@/src/services/sync/project-sync-worker";
import type {
  BookmarkRecord,
  MetadataQueueRow,
  NoteRecord,
  ProjectRecord,
  SessionRecord,
  SessionUserPreferenceRecord,
  TimelineEventRecord,
} from "@/src/services/sqlite/repository";
import { ProjectSyncError } from "@/src/services/supabase/project-repository";

const project: ProjectRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  name: "Project",
  description: null,
  status: "active",
  default_spoken_language_mode: null,
  default_expected_spoken_languages: [],
  default_summary_output_language: null,
  default_translation_target_language: null,
  created_by: "33333333-3333-4333-8333-333333333333",
  created_at: "2026-07-27T10:00:00.000Z",
  updated_at: "2026-07-27T10:00:00.000Z",
  deleted_at: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: "2026-07-27T10:00:01.000Z",
};

const session: SessionRecord = {
  id: "55555555-5555-4555-8555-555555555555",
  workspace_id: project.workspace_id,
  project_id: project.id,
  created_by: project.created_by,
  title: "Session",
  session_type: "standard",
  status: "recorded",
  started_at: "2026-07-27T10:00:00.000Z",
  stopped_at: "2026-07-27T10:05:00.000Z",
  total_recorded_duration_ms: 300000,
  spoken_language_mode: "AUTO_DETECT",
  expected_spoken_languages: [],
  detected_spoken_languages: [],
  primary_detected_language: null,
  language_detection_status: "NOT_STARTED",
  summary_output_language: null,
  translation_target_language: null,
  transcript_display_mode: "ORIGINAL",
  language_metadata: null,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  created_at: "2026-07-27T10:00:00.000Z",
  updated_at: "2026-07-27T10:05:00.000Z",
  deleted_at: null,
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

const sessionPreference: SessionUserPreferenceRecord = {
  id: `session-preference:${session.created_by}:${session.id}`,
  user_id: session.created_by,
  workspace_id: session.workspace_id,
  session_id: session.id,
  is_starred: true,
  created_at: session.created_at,
  updated_at: session.updated_at,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

const queueRow: MetadataQueueRow = {
  id: "66666666-6666-4666-8666-666666666666",
  user_id: session.created_by,
  workspace_id: session.workspace_id,
  entity_type: "session",
  entity_id: session.id,
  operation: "UPSERT",
  parent_entity_type: "project",
  parent_entity_id: project.id,
  priority: 200,
  queue_status: "pending",
  attempt_count: 0,
  next_retry_at: null,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: `upsert:session:${session.id}`,
  created_at: session.created_at,
  updated_at: session.updated_at,
};

const makeDependencies = (
  overrides: Partial<ProjectSyncWorkerDependencies> = {},
): ProjectSyncWorkerDependencies => {
  let returned = false;
  return {
    platform: "android",
    getConnectionState: jest.fn(async () => ({
      isConnected: true,
      isInternetReachable: true,
    })),
    getAuthenticatedUserId: jest.fn(async () => session.created_by),
    resetInProgress: jest.fn(async () => 0),
    getNextOperation: jest.fn(async () => {
      if (returned) return null;
      returned = true;
      return queueRow;
    }),
    claimOperation: jest.fn(
      async (_id: string): Promise<MetadataQueueRow | null> => ({
        ...queueRow,
        queue_status: "in_progress",
        attempt_count: 1,
      }),
    ),
    getLocalProject: jest.fn(async () => project),
    getLocalSession: jest.fn(async () => session),
    getLocalSessionPreference: jest.fn(async () => sessionPreference),
    getLocalNote: jest.fn(async () => null),
    getLocalBookmark: jest.fn(async () => null),
    getLocalMediaAsset: jest.fn(async () => null),
    getLocalTimelineEvent: jest.fn(async () => null),
    updateProjectStatus: jest.fn(async () => undefined),
    updateSessionStatus: jest.fn(async () => undefined),
    updateSessionPreferenceStatus: jest.fn(async () => undefined),
    updateNoteStatus: jest.fn(async () => undefined),
    updateBookmarkStatus: jest.fn(async () => undefined),
    updateTimelineStatus: jest.fn(async () => undefined),
    saveLocalProject: jest.fn(async () => undefined),
    saveLocalSession: jest.fn(async () => undefined),
    saveLocalSessionPreference: jest.fn(async () => undefined),
    saveLocalNote: jest.fn(async (_record: NoteRecord) => undefined),
    saveLocalBookmark: jest.fn(async (_record: BookmarkRecord) => undefined),
    saveLocalTimelineEvent: jest.fn(
      async (_record: TimelineEventRecord) => undefined,
    ),
    upsertCloudProject: jest.fn(async () => project),
    upsertCloudSession: jest.fn(async () => ({
      ...session,
      local_sync_status: "synchronized",
      cloud_sync_status: "synchronized",
    })),
    upsertCloudSessionPreference: jest.fn(async () => ({
      ...sessionPreference,
      local_sync_status: "synchronized",
      cloud_sync_status: "synchronized",
    })),
    upsertCloudNote: jest.fn(async (record: NoteRecord) => record),
    upsertCloudBookmark: jest.fn(async (record: BookmarkRecord) => record),
    upsertCloudTimelineEvent: jest.fn(
      async (record: TimelineEventRecord) => record,
    ),
    markOperationFailed: jest.fn(async () => undefined),
    rescheduleOperation: jest.fn(async () => undefined),
    deferOperation: jest.fn(async () => undefined),
    deleteCompletedOperation: jest.fn(async () => undefined),
    now: jest.fn(() => new Date("2026-07-27T10:06:00.000Z")),
    random: jest.fn(() => 0.5),
    maxOperationsPerRun: 10,
    maxAttempts: 8,
    notifyChanged: jest.fn(),
    ...overrides,
  };
};

describe("session metadata sync", () => {
  it("synchronizes a session after its project is synchronized", async () => {
    const dependencies = makeDependencies();
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.upsertCloudSession).toHaveBeenCalledWith(session);
    expect(dependencies.deleteCompletedOperation).toHaveBeenCalledWith(queueRow.id);
    expect(dependencies.saveLocalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
      }),
    );
  });

  it("supports sessions that are not assigned to a project", async () => {
    const withoutProject = { ...session, project_id: null };
    const dependencies = makeDependencies({
      getLocalSession: jest.fn(async () => withoutProject),
    });
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.getLocalProject).not.toHaveBeenCalled();
    expect(dependencies.upsertCloudSession).toHaveBeenCalledWith(withoutProject);
  });

  it("defers without consuming retry budget while the project is pending", async () => {
    const pendingProject = {
      ...project,
      local_sync_status: "pending",
      cloud_sync_status: "pending",
    };
    const dependencies = makeDependencies({
      getLocalProject: jest.fn(async () => pendingProject),
    });
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.deferred).toBe(1);
    expect(dependencies.deferOperation).toHaveBeenCalledWith(
      queueRow.id,
      expect.any(String),
      "PARENT_PROJECT_PENDING",
      "Waiting for the project to synchronize first.",
    );
    expect(dependencies.upsertCloudSession).not.toHaveBeenCalled();
  });

  it("marks the session failed when its parent project failed", async () => {
    const failedProject = {
      ...project,
      local_sync_status: "failed",
      cloud_sync_status: "failed",
    };
    const dependencies = makeDependencies({
      getLocalProject: jest.fn(async () => failedProject),
    });
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.failed).toBe(1);
    expect(dependencies.markOperationFailed).toHaveBeenCalledWith(
      queueRow.id,
      "PARENT_PROJECT_SYNC_FAILED",
      "Synchronize the project before retrying this session.",
    );
    expect(dependencies.upsertCloudSession).not.toHaveBeenCalled();
  });


  it("marks a session failed when its parent project is missing locally", async () => {
    const dependencies = makeDependencies({
      getLocalProject: jest.fn(async () => null),
    });
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.failed).toBe(1);
    expect(dependencies.markOperationFailed).toHaveBeenCalledWith(
      queueRow.id,
      "LOCAL_PARENT_PROJECT_NOT_FOUND",
      "The session project is not available locally.",
    );
    expect(dependencies.upsertCloudSession).not.toHaveBeenCalled();
  });

  it("reschedules a retryable session network failure", async () => {
    const dependencies = makeDependencies({
      upsertCloudSession: jest.fn(async () => {
        throw new ProjectSyncError(
          "NETWORK_UNAVAILABLE",
          "The session is saved locally and will synchronize when the network is available.",
          { retryable: true },
        );
      }),
    });
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.retried).toBe(1);
    expect(dependencies.rescheduleOperation).toHaveBeenCalledWith(
      queueRow.id,
      expect.any(String),
      "NETWORK_UNAVAILABLE",
      "The session is saved locally and will synchronize when the network is available.",
    );
    expect(dependencies.markOperationFailed).not.toHaveBeenCalled();
    expect(dependencies.updateSessionStatus).toHaveBeenLastCalledWith(
      session.id,
      expect.objectContaining({
        local_sync_status: "pending",
        cloud_sync_status: "failed",
      }),
    );
  });

  it("marks a permanent session RLS failure without retrying", async () => {
    const dependencies = makeDependencies({
      upsertCloudSession: jest.fn(async () => {
        throw new ProjectSyncError(
          "REMOTE_ACCESS_DENIED",
          "You do not have permission to synchronize this session.",
          { retryable: false, status: 403 },
        );
      }),
    });
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.failed).toBe(1);
    expect(dependencies.markOperationFailed).toHaveBeenCalledWith(
      queueRow.id,
      "REMOTE_ACCESS_DENIED",
      "You do not have permission to synchronize this session.",
    );
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
    expect(dependencies.updateSessionStatus).toHaveBeenLastCalledWith(
      session.id,
      expect.objectContaining({
        local_sync_status: "failed",
        cloud_sync_status: "failed",
      }),
    );
  });

  it("does not overwrite a newer local session update", async () => {
    const newer = {
      ...session,
      status: "recorded",
      updated_at: "2026-07-27T10:05:30.000Z",
    };
    let readCount = 0;
    const dependencies = makeDependencies({
      getLocalSession: jest.fn(async () => {
        readCount += 1;
        return readCount === 1 ? session : newer;
      }),
    });
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.deferred).toBe(1);
    expect(dependencies.saveLocalSession).not.toHaveBeenCalled();
    expect(dependencies.deleteCompletedOperation).not.toHaveBeenCalled();
  });
});
