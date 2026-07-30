import type { NetInfoState, NetInfoStateType } from "@react-native-community/netinfo";

import {
  createRecordingUploadWorker,
  type RecordingUploadWorkerDependencies,
} from "@/src/services/sync/recording-upload-worker";
import {
  RecordingSyncError,
} from "@/src/services/supabase/recording-repository";
import type {
  RecordingRecord,
  SessionRecord,
  UploadQueueRow,
} from "@/src/services/sqlite/repository";

const connectedWifiState = (): NetInfoState => ({
  type: "wifi" as NetInfoStateType.wifi,
  isConnected: true,
  isInternetReachable: true,
  details: {
    isConnectionExpensive: false,
    ssid: null,
    bssid: null,
    strength: null,
    ipAddress: null,
    subnet: null,
    frequency: null,
    linkSpeed: null,
    rxLinkSpeed: null,
    txLinkSpeed: null,
  },
});

const connectedCellularState = (): NetInfoState => ({
  type: "cellular" as NetInfoStateType.cellular,
  isConnected: true,
  isInternetReachable: true,
  details: {
    isConnectionExpensive: false,
    cellularGeneration: null,
    carrier: null,
  },
});

const offlineState = (): NetInfoState => ({
  type: "none" as NetInfoStateType.none,
  isConnected: false,
  isInternetReachable: false,
  details: null,
});

const session: SessionRecord = {
  id: "55555555-5555-4555-8555-555555555555",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  project_id: null,
  created_by: "33333333-3333-4333-8333-333333333333",
  title: "Recording session",
  session_type: "standard",
  status: "recorded",
  started_at: "2026-07-30T10:00:00.000Z",
  stopped_at: "2026-07-30T10:00:12.000Z",
  total_recorded_duration_ms: 12000,
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
  created_at: "2026-07-30T10:00:00.000Z",
  updated_at: "2026-07-30T10:00:12.000Z",
  deleted_at: null,
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: "2026-07-30T10:00:13.000Z",
};

const recording: RecordingRecord = {
  id: "77777777-7777-4777-8777-777777777777",
  workspace_id: session.workspace_id,
  project_id: null,
  session_id: session.id,
  local_file_uri: "file:///documents/recording.m4a",
  private_storage_path:
    `${session.workspace_id}/${session.id}/77777777-7777-4777-8777-777777777777/recording.m4a`,
  mime_type: "audio/mp4",
  original_file_name: "recording.m4a",
  file_size: 1024,
  duration_ms: 12000,
  recording_format: "m4a",
  checksum_sha256: null,
  upload_status: "pending",
  upload_error_code: null,
  upload_error_message: null,
  created_at: "2026-07-30T10:00:12.000Z",
  updated_at: "2026-07-30T10:00:12.000Z",
};

const queueRow: UploadQueueRow = {
  id: "88888888-8888-4888-8888-888888888888",
  user_id: session.created_by,
  workspace_id: session.workspace_id,
  session_id: session.id,
  source_entity_type: "recording",
  source_entity_id: recording.id,
  local_file_uri: recording.local_file_uri ?? "",
  target_storage_path: recording.private_storage_path ?? "",
  queue_status: "pending",
  attempt_count: 0,
  next_retry_at: null,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: `upload:recording:${recording.id}`,
  created_at: recording.created_at,
  updated_at: recording.updated_at,
};

const makeDependencies = (
  overrides: Partial<RecordingUploadWorkerDependencies> = {},
): RecordingUploadWorkerDependencies => {
  let returned = false;
  return {
    platform: "android",
    getConnectionState: jest.fn(async (): Promise<NetInfoState> =>
      connectedWifiState(),
    ),
    getWifiOnly: jest.fn(async () => true),
    getAuthenticatedUserId: jest.fn(async () => session.created_by),
    resetInProgress: jest.fn(async (_userId: string) => 0),
    getNextOperation: jest.fn(async () => {
      if (returned) return null;
      returned = true;
      return queueRow;
    }),
    claimOperation: jest.fn(
      async (_id: string): Promise<UploadQueueRow | null> => ({
        ...queueRow,
        queue_status: "in_progress",
        attempt_count: 1,
      }),
    ),
    getLocalRecording: jest.fn(async () => recording),
    getLocalSession: jest.fn(async () => session),
    updateRecordingStatus: jest.fn(async () => undefined),
    saveLocalRecording: jest.fn(async () => undefined),
    uploadAsset: jest.fn(async () => undefined),
    removeUploadedAsset: jest.fn(async () => undefined),
    upsertCloudRecording: jest.fn(async (value: RecordingRecord) => ({
      ...value,
      local_file_uri: null,
      upload_status: "synchronized",
    })),
    rescheduleOperation: jest.fn(async () => undefined),
    markOperationFailed: jest.fn(async () => undefined),
    deleteCompletedOperation: jest.fn(async () => undefined),
    now: jest.fn(() => new Date("2026-07-30T10:00:14.000Z")),
    random: jest.fn(() => 0.5),
    maxOperationsPerRun: 10,
    maxAttempts: 8,
    notifyChanged: jest.fn(),
    ...overrides,
  };
};

