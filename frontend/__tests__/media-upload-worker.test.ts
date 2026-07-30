import type { NetInfoState, NetInfoStateType } from "@react-native-community/netinfo";

import {
  createMediaUploadWorker,
  type MediaUploadWorkerDependencies,
} from "@/src/services/sync/media-upload-worker";
import { MediaAssetSyncError } from "@/src/services/supabase/media-asset-repository";
import type {
  MediaAssetRecord,
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
  title: "Evidence session",
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

const asset: MediaAssetRecord = {
  id: "77777777-7777-4777-8777-777777777777",
  workspace_id: session.workspace_id,
  project_id: null,
  session_id: session.id,
  added_by: session.created_by,
  asset_type: "image",
  mime_type: "image/jpeg",
  original_file_name: "pump.jpg",
  sanitized_file_name: "pump.jpg",
  local_file_uri: "file:///documents/pump.jpg",
  private_storage_path:
    `${session.workspace_id}/${session.id}/77777777-7777-4777-8777-777777777777/pump.jpg`,
  file_size: 4096,
  duration_ms: null,
  image_width: 1600,
  image_height: 1200,
  page_count: null,
  captured_at: "2026-07-30T10:00:05.000Z",
  recording_offset_ms: 5000,
  user_caption: null,
  checksum_sha256: null,
  upload_status: "pending",
  upload_error_code: null,
  upload_error_message: null,
  created_at: "2026-07-30T10:00:05.000Z",
  updated_at: "2026-07-30T10:00:05.000Z",
  deleted_at: null,
};

const queueRow: UploadQueueRow = {
  id: "88888888-8888-4888-8888-888888888888",
  user_id: session.created_by,
  workspace_id: session.workspace_id,
  session_id: session.id,
  source_entity_type: "media_asset",
  source_entity_id: asset.id,
  local_file_uri: asset.local_file_uri ?? "",
  target_storage_path: asset.private_storage_path ?? "",
  queue_status: "pending",
  attempt_count: 0,
  next_retry_at: null,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: `upload:media_asset:${asset.id}`,
  created_at: asset.created_at,
  updated_at: asset.updated_at,
};

const makeDependencies = (
  overrides: Partial<MediaUploadWorkerDependencies> = {},
): MediaUploadWorkerDependencies => {
  let returned = false;
  return {
    platform: "android",
    getConnectionState: jest.fn(async (): Promise<NetInfoState> =>
      connectedWifiState(),
    ),
    getWifiOnly: jest.fn(async () => true),
    getAuthenticatedUserId: jest.fn(async () => session.created_by),
    resetInProgress: jest.fn(async () => 0),
    getNextOperation: jest.fn(async () => {
      if (returned) return null;
      returned = true;
      return queueRow;
    }),
    claimOperation: jest.fn(
      async (): Promise<UploadQueueRow | null> => ({
        ...queueRow,
        queue_status: "in_progress",
        attempt_count: 1,
      }),
    ),
    getLocalAsset: jest.fn(async () => asset),
    getLocalSession: jest.fn(async () => session),
    updateAssetStatus: jest.fn(async () => undefined),
    saveLocalAsset: jest.fn(async () => undefined),
    uploadAsset: jest.fn(async () => undefined),
    upsertCloudAsset: jest.fn(async (value: MediaAssetRecord) => ({
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
    requestMetadata: jest.fn(),
    ...overrides,
  };
};

describe("media upload worker", () => {
  it("uploads evidence and then requests timeline metadata sync", async () => {
    const dependencies = makeDependencies();
    const worker = createMediaUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.synchronized).toBe(1);
    expect(dependencies.uploadAsset).toHaveBeenCalledWith({
      path: queueRow.target_storage_path,
      fileUri: asset.local_file_uri,
      mimeType: asset.mime_type,
    });
    expect(dependencies.upsertCloudAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: asset.id,
        private_storage_path: queueRow.target_storage_path,
        upload_status: "synchronized",
      }),
    );
    expect(dependencies.deleteCompletedOperation).toHaveBeenCalledWith(
      queueRow.id,
    );
    expect(dependencies.requestMetadata).toHaveBeenCalledTimes(1);
  });

  it("waits while the parent session is pending", async () => {
    const dependencies = makeDependencies({
      getLocalSession: jest.fn(async () => ({
        ...session,
        local_sync_status: "pending",
        cloud_sync_status: "pending",
      })),
    });
    const worker = createMediaUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.deferred).toBe(1);
    expect(dependencies.uploadAsset).not.toHaveBeenCalled();
  });

  it("waits for Wi-Fi when that preference is enabled", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async (): Promise<NetInfoState> =>
        connectedCellularState(),
      ),
      getWifiOnly: jest.fn(async () => true),
    });
    const worker = createMediaUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.state).toBe("waiting_for_wifi");
    expect(dependencies.claimOperation).not.toHaveBeenCalled();
  });

  it("does not claim evidence while offline", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async (): Promise<NetInfoState> =>
        offlineState(),
      ),
    });
    const worker = createMediaUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.state).toBe("offline");
    expect(dependencies.claimOperation).not.toHaveBeenCalled();
  });

  it("reschedules a retryable upload failure", async () => {
    const dependencies = makeDependencies({
      uploadAsset: jest.fn(async () => {
        throw new MediaAssetSyncError(
          "NETWORK_UNAVAILABLE",
          "The evidence is saved locally and will upload when the network is available.",
          { retryable: true },
        );
      }),
    });
    const worker = createMediaUploadWorker(dependencies);

    const result = await worker.run();

    expect(result.retried).toBe(1);
    expect(dependencies.rescheduleOperation).toHaveBeenCalledWith(
      queueRow.id,
      expect.any(String),
      "NETWORK_UNAVAILABLE",
      expect.stringContaining("saved locally"),
    );
  });

  it("returns one shared run while already active", async () => {
    let release!: () => void;
    const uploadPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependencies = makeDependencies({
      uploadAsset: jest.fn(() => uploadPromise),
    });
    const worker = createMediaUploadWorker(dependencies);

    const first = worker.run();
    const second = worker.run();

    expect(first).toBe(second);
    release();
    await first;
    expect(dependencies.uploadAsset).toHaveBeenCalledTimes(1);
  });
});
