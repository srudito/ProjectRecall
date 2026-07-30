import type { SupabaseClient } from "@supabase/supabase-js";

import {
  listPrivateSessionAssetPaths,
  removePrivateSessionAssets,
} from "@/src/services/supabase/session-assets";

const userId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "55555555-5555-4555-8555-555555555555";

describe("private session asset cleanup", () => {
  it("discovers files recursively below the session prefix", async () => {
    const list = jest.fn(async (prefix: string) => {
      if (prefix === `${workspaceId}/${sessionId}`) {
        return {
          data: [{ id: null, name: "asset-folder" }],
          error: null,
        };
      }
      return {
        data: [{ id: "object-id", name: "photo.jpg" }],
        error: null,
      };
    });
    const fromStorage = jest.fn(() => ({ list }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "test-access-token",
              user: { id: userId },
            },
          },
          error: null,
        })),
      },
      storage: { from: fromStorage },
    } as unknown as SupabaseClient;

    const paths = await listPrivateSessionAssetPaths({
      workspaceId,
      sessionId,
      client,
    });

    expect(paths).toEqual([
      `${workspaceId}/${sessionId}/asset-folder/photo.jpg`,
    ]);
  });

  it("removes unique object paths from the private bucket", async () => {
    const remove = jest.fn(async () => ({ data: [], error: null }));
    const fromStorage = jest.fn(() => ({ remove }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "test-access-token",
              user: { id: userId },
            },
          },
          error: null,
        })),
      },
      storage: { from: fromStorage },
    } as unknown as SupabaseClient;
    const path = `${workspaceId}/${sessionId}/asset/photo.jpg`;

    await removePrivateSessionAssets({
      paths: [path, path],
      client,
    });

    expect(fromStorage).toHaveBeenCalledWith("session-assets");
    expect(remove).toHaveBeenCalledWith([path]);
  });
});