describe("recording upload worker", () => {
  it("uploads the file and stores synchronized cloud metadata", async () => {
    const dependencies = makeDependencies();
    const worker = createRecordingUploadWorker(dependencies);

    const result = await worker.run();

    expect(dependencies.resetInProgress).toHaveBeenCalledWith(
      session.created_by,
    );
    expect(result.synchronized).toBe(1);
    expect(dependencies.uploadAsset).toHaveBeenCalledWith({
      path: queueRow.target_storage_path,
      fileUri: recording.local_file_uri,
      mimeType: recording.mime_type,
    });
    expect(dependencies.upsertCloudRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        id: recording.id,
        private_storage_path: queueRow.target_storage_path,
        upload_status: "synchronized",
      }),
    );
    expect(dependencies.deleteCompletedOperation).toHaveBeenCalledWith(
      queueRow.id,
    );
  });

  it("waits without uploading while the parent session is pending", async () => {
    const dependencies = makeDependencies({
      getLocalSession: jest.fn(async () => ({
        ...session,
        local_sync_status: "pending",
        cloud_sync_status: "pending",
      })),
    });
    const worker = createRecordingUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.deferred).toBe(1);
    expect(dependencies.rescheduleOperation).toHaveBeenCalledWith(
      queueRow.id,
      expect.any(String),
      "PARENT_SESSION_PENDING",
      "Waiting for the session to synchronize first.",
    );
    expect(dependencies.uploadAsset).not.toHaveBeenCalled();
  });

  it("waits for Wi-Fi when the preference is enabled", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async (): Promise<NetInfoState> =>
        connectedCellularState(),
      ),
      getWifiOnly: jest.fn(async () => true),
    });
    const worker = createRecordingUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.state).toBe("waiting_for_wifi");
    expect(dependencies.claimOperation).not.toHaveBeenCalled();
  });

  it("allows cellular upload when Wi-Fi-only is disabled", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async (): Promise<NetInfoState> =>
        connectedCellularState(),
      ),
      getWifiOnly: jest.fn(async () => false),
    });
    const worker = createRecordingUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.uploadAsset).toHaveBeenCalledTimes(1);
  });


  it("recovers interrupted uploads separately for each signed-in user", async () => {
    let currentUserId = session.created_by;
    const dependencies = makeDependencies({
      getAuthenticatedUserId: jest.fn(async () => currentUserId),
      getNextOperation: jest.fn(async () => null),
    });
    const worker = createRecordingUploadWorker(dependencies);

    await worker.run();
    currentUserId = "99999999-9999-4999-8999-999999999999";
    await worker.run();

    expect(dependencies.resetInProgress).toHaveBeenNthCalledWith(
      1,
      session.created_by,
    );
    expect(dependencies.resetInProgress).toHaveBeenNthCalledWith(
      2,
      currentUserId,
    );
  });

  it("does not claim work while offline", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async (): Promise<NetInfoState> =>
        offlineState(),
      ),
    });
    const worker = createRecordingUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.state).toBe("offline");
    expect(dependencies.claimOperation).not.toHaveBeenCalled();
  });

  it("reschedules a retryable network failure", async () => {
    const dependencies = makeDependencies({
      uploadAsset: jest.fn(async () => {
        throw new RecordingSyncError(
          "NETWORK_UNAVAILABLE",
          "The recording is saved locally and will upload when the network is available.",
          { retryable: true },
        );
      }),
    });
    const worker = createRecordingUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.retried).toBe(1);
    expect(dependencies.rescheduleOperation).toHaveBeenCalledWith(
      queueRow.id,
      expect.any(String),
      "NETWORK_UNAVAILABLE",
      expect.stringContaining("saved locally"),
    );
    expect(dependencies.markOperationFailed).not.toHaveBeenCalled();
  });


  it("removes a just-uploaded object when the session is deleted mid-upload", async () => {
    let sessionReadCount = 0;
    const dependencies = makeDependencies({
      getLocalSession: jest.fn(async () => {
        sessionReadCount += 1;
        return sessionReadCount === 1
          ? session
          : { ...session, deleted_at: "2026-07-30T10:00:13.000Z" };
      }),
    });
    const worker = createRecordingUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.cancelled).toBe(1);
    expect(dependencies.removeUploadedAsset).toHaveBeenCalledWith(
      queueRow.target_storage_path,
    );
    expect(dependencies.upsertCloudRecording).not.toHaveBeenCalled();
    expect(dependencies.deleteCompletedOperation).toHaveBeenCalledWith(
      queueRow.id,
    );
  });

  it("returns one shared run while the worker is already active", async () => {
    let release!: () => void;
    const uploadPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependencies = makeDependencies({
      uploadAsset: jest.fn(() => uploadPromise),
    });
    const worker = createRecordingUploadWorker(dependencies);

    const first = worker.run();
    const second = worker.run();

    expect(first).toBe(second);
    release();
    await first;
    expect(dependencies.uploadAsset).toHaveBeenCalledTimes(1);
  });
});
