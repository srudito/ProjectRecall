import { getSupabase } from "@/src/services/supabase/client";
import { clearLocalAuthSession } from "@/src/services/supabase/auth";

jest.mock("@/src/services/supabase/client", () => ({
  getSupabase: jest.fn(),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const mockedGetSupabase = getSupabase as jest.MockedFunction<
  typeof getSupabase
>;

describe("deleted-account local auth cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("preserves a different user's active session on a shared device", async () => {
    const signOut = jest.fn();
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: { user: { id: OTHER_USER_ID } } },
          error: null,
        })),
        signOut,
      },
    } as never);

    await expect(clearLocalAuthSession(USER_ID)).resolves.toBe(
      "different_user_preserved",
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  it("accepts a cleared persisted session even when the server logout reports that the deleted user no longer exists", async () => {
    const getSession = jest
      .fn()
      .mockResolvedValueOnce({
        data: { session: { user: { id: USER_ID } } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: null },
        error: null,
      });
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession,
        signOut: jest.fn(async () => ({
          error: { code: "user_not_found", message: "User not found" },
        })),
      },
    } as never);

    await expect(clearLocalAuthSession(USER_ID)).resolves.toBe("cleared");
  });

  it("fails closed when the deleted user's session remains persisted", async () => {
    const getSession = jest.fn(async () => ({
      data: { session: { user: { id: USER_ID } } },
      error: null,
    }));
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession,
        signOut: jest.fn(async () => ({ error: null })),
      },
    } as never);

    await expect(clearLocalAuthSession(USER_ID)).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_LOCAL_CLEANUP_FAILED",
    });
  });
  it("fails closed when the session cannot be read before sign-out", async () => {
    const signOut = jest.fn();
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession: jest.fn(async () => ({
          data: { session: null },
          error: { code: "storage_read_failed", message: "read failed" },
        })),
        signOut,
      },
    } as never);

    await expect(clearLocalAuthSession(USER_ID)).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_LOCAL_CLEANUP_FAILED",
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("fails closed when session verification fails after local sign-out", async () => {
    const getSession = jest
      .fn()
      .mockResolvedValueOnce({
        data: { session: { user: { id: USER_ID } } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: null },
        error: { code: "storage_read_failed", message: "read failed" },
      });
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession,
        signOut: jest.fn(async () => ({ error: null })),
      },
    } as never);

    await expect(clearLocalAuthSession(USER_ID)).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_LOCAL_CLEANUP_FAILED",
    });
  });

  it("fails closed when the configured Supabase client is unavailable", async () => {
    mockedGetSupabase.mockReturnValue(null);

    await expect(clearLocalAuthSession(USER_ID)).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_LOCAL_CLEANUP_FAILED",
    });
  });

});
