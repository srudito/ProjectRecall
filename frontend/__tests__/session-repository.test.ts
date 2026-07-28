import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fetchRemoteSession,
  mapRemoteSession,
  normalizeSessionSyncError,
  upsertRemoteSession,
} from "@/src/services/supabase/session-repository";
import type { SessionRecord } from "@/src/services/sqlite/repository";

const remoteRow = {
  id: "55555555-5555-4555-8555-555555555555",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  project_id: "11111111-1111-4111-8111-111111111111",
  created_by: "33333333-3333-4333-8333-333333333333",
  title: "Pump inspection",
  session_type: "standard",
  status: "recorded",
  started_at: "2026-07-27T10:00:00.000Z",
  stopped_at: "2026-07-27T10:10:00.000Z",
  total_recorded_duration_ms: 600000,
  spoken_language_mode: "MULTILINGUAL",
  expected_spoken_languages: ["en", "id"],
  detected_spoken_languages: [],
  primary_detected_language: null,
  language_detection_status: "NOT_STARTED",
  summary_output_language: null,
  translation_target_language: null,
  transcript_display_mode: "ORIGINAL",
  language_metadata: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  created_at: "2026-07-27T10:00:00.000Z",
  updated_at: "2026-07-27T10:10:00.000Z",
  deleted_at: null,
};

const localSession: SessionRecord = {
  ...remoteRow,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

describe("session remote repository helpers", () => {
  it("maps a cloud row to a synchronized local session", () => {
    const mapped = mapRemoteSession(remoteRow);

    expect(mapped.local_sync_status).toBe("synchronized");
    expect(mapped.cloud_sync_status).toBe("synchronized");
    expect(mapped.expected_spoken_languages).toEqual(["en", "id"]);
    expect(mapped.total_recorded_duration_ms).toBe(600000);
  });

  it("upserts with the stable local session id", async () => {
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
          data: { session: { user: { id: remoteRow.created_by } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    const result = await upsertRemoteSession(localSession, client);

    expect(from).toHaveBeenCalledWith("sessions");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: localSession.id,
        workspace_id: localSession.workspace_id,
        project_id: localSession.project_id,
        created_by: localSession.created_by,
        status: localSession.status,
        total_recorded_duration_ms: localSession.total_recorded_duration_ms,
      }),
      { onConflict: "id" },
    );
    expect(result.id).toBe(localSession.id);
    expect(result.local_sync_status).toBe("synchronized");
  });


  it("does not return soft-deleted sessions from a single-session fetch", async () => {
    const maybeSingle = jest.fn(async () => ({
      data: remoteRow,
      error: null,
      status: 200,
    }));
    const is = jest.fn(() => ({ maybeSingle }));
    const eq = jest.fn(() => ({ is }));
    const select = jest.fn(() => ({ eq }));
    const from = jest.fn(() => ({ select }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: remoteRow.created_by } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    const result = await fetchRemoteSession(remoteRow.id, client);

    expect(from).toHaveBeenCalledWith("sessions");
    expect(eq).toHaveBeenCalledWith("id", remoteRow.id);
    expect(is).toHaveBeenCalledWith("deleted_at", null);
    expect(result?.id).toBe(remoteRow.id);
  });

  it("rejects a session created by another authenticated user", async () => {
    const from = jest.fn();
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
            },
          },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    await expect(upsertRemoteSession(localSession, client)).rejects.toMatchObject({
      code: "REMOTE_ACCESS_DENIED",
      retryable: false,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("uses session-specific safe text for network failures", () => {
    const mapped = normalizeSessionSyncError(new TypeError("Failed to fetch"));

    expect(mapped.code).toBe("NETWORK_UNAVAILABLE");
    expect(mapped.retryable).toBe(true);
    expect(mapped.message).toContain("session is saved locally");
  });
});
