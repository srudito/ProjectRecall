import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionUserPreferenceRecord } from "@/src/services/sqlite/repository";
import {
  fetchRemoteSessionPreferences,
  upsertRemoteSessionPreference,
} from "@/src/services/supabase/session-preference-repository";

const userId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "55555555-5555-4555-8555-555555555555";

const preference: SessionUserPreferenceRecord = {
  id: `session-preference:${userId}:${sessionId}`,
  user_id: userId,
  workspace_id: workspaceId,
  session_id: sessionId,
  is_starred: true,
  created_at: "2026-07-31T10:00:00.000Z",
  updated_at: "2026-07-31T10:00:00.000Z",
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

const remoteRow = {
  user_id: userId,
  session_id: sessionId,
  is_starred: true,
  created_at: preference.created_at,
  updated_at: preference.updated_at,
};

describe("session preference remote repository", () => {
  it("upserts one user's preference using the composite key", async () => {
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
          data: { session: { user: { id: userId } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    const result = await upsertRemoteSessionPreference(preference, client);

    expect(from).toHaveBeenCalledWith("session_user_preferences");
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: userId,
        session_id: sessionId,
        is_starred: true,
      },
      { onConflict: "user_id,session_id" },
    );
    expect(result.is_starred).toBe(true);
    expect(result.local_sync_status).toBe("synchronized");
  });

  it("rejects another user's preference", async () => {
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

    await expect(
      upsertRemoteSessionPreference(preference, client),
    ).rejects.toMatchObject({
      code: "REMOTE_ACCESS_DENIED",
      retryable: false,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("fetches preferences only for the requested session ids", async () => {
    const inFilter = jest.fn(async () => ({
      data: [remoteRow],
      error: null,
      status: 200,
    }));
    const eq = jest.fn(() => ({ in: inFilter }));
    const select = jest.fn(() => ({ eq }));
    const from = jest.fn(() => ({ select }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: userId } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    const result = await fetchRemoteSessionPreferences({
      userId,
      workspaceId,
      sessionIds: [sessionId],
      clientOverride: client,
    });

    expect(from).toHaveBeenCalledWith("session_user_preferences");
    expect(eq).toHaveBeenCalledWith("user_id", userId);
    expect(inFilter).toHaveBeenCalledWith("session_id", [sessionId]);
    expect(result[0]).toMatchObject({
      workspace_id: workspaceId,
      session_id: sessionId,
      is_starred: true,
    });
  });
});
