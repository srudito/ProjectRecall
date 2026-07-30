import type { SupabaseClient } from "@supabase/supabase-js";

import { deleteRemoteSessionCascade } from "@/src/services/supabase/session-deletion-repository";

const userId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "55555555-5555-4555-8555-555555555555";

describe("remote session deletion repository", () => {
  it("deletes one authorized session using both id and workspace filters", async () => {
    const select = jest.fn(async () => ({
      data: [{ id: sessionId }],
      error: null,
      status: 200,
    }));
    const eqWorkspace = jest.fn(() => ({ select }));
    const eqId = jest.fn(() => ({ eq: eqWorkspace }));
    const remove = jest.fn(() => ({ eq: eqId }));
    const from = jest.fn(() => ({ delete: remove }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: userId } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    await deleteRemoteSessionCascade({
      sessionId,
      workspaceId,
      client,
    });

    expect(from).toHaveBeenCalledWith("sessions");
    expect(eqId).toHaveBeenCalledWith("id", sessionId);
    expect(eqWorkspace).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(select).toHaveBeenCalledWith("id");
  });

  it("treats an already missing session as an idempotent success", async () => {
    const select = jest.fn(async () => ({
      data: [],
      error: null,
      status: 200,
    }));
    const eqWorkspace = jest.fn(() => ({ select }));
    const eqId = jest.fn(() => ({ eq: eqWorkspace }));
    const remove = jest.fn(() => ({ eq: eqId }));
    const from = jest.fn(() => ({ delete: remove }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: userId } } },
          error: null,
        })),
      },
      from,
    } as unknown as SupabaseClient;

    await expect(
      deleteRemoteSessionCascade({ sessionId, workspaceId, client }),
    ).resolves.toBeUndefined();
  });
});
