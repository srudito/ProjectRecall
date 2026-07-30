import type {
  BookmarkRecord,
  MediaAssetRecord,
  MetadataQueueRow,
  NoteRecord,
  ProjectRecord,
  SessionRecord,
  TimelineEventRecord,
} from "@/src/services/sqlite/repository";
import { ProjectSyncError } from "@/src/services/supabase/project-repository";
import {
  createMetadataSyncWorker,
  type MetadataSyncWorkerDependencies,
} from "@/src/services/sync/project-sync-worker";

const userId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "55555555-5555-4555-8555-555555555555";

const session: SessionRecord = {
  id: sessionId,
  workspace_id: workspaceId,
  project_id: null,
  created_by: userId,
  title: "Session",
  session_type: "standard",
  status: "recorded",
  started_at: "2026-07-28T10:00:00.000Z",
  stopped_at: "2026-07-28T10:01:00.000Z",
  total_recorded_duration_ms: 60000,
  spoken_language_mode: "AUTO_DETECT",
  expected_spoken_languages: [],
  detected_spoken_languages: [],
  primary_detected_language: null,
  language_detection_status: "NOT_STARTED",
  summary_output_language: null,
  translation_target_language: null,
  transcript_display_mode: "ORIGINAL",
  language_metadata: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  created_at: "2026-07-28T10:00:00.000Z",
  updated_at: "2026-07-28T10:01:00.000Z",
  deleted_at: null,
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: "2026-07-28T10:01:01.000Z",
};

