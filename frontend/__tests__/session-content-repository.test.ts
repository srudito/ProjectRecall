import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  NoteRecord,
  TimelineEventRecord,
} from "@/src/services/sqlite/repository";
import {
  fetchRemoteBookmarks,
  mapRemoteBookmark,
  mapRemoteNote,
  mapRemoteTimelineEvent,
  normalizeSessionContentSyncError,
  upsertRemoteNote,
  upsertRemoteTimelineEvent,
} from "@/src/services/supabase/session-content-repository";

const userId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "55555555-5555-4555-8555-555555555555";

const noteRow = {
  id: "66666666-6666-4666-8666-666666666666",
  workspace_id: workspaceId,
  project_id: null,
  session_id: sessionId,
  text: "Inspect the bearing housing",
  recording_offset_ms: 12000,
  created_by: userId,
  created_at: "2026-07-28T10:00:12.000Z",
  updated_at: "2026-07-28T10:00:12.000Z",
  deleted_at: null,
};

const bookmarkRow = {
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
};

const timelineRow = {
  id: "88888888-8888-4888-8888-888888888888",
  workspace_id: workspaceId,
  project_id: null,
  session_id: sessionId,
  event_type: "note_added",
  source_entity_type: "note",
  source_entity_id: noteRow.id,
  recording_offset_ms: noteRow.recording_offset_ms,
  created_by: userId,
  created_at: noteRow.created_at,
};

const localNote: NoteRecord = {
  ...noteRow,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

const localTimeline: TimelineEventRecord = {
  ...timelineRow,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

describe("session content remote repository", () => {
  it("maps cloud rows to synchronized local records", () => {
    expect(mapRemoteNote(noteRow).local_sync_status).toBe("synchronized");
    expect(mapRemoteBookmark(bookmarkRow).cloud_sync_status).toBe(
      "synchronized",
    );
    expect(mapRemoteTimelineEvent(timelineRow).source_entity_id).toBe(
      noteRow.id,
    );
  });

  it("upserts a note with the stable local UUID", async () => {
    const single = jest.fn(async () => ({
      data: noteRow,
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

    const result = await upsertRemoteNote(localNote, client);

    expect(from).toHaveBeenCalledWith("user_notes");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: localNote.id,
        session_id: sessionId,
        created_by: userId,
        recording_offset_ms: 12000,
      }),
      { onConflict: "id" },
    );
    expect(result.id).toBe(localNote.id);
    expect(result.local_sync_status).toBe("synchronized");
  });

  it("upserts a timeline event with the source note UUID", async () => {
    const single = jest.fn(async () => ({
      data: timelineRow,
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

    const result = await upsertRemoteTimelineEvent(localTimeline, client);

    expect(from).toHaveBeenCalledWith("timeline_events");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: timelineRow.id,
        source_entity_type: "note",
        source_entity_id: noteRow.id,
      }),
      { onConflict: "id" },
    );
    expect(result.id).toBe(timelineRow.id);
  });

  it("fetches non-deleted bookmarks for one session", async () => {
    const orderCreated = jest.fn(async () => ({
      data: [bookmarkRow],
      error: null,
      status: 200,
    }));
    const orderOffset = jest.fn(() => ({ order: orderCreated }));
    const is = jest.fn(() => ({ order: orderOffset }));
    const eq = jest.fn(() => ({ is }));
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

    const result = await fetchRemoteBookmarks(sessionId, client);

    expect(from).toHaveBeenCalledWith("bookmarks");
    expect(eq).toHaveBeenCalledWith("session_id", sessionId);
    expect(is).toHaveBeenCalledWith("deleted_at", null);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Important");
  });

  it("rejects content created by a different authenticated user", async () => {
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

    await expect(upsertRemoteNote(localNote, client)).rejects.toMatchObject({
      code: "REMOTE_ACCESS_DENIED",
      retryable: false,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("uses content-specific safe text for network failures", () => {
    const mapped = normalizeSessionContentSyncError(
      new TypeError("Failed to fetch"),
      "bookmark",
    );

    expect(mapped.code).toBe("NETWORK_UNAVAILABLE");
    expect(mapped.retryable).toBe(true);
    expect(mapped.message).toContain("bookmark is saved locally");
  });
});
