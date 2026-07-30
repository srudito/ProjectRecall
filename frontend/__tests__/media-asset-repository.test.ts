import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fetchRemoteMediaAssets,
  mapRemoteMediaAsset,
  normalizeMediaAssetSyncError,
  upsertRemoteMediaAsset,
} from "@/src/services/supabase/media-asset-repository";
import type { MediaAssetRecord } from "@/src/services/sqlite/repository";

const remoteRow = {
  id: "77777777-7777-4777-8777-777777777777",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  project_id: "11111111-1111-4111-8111-111111111111",
  session_id: "55555555-5555-4555-8555-555555555555",
  added_by: "33333333-3333-4333-8333-333333333333",
  asset_type: "image",
  mime_type: "image/jpeg",
  original_file_name: "pump.jpg",
  sanitized_file_name: "pump.jpg",
  local_file_uri: null,
  private_storage_path:
    "22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555/77777777-7777-4777-8777-777777777777/pump.jpg",
  file_size: 4096,
  duration_ms: null,
  image_width: 1600,
  image_height: 1200,
  page_count: null,
  captured_at: "2026-07-30T10:00:05.000Z",
  recording_offset_ms: 5000,
  user_caption: "Pump seal",
  checksum_sha256: null,
  upload_status: "synchronized",
  upload_error_code: null,
  upload_error_message: null,
  created_at: "2026-07-30T10:00:05.000Z",
  updated_at: "2026-07-30T10:00:06.000Z",
  deleted_at: null,
};

const localAsset: MediaAssetRecord = {
  ...remoteRow,
  local_file_uri: "file:///documents/pump.jpg",
  upload_status: "pending",
};

describe("media asset remote repository", () => {
  it("maps a remote asset without a device-specific local URI", () => {
    const mapped = mapRemoteMediaAsset(remoteRow);
    expect(mapped.local_file_uri).toBeNull();
    expect(mapped.private_storage_path).toBe(remoteRow.private_storage_path);
  });

  it("upserts a stable asset id and never sends local_file_uri", async () => {
    const single = jest.fn(async () => ({
      data: remoteRow,
      error: null,
      status: 201,
    }));
    const select = jest.fn(() => ({ single }));
    const upsert = jest.fn(() => ({ select }));
    const from = jest.fn(() => ({ upsert }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: remoteRow.added_by } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    const result = await upsertRemoteMediaAsset(localAsset, client);

    expect(from).toHaveBeenCalledWith("media_assets");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: localAsset.id,
        local_file_uri: null,
        private_storage_path: localAsset.private_storage_path,
      }),
      { onConflict: "id" },
    );
    expect(result.id).toBe(localAsset.id);
  });

  it("fetches evidence ordered for one session", async () => {
    const orderCreated = jest.fn(async () => ({
      data: [remoteRow],
      error: null,
      status: 200,
    }));
    const orderOffset = jest.fn(() => ({ order: orderCreated }));
    const isDeleted = jest.fn(() => ({ order: orderOffset }));
    const eq = jest.fn(() => ({ is: isDeleted }));
    const select = jest.fn(() => ({ eq }));
    const from = jest.fn(() => ({ select }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: remoteRow.added_by } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    const result = await fetchRemoteMediaAssets(remoteRow.session_id, client);

    expect(eq).toHaveBeenCalledWith("session_id", remoteRow.session_id);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(remoteRow.id);
  });

  it("classifies network failures as retryable evidence errors", () => {
    const error = normalizeMediaAssetSyncError(
      new TypeError("Network request failed"),
    );
    expect(error.code).toBe("NETWORK_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });
});