const note: NoteRecord = {
  id: "66666666-6666-4666-8666-666666666666",
  workspace_id: workspaceId,
  project_id: null,
  session_id: sessionId,
  text: "Inspect the bearing",
  recording_offset_ms: 12000,
  created_by: userId,
  created_at: "2026-07-28T10:00:12.000Z",
  updated_at: "2026-07-28T10:00:12.000Z",
  deleted_at: null,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

const bookmark: BookmarkRecord = {
  id: "77777777-7777-4777-8777-777777777777",
  workspace_id: workspaceId,
  project_id: null,
  session_id: sessionId,
  label: "Important",
  recording_offset_ms: 15000,
  created_by: userId,
  created_at: "2026-07-28T10:00:15.000Z",
  updated_at: "2026-07-28T10:00:15.000Z",
  deleted_at: null,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

const timelineEvent: TimelineEventRecord = {
  id: "88888888-8888-4888-8888-888888888888",
  workspace_id: workspaceId,
  project_id: null,
  session_id: sessionId,
  event_type: "note_added",
  source_entity_type: "note",
  source_entity_id: note.id,
  recording_offset_ms: note.recording_offset_ms,
  created_by: userId,
  created_at: note.created_at,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

const mediaAsset: MediaAssetRecord = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspace_id: workspaceId,
  project_id: null,
  session_id: sessionId,
  added_by: userId,
  asset_type: "image",
  mime_type: "image/jpeg",
  original_file_name: "pump.jpg",
  sanitized_file_name: "pump.jpg",
  local_file_uri: "file:///documents/pump.jpg",
  private_storage_path:
    `${workspaceId}/${sessionId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pump.jpg`,
  file_size: 4096,
  duration_ms: null,
  image_width: 1600,
  image_height: 1200,
  page_count: null,
  captured_at: "2026-07-28T10:00:20.000Z",
  recording_offset_ms: 20000,
  user_caption: null,
  checksum_sha256: null,
  upload_status: "synchronized",
  upload_error_code: null,
  upload_error_message: null,
  created_at: "2026-07-28T10:00:20.000Z",
  updated_at: "2026-07-28T10:00:21.000Z",
  deleted_at: null,
};

const mediaTimelineEvent: TimelineEventRecord = {
  ...timelineEvent,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  event_type: "image_added",
  source_entity_type: "media_asset",
  source_entity_id: mediaAsset.id,
  recording_offset_ms: mediaAsset.recording_offset_ms,
  created_at: mediaAsset.captured_at ?? mediaAsset.created_at,
};

const project: ProjectRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: workspaceId,
  name: "Project",
  description: null,
  status: "active",
  default_spoken_language_mode: null,
  default_expected_spoken_languages: [],
  default_summary_output_language: null,
  default_translation_target_language: null,
  created_by: userId,
  created_at: "2026-07-28T09:00:00.000Z",
  updated_at: "2026-07-28T09:00:00.000Z",
  deleted_at: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: "2026-07-28T09:00:01.000Z",
};

const queueFor = (
  entityType: MetadataQueueRow["entity_type"],
  entityId: string,
): MetadataQueueRow => ({
  id: `99999999-9999-4999-8999-${entityId.slice(-12)}`,
  user_id: userId,
  workspace_id: workspaceId,
  entity_type: entityType,
  entity_id: entityId,
  operation: "UPSERT",
  parent_entity_type: "session",
  parent_entity_id: sessionId,
  priority: entityType === "timeline_event" ? 400 : 300,
  queue_status: "pending",
  attempt_count: 0,
  next_retry_at: null,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: `upsert:${entityType}:${entityId}`,
  created_at: "2026-07-28T10:00:00.000Z",
  updated_at: "2026-07-28T10:00:00.000Z",
});

const makeDependencies = (
  queueRow: MetadataQueueRow,
  overrides: Partial<MetadataSyncWorkerDependencies> = {},
): MetadataSyncWorkerDependencies => {
  let returned = false;
  return {
    platform: "android",
    getConnectionState: jest.fn(async () => ({
      isConnected: true,
      isInternetReachable: true,
    })),
    getAuthenticatedUserId: jest.fn(async () => userId),
    resetInProgress: jest.fn(async () => 0),
    getNextOperation: jest.fn(async () => {
      if (returned) return null;
      returned = true;
      return queueRow;
    }),
    claimOperation: jest.fn(
      async (): Promise<MetadataQueueRow> => ({
        ...queueRow,
        queue_status: "in_progress",
        attempt_count: 1,
      }),
    ),
    getLocalProject: jest.fn(async () => project),
    getLocalSession: jest.fn(async () => session),
    getLocalNote: jest.fn(async () => note),
    getLocalBookmark: jest.fn(async () => bookmark),
    getLocalMediaAsset: jest.fn(async () => null),
    getLocalTimelineEvent: jest.fn(async () => timelineEvent),
    updateProjectStatus: jest.fn(async () => undefined),
    updateSessionStatus: jest.fn(async () => undefined),
    updateNoteStatus: jest.fn(async () => undefined),
    updateBookmarkStatus: jest.fn(async () => undefined),
    updateTimelineStatus: jest.fn(async () => undefined),
    saveLocalProject: jest.fn(async () => undefined),
    saveLocalSession: jest.fn(async () => undefined),
    saveLocalNote: jest.fn(async () => undefined),
    saveLocalBookmark: jest.fn(async () => undefined),
    saveLocalTimelineEvent: jest.fn(async () => undefined),
    upsertCloudProject: jest.fn(async () => project),
    upsertCloudSession: jest.fn(async () => session),
    upsertCloudNote: jest.fn(async () => ({
      ...note,
      local_sync_status: "synchronized",
      cloud_sync_status: "synchronized",
    })),
    upsertCloudBookmark: jest.fn(async () => ({
      ...bookmark,
      local_sync_status: "synchronized",
      cloud_sync_status: "synchronized",
    })),
    upsertCloudTimelineEvent: jest.fn(async () => ({
      ...timelineEvent,
      local_sync_status: "synchronized",
      cloud_sync_status: "synchronized",
    })),
    markOperationFailed: jest.fn(async () => undefined),
    rescheduleOperation: jest.fn(async () => undefined),
    deferOperation: jest.fn(async () => undefined),
    deleteCompletedOperation: jest.fn(async () => undefined),
    now: jest.fn(() => new Date("2026-07-28T10:02:00.000Z")),
    random: jest.fn(() => 0.5),
    maxOperationsPerRun: 10,
    maxAttempts: 8,
    notifyChanged: jest.fn(),
    ...overrides,
  };
};

describe("note, bookmark, and timeline metadata sync", () => {
  it("synchronizes a note after its parent session", async () => {
    const row = queueFor("note", note.id);
    const dependencies = makeDependencies(row);
    const worker = createMetadataSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.upsertCloudNote).toHaveBeenCalledWith(note);
    expect(dependencies.saveLocalNote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: note.id,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
      }),
    );
    expect(dependencies.deleteCompletedOperation).toHaveBeenCalledWith(row.id);
  });

  it("defers a note while the parent session is pending", async () => {
    const row = queueFor("note", note.id);
    const dependencies = makeDependencies(row, {
      getLocalSession: jest.fn(async () => ({
        ...session,
        local_sync_status: "pending",
        cloud_sync_status: "pending",
      })),
    });
    const worker = createMetadataSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.deferred).toBe(1);
    expect(dependencies.deferOperation).toHaveBeenCalledWith(
      row.id,
      expect.any(String),
      "PARENT_SESSION_PENDING",
      expect.any(String),
    );
    expect(dependencies.upsertCloudNote).not.toHaveBeenCalled();
  });

  it("synchronizes a bookmark after the session", async () => {
    const row = queueFor("bookmark", bookmark.id);
    const dependencies = makeDependencies(row);
    const worker = createMetadataSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.upsertCloudBookmark).toHaveBeenCalledWith(bookmark);
  });

  it("defers a note timeline event until its source note is synchronized", async () => {
    const row = queueFor("timeline_event", timelineEvent.id);
    const dependencies = makeDependencies(row, {
      getLocalNote: jest.fn(async () => ({
        ...note,
        local_sync_status: "pending",
        cloud_sync_status: "pending",
      })),
    });
    const worker = createMetadataSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.deferred).toBe(1);
    expect(dependencies.deferOperation).toHaveBeenCalledWith(
      row.id,
      expect.any(String),
      "SOURCE_NOTE_PENDING",
      expect.any(String),
    );
    expect(dependencies.upsertCloudTimelineEvent).not.toHaveBeenCalled();
  });

  it("synchronizes a timeline event after its note source", async () => {
    const row = queueFor("timeline_event", timelineEvent.id);
    const dependencies = makeDependencies(row, {
      getLocalNote: jest.fn(async () => ({
        ...note,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
      })),
    });
    const worker = createMetadataSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.upsertCloudTimelineEvent).toHaveBeenCalledWith(
      timelineEvent,
    );
  });

  it("defers an evidence timeline event until its media upload is synchronized", async () => {
    const row = queueFor("timeline_event", mediaTimelineEvent.id);
    const dependencies = makeDependencies(row, {
      getLocalMediaAsset: jest.fn(async () => ({
        ...mediaAsset,
        upload_status: "pending",
      })),
      getLocalTimelineEvent: jest.fn(async () => mediaTimelineEvent),
    });
    const worker = createMetadataSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.deferred).toBe(1);
    expect(dependencies.deferOperation).toHaveBeenCalledWith(
      row.id,
      expect.any(String),
      "SOURCE_MEDIA_PENDING",
      expect.any(String),
    );
    expect(dependencies.upsertCloudTimelineEvent).not.toHaveBeenCalled();
  });

  it("synchronizes an evidence timeline event after its media upload", async () => {
    const row = queueFor("timeline_event", mediaTimelineEvent.id);
    const dependencies = makeDependencies(row, {
      getLocalMediaAsset: jest.fn(async () => mediaAsset),
      getLocalTimelineEvent: jest.fn(async () => mediaTimelineEvent),
      upsertCloudTimelineEvent: jest.fn(async () => ({
        ...mediaTimelineEvent,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
      })),
    });
    const worker = createMetadataSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.upsertCloudTimelineEvent).toHaveBeenCalledWith(
      mediaTimelineEvent,
    );
  });

  it("marks a permanent bookmark RLS failure without retrying", async () => {
    const row = queueFor("bookmark", bookmark.id);
    const dependencies = makeDependencies(row, {
      upsertCloudBookmark: jest.fn(async () => {
        throw new ProjectSyncError(
          "REMOTE_ACCESS_DENIED",
          "Access denied",
          { retryable: false, status: 403 },
        );
      }),
    });
    const worker = createMetadataSyncWorker(dependencies);

    const result = await worker.run();

    expect(result.failed).toBe(1);
    expect(dependencies.markOperationFailed).toHaveBeenCalledWith(
      row.id,
      "REMOTE_ACCESS_DENIED",
      "Access denied",
    );
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
  });
});
