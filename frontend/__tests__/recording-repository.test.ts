import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fetchRemoteRecordingForSession,
  mapRemoteRecording,
  normalizeRecordingSyncError,
  upsertRemoteRecording,
} from "@/src/services/supabase/recording-repository";
import type { RecordingRecord } from "@/src/services/sqlite/repository";

const remoteRow = {
  id: "77777777-7777-4777-8777-777777777777",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  project_id: "11111111-1111-4111-8111-111111111111",
  session_id: "55555555-5555-4555-8555-555555555555",
  local_file_uri: null,
  private_storage_path:
    "22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555/77777777-7777-4777-8777-777777777777/recording.m4a",
  mime_type: "audio/mp4",
  original_file_name: "recording.m4a",
  file_size: 1024,
  duration_ms: 12000,
  recording_format: "m4a",
  checksum_sha256: null,
  upload_status: "synchronized",
  upload_error_code: null,
  upload_error_message: null,
  created_at: "2026-07-30T10:00:00.000Z",
  updated_at: "2026-07-30T10:00:12.000Z",
};

const localRecording: RecordingRecord = {
  ...remoteRow,
  local_file_uri: "file:///documents/recording.m4a",
  upload_status: "pending",
};

describe("recording remote repository helpers", () => {
  it("maps a cloud row without a device-specific local URI", () => {
    const mapped = mapRemoteRecording(remoteRow);

    expect(mapped.local_file_uri).toBeNull();
    expect(mapped.private_storage_path).toBe(remoteRow.private_storage_path);
    expect(mapped.upload_status).toBe("synchronized");
  });

  it("upserts with the stable local recording id and omits file URI", async () => {
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
          data: {
            session: {
              user: { id: "33333333-3333-4333-8333-333333333333" },
            },
          },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    const result = await upsertRemoteRecording(localRecording, client);

    expect(from).toHaveBeenCalledWith("recordings");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: localRecording.id,
        session_id: localRecording.session_id,
        local_file_uri: null,
        private_storage_path: localRecording.private_storage_path,
      }),
      { onConflict: "id" },
    );
    expect(result.id).toBe(localRecording.id);
  });

  it("fetches one recording by session id", async () => {
    const maybeSingle = jest.fn(async () => ({
      data: remoteRow,
      error: null,
      status: 200,
    }));
    const eq = jest.fn(() => ({ maybeSingle }));
    const select = jest.fn(() => ({ eq }));
    const from = jest.fn(() => ({ select }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: "user" } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    const result = await fetchRemoteRecordingForSession(
      remoteRow.session_id,
      client,
    );

    expect(eq).toHaveBeenCalledWith("session_id", remoteRow.session_id);
    expect(result?.id).toBe(remoteRow.id);
  });

  it("classifies network failures as retryable", () => {
    const mapped = normalizeRecordingSyncError(
      new TypeError("Network request failed"),
    );

    expect(mapped.code).toBe("NETWORK_UNAVAILABLE");
    expect(mapped.retryable).toBe(true);
  });
});
