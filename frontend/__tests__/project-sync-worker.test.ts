import {
  createProjectSyncWorker,
  type ProjectSyncWorkerDependencies,
} from "@/src/services/sync/project-sync-worker";
import { ProjectSyncError } from "@/src/services/supabase/project-repository";
import type {
  BookmarkRecord,
  MetadataQueueRow,
  NoteRecord,
  ProjectRecord,
  SessionRecord,
  TimelineEventRecord,
} from "@/src/services/sqlite/repository";

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
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};


const session: SessionRecord = {
  id: "55555555-5555-4555-8555-555555555555",
  workspace_id: project.workspace_id,
  project_id: project.id,
  created_by: project.created_by,
  title: "Session",
  session_type: "standard",
  status: "draft",
  started_at: null,
  stopped_at: null,
  total_recorded_duration_ms: 0,
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
  updated_at: "2026-07-27T10:00:00.000Z",
  deleted_at: null,
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

const queueRow: MetadataQueueRow = {
  id: "44444444-4444-4444-8444-444444444444",
  user_id: project.created_by,
  workspace_id: project.workspace_id,
  entity_type: "project",
  entity_id: project.id,
  operation: "UPSERT",
  parent_entity_type: null,
  parent_entity_id: null,
  priority: 100,
  queue_status: "pending",
  attempt_count: 0,
  next_retry_at: null,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: `upsert:project:${project.id}`,
  created_at: "2026-07-27T10:00:00.000Z",
  updated_at: "2026-07-27T10:00:00.000Z",
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
    getAuthenticatedUserId: jest.fn(async () => project.created_by),
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
    getLocalSession: jest.fn(async () => ({ ...session })),
    getLocalNote: jest.fn(async () => null),
    getLocalBookmark: jest.fn(async () => null),
    getLocalMediaAsset: jest.fn(async () => null),
    getLocalTimelineEvent: jest.fn(async () => null),
    updateProjectStatus: jest.fn(async () => undefined),
    updateSessionStatus: jest.fn(async () => undefined),
    updateNoteStatus: jest.fn(async () => undefined),
    updateBookmarkStatus: jest.fn(async () => undefined),
    updateTimelineStatus: jest.fn(async () => undefined),
    saveLocalProject: jest.fn(async () => undefined),
    saveLocalSession: jest.fn(async () => undefined),
    saveLocalNote: jest.fn(async (_record: NoteRecord) => undefined),
    saveLocalBookmark: jest.fn(async (_record: BookmarkRecord) => undefined),
    saveLocalTimelineEvent: jest.fn(
      async (_record: TimelineEventRecord) => undefined,
    ),
    upsertCloudProject: jest.fn(async () => ({
      ...project,
      local_sync_status: "synchronized",
      cloud_sync_status: "synchronized",
    })),
    upsertCloudSession: jest.fn(async () => ({ ...session })),
    upsertCloudNote: jest.fn(async (record: NoteRecord) => record),
    upsertCloudBookmark: jest.fn(async (record: BookmarkRecord) => record),
    upsertCloudTimelineEvent: jest.fn(
      async (record: TimelineEventRecord) => record,
    ),
    markOperationFailed: jest.fn(async () => undefined),
    rescheduleOperation: jest.fn(async () => undefined),
    deferOperation: jest.fn(async () => undefined),
    deleteCompletedOperation: jest.fn(async () => undefined),
    now: jest.fn(() => new Date("2026-07-27T10:00:00.000Z")),
    random: jest.fn(() => 0.5),
    maxOperationsPerRun: 10,
    maxAttempts: 8,
    notifyChanged: jest.fn(),
    ...overrides,
  };
};

describe("project sync worker", () => {
  it("does not emit a refresh loop when the device is offline", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async () => ({
        isConnected: false,
        isInternetReachable: false,
      })),
    });
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.state).toBe("offline");
    expect(result.processed).toBe(0);
    expect(dependencies.notifyChanged).not.toHaveBeenCalled();
  });

  it("uploads a pending project and removes the completed operation", async () => {
    const dependencies = makeDependencies();
    const worker = createProjectSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.upsertCloudProject).toHaveBeenCalledWith(project);
    expect(dependencies.deleteCompletedOperation).toHaveBeenCalledWith(queueRow.id);
    expect(dependencies.notifyChanged).toHaveBeenCalledTimes(1);
    expect(dependencies.saveLocalProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: project.id,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
      }),
    );
  });

  it("reschedules a retryable network failure", async () => {
    const dependencies = makeDependencies({
      upsertCloudProject: jest.fn(async () => {
        throw new ProjectSyncError(
          "NETWORK_UNAVAILABLE",
          "Network unavailable",
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
      "Network unavailable",
    );
    expect(dependencies.markOperationFailed).not.toHaveBeenCalled();
  });

  it("marks a permanent RLS failure without retrying", async () => {
    const dependencies = makeDependencies({
      upsertCloudProject: jest.fn(async () => {
        throw new ProjectSyncError(
          "REMOTE_ACCESS_DENIED",
          "Access denied",
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
      "Access denied",
    );
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
  });

  it("shares one active run between concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async () => {
        await gate;
        return { isConnected: true, isInternetReachable: true };
      }),
    });
    const worker = createProjectSyncWorker(dependencies);

    const first = worker.run();
    const second = worker.run();
    expect(first).toBe(second);
    release();
    await first;
  });
});
