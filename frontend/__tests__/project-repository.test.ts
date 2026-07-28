import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mapRemoteProject,
  normalizeProjectSyncError,
  upsertRemoteProject,
} from "@/src/services/supabase/project-repository";
import type { ProjectRecord } from "@/src/services/sqlite/repository";

const remoteRow = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  name: "Pump inspection",
  description: null,
  status: "active",
  default_spoken_language_mode: null,
  default_expected_spoken_languages: ["en", "id"],
  default_summary_output_language: null,
  default_translation_target_language: null,
  created_by: "33333333-3333-4333-8333-333333333333",
  created_at: "2026-07-27T10:00:00.000Z",
  updated_at: "2026-07-27T10:00:00.000Z",
  deleted_at: null,
};

const localProject: ProjectRecord = {
  ...remoteRow,
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
};

describe("project remote repository helpers", () => {
  it("maps a cloud row to a synchronized local record", () => {
    const mapped = mapRemoteProject(remoteRow);

    expect(mapped.local_sync_status).toBe("synchronized");
    expect(mapped.cloud_sync_status).toBe("synchronized");
    expect(mapped.default_expected_spoken_languages).toEqual(["en", "id"]);
  });

  it("upserts with the stable local project id through the authenticated client", async () => {
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

    const result = await upsertRemoteProject(localProject, client);

    expect(from).toHaveBeenCalledWith("projects");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: localProject.id,
        workspace_id: localProject.workspace_id,
        created_by: localProject.created_by,
      }),
      { onConflict: "id" },
    );
    expect(result.id).toBe(localProject.id);
    expect(result.local_sync_status).toBe("synchronized");
  });

  it("rejects a project whose creator does not match the authenticated user", async () => {
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

    await expect(upsertRemoteProject(localProject, client)).rejects.toMatchObject({
      code: "REMOTE_ACCESS_DENIED",
      retryable: false,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("classifies network failures as retryable", () => {
    const mapped = normalizeProjectSyncError(new TypeError("Failed to fetch"));

    expect(mapped.code).toBe("NETWORK_UNAVAILABLE");
    expect(mapped.retryable).toBe(true);
  });

  it("classifies RLS failures as permanent access errors", () => {
    const mapped = normalizeProjectSyncError(
      { code: "42501", message: "row-level security policy" },
      403,
    );

    expect(mapped.code).toBe("REMOTE_ACCESS_DENIED");
    expect(mapped.retryable).toBe(false);
  });
});
