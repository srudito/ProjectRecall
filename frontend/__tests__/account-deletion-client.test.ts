import { getSupabase } from "@/src/services/supabase/client";
import {
  AccountDeletionClientError,
  getCurrentAccountExistence,
  invokeDeleteAccount,
  isSafeAccountDeletionPreflightBlock,
} from "@/src/services/account-deletion/client";

jest.mock("@/src/services/supabase/client", () => ({
  getSupabase: jest.fn(),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

const mockedGetSupabase = getSupabase as jest.MockedFunction<
  typeof getSupabase
>;

const responseError = (status: number, payload: unknown): object => ({
  context: {
    status,
    clone: () => ({
      json: jest.fn(async () => payload),
    }),
  },
});

describe("delete account Edge Function client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("invokes the function with the captured current-user bearer token and returns only a narrow result", async () => {
    const invoke = jest.fn(async () => ({
      data: {
        status: "deleted",
        deletedWorkspaceCount: 2,
        deletedStorageObjectCount: 4,
        requestId: "request-1",
        access_token: "must-not-cross-boundary",
      },
      error: null,
    }));
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "captured-user-token",
              user: { id: USER_ID },
            },
          },
          error: null,
        })),
      },
      functions: { invoke },
    } as never);

    const result = await invokeDeleteAccount(USER_ID);
    expect(result).toEqual({
      status: "deleted",
      deletedWorkspaceCount: 2,
      deletedStorageObjectCount: 4,
      requestId: "request-1",
    });
    expect(invoke).toHaveBeenCalledWith("delete-account", {
      body: { confirmation: "DELETE" },
      headers: { Authorization: "Bearer captured-user-token" },
    });
    expect(JSON.stringify(result)).not.toContain(
      "captured-user-token",
    );
    expect(JSON.stringify(result)).not.toContain(
      "must-not-cross-boundary",
    );
  });

  it("does not invoke deletion when the persisted session belongs to another user", async () => {
    const invoke = jest.fn();
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "other-user-token",
              user: { id: OTHER_USER_ID },
            },
          },
          error: null,
        })),
      },
      functions: { invoke },
    } as never);

    await expect(invokeDeleteAccount(USER_ID)).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_INVALID_SESSION",
      status: 401,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("maps a structured server blocker without exposing raw response fields", async () => {
    const rawError = responseError(409, {
      error: {
        code: "ACCOUNT_DELETION_BLOCKED",
        retryable: false,
        gateActive: false,
        blockers: [
          "OWNED_WORKSPACE_HAS_OTHER_MEMBERS",
          "NOT_A_REAL_BLOCKER",
        ],
        database_error: "must-not-surface",
      },
    });
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "token",
              user: { id: USER_ID },
            },
          },
          error: null,
        })),
      },
      functions: {
        invoke: jest.fn(async () => ({ data: null, error: rawError })),
      },
    } as never);

    let caught: unknown;
    try {
      await invokeDeleteAccount(USER_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AccountDeletionClientError);
    expect(caught).toMatchObject({
      code: "ACCOUNT_DELETION_BLOCKED",
      status: 409,
      retryable: false,
      gateActive: false,
      blockers: ["OWNED_WORKSPACE_HAS_OTHER_MEMBERS"],
    });
    expect(JSON.stringify(caught)).not.toContain("database_error");
  });

  it("parses gate-active server errors without treating them as safe blockers", async () => {
    const rawError = responseError(409, {
      error: {
        code: "ACCOUNT_DELETION_TOO_LARGE",
        retryable: false,
        gateActive: true,
      },
    });
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "token",
              user: { id: USER_ID },
            },
          },
          error: null,
        })),
      },
      functions: {
        invoke: jest.fn(async () => ({ data: null, error: rawError })),
      },
    } as never);

    let caught: unknown;
    try {
      await invokeDeleteAccount(USER_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AccountDeletionClientError);
    expect(caught).toMatchObject({
      code: "ACCOUNT_DELETION_TOO_LARGE",
      gateActive: true,
    });
    expect(
      isSafeAccountDeletionPreflightBlock(
        caught as AccountDeletionClientError,
      ),
    ).toBe(false);
  });

  it("rejects an invalid success payload", async () => {
    mockedGetSupabase.mockReturnValue({
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "token",
              user: { id: USER_ID },
            },
          },
          error: null,
        })),
      },
      functions: {
        invoke: jest.fn(async () => ({
          data: { status: "deleted", access_token: "bad" },
          error: null,
        })),
      },
    } as never);

    await expect(invokeDeleteAccount(USER_ID)).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_INVALID_RESPONSE",
      retryable: true,
    });
  });

  it("distinguishes an existing account, a missing account, and a changed session", async () => {
    const getUser = jest
      .fn()
      .mockResolvedValueOnce({
        data: { user: { id: USER_ID } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { user: null },
        error: { code: "user_not_found", message: "User not found" },
      })
      .mockResolvedValueOnce({
        data: { user: { id: OTHER_USER_ID } },
        error: null,
      });
    mockedGetSupabase.mockReturnValue({ auth: { getUser } } as never);

    await expect(getCurrentAccountExistence(USER_ID)).resolves.toBe(
      "exists",
    );
    await expect(getCurrentAccountExistence(USER_ID)).resolves.toBe(
      "missing",
    );
    await expect(getCurrentAccountExistence(USER_ID)).resolves.toBe(
      "session_changed",
    );
  });
  it("keeps gate-active errors inside the privacy boundary", () => {
    const beforeGate = new AccountDeletionClientError(
      "ACCOUNT_DELETION_TOO_LARGE",
      { gateActive: false },
    );
    const afterGate = new AccountDeletionClientError(
      "ACCOUNT_DELETION_TOO_LARGE",
      { gateActive: true },
    );
    const unknownGate = new AccountDeletionClientError(
      "ACCOUNT_DELETION_TOO_LARGE",
    );

    expect(isSafeAccountDeletionPreflightBlock(beforeGate)).toBe(true);
    expect(isSafeAccountDeletionPreflightBlock(afterGate)).toBe(false);
    expect(isSafeAccountDeletionPreflightBlock(unknownGate)).toBe(false);
  });

});
