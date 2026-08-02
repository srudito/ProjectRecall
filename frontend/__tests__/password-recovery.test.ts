import {
  clearPasswordRecoveryState,
  completePasswordRecoveryFromUrl,
  hasActivePasswordRecoveryGrant,
  updateRecoveredPassword,
} from "@/src/services/supabase/auth";
import { getSupabase } from "@/src/services/supabase/client";

jest.mock("expo-linking", () => ({
  createURL: jest.fn((path: string) => `https://app.example/${path}`),
}));

jest.mock("expo-web-browser", () => ({}));

jest.mock("@/src/services/supabase/client", () => ({
  getSupabase: jest.fn(),
}));

const mockedGetSupabase = getSupabase as jest.MockedFunction<
  typeof getSupabase
>;

const recoverySession = {
  access_token: "recovery-access-must-stay-in-service",
  refresh_token: "recovery-refresh-must-stay-in-service",
  user: { id: "user-1", email: "person@example.com" },
};

function createAuthMock() {
  return {
    getSession: jest.fn().mockResolvedValue({
      data: {
        session: {
          access_token: "unrelated-access",
          refresh_token: "unrelated-refresh",
          user: { id: "other-user" },
        },
      },
      error: null,
    }),
    getUser: jest.fn().mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    }),
    exchangeCodeForSession: jest.fn().mockResolvedValue({
      data: {
        session: recoverySession,
        user: recoverySession.user,
      },
      error: null,
    }),
    setSession: jest.fn().mockResolvedValue({
      data: {
        session: recoverySession,
        user: recoverySession.user,
      },
      error: null,
    }),
    updateUser: jest.fn().mockResolvedValue({
      data: { user: recoverySession.user },
      error: null,
    }),
  };
}

describe("password recovery hardening", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPasswordRecoveryState();
  });

  it("exchanges a recovery code even when another session already exists", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    const result = await completePasswordRecoveryFromUrl(
      "projectrecall://auth/reset?code=recovery-code-1&type=recovery",
    );

    expect(result).toEqual({ status: "ready" });
    expect(Object.keys(result)).toEqual(["status"]);
    expect(JSON.stringify(result)).not.toContain("access");
    expect(JSON.stringify(result)).not.toContain("refresh");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith(
      "recovery-code-1",
    );
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("uses one code exchange for concurrent observers of the same callback", async () => {
    const auth = createAuthMock();
    let resolveExchange: ((value: unknown) => void) | undefined;
    auth.exchangeCodeForSession.mockReturnValue(
      new Promise((resolve) => {
        resolveExchange = resolve;
      }) as never,
    );
    mockedGetSupabase.mockReturnValue({ auth } as never);

    const first = completePasswordRecoveryFromUrl(
      "projectrecall://auth/reset?code=recovery-code-2&type=recovery",
    );
    const second = completePasswordRecoveryFromUrl(
      "projectrecall://auth/reset?type=recovery&code=recovery-code-2",
    );

    resolveExchange?.({
      data: {
        session: recoverySession,
        user: recoverySession.user,
      },
      error: null,
    });

    await expect(first).resolves.toEqual({ status: "ready" });
    await expect(second).resolves.toEqual({ status: "ready" });
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it("rejects a callback explicitly intended for another auth flow", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      completePasswordRecoveryFromUrl(
        "projectrecall://auth/reset?code=signup-code&type=signup",
      ),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_INVALID",
    });

    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("rejects recovery-shaped codes delivered to another auth route", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      completePasswordRecoveryFromUrl(
        "projectrecall://auth/callback?code=sign-in-code&type=recovery",
      ),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_INVALID",
    });

    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("blocks password updates that were not authorized by a recovery link", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      updateRecoveredPassword("new-password-123"),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_REQUIRED",
    });

    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("updates the recovered user password and consumes the one-time grant", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await completePasswordRecoveryFromUrl(
      "projectrecall://auth/reset?code=recovery-code-3&type=recovery",
    );

    await expect(
      updateRecoveredPassword("new-password-123"),
    ).resolves.toBeUndefined();

    expect(auth.updateUser).toHaveBeenCalledWith({
      password: "new-password-123",
    });

    const updateOrder = auth.updateUser.mock.invocationCallOrder[0];
    expect(
      auth.getUser.mock.invocationCallOrder.every(
        (order) => order < updateOrder,
      ),
    ).toBe(true);

    await expect(hasActivePasswordRecoveryGrant()).resolves.toBe(false);
    await expect(
      updateRecoveredPassword("another-password-123"),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_REQUIRED",
    });
  });

  it("rejects an update result for a different user", async () => {
    const auth = createAuthMock();
    auth.updateUser.mockResolvedValue({
      data: { user: { id: "user-2" } },
      error: null,
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await completePasswordRecoveryFromUrl(
      "projectrecall://auth/reset?code=recovery-code-mismatch&type=recovery",
    );

    await expect(
      updateRecoveredPassword("new-password-123"),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_REQUIRED",
    });

    await expect(hasActivePasswordRecoveryGrant()).resolves.toBe(false);
  });

  it("rejects the update when the active user no longer matches the recovered user", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await completePasswordRecoveryFromUrl(
      "projectrecall://auth/reset?code=recovery-code-4&type=recovery",
    );

    auth.getUser.mockResolvedValue({
      data: { user: { id: "user-2" } },
      error: null,
    });

    await expect(
      updateRecoveredPassword("new-password-123"),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_REQUIRED",
    });

    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("expires the in-memory recovery grant", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await completePasswordRecoveryFromUrl(
      "projectrecall://auth/reset?code=recovery-code-5&type=recovery",
    );

    await expect(
      hasActivePasswordRecoveryGrant(Date.now() + 16 * 60 * 1000),
    ).resolves.toBe(false);
  });

  it("maps expired or already-used recovery codes to a safe expired error", async () => {
    const auth = createAuthMock();
    auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null },
      error: {
        name: "AuthApiError",
        message: "Code has expired with provider details",
        code: "bad_code_verifier",
        status: 400,
      },
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      completePasswordRecoveryFromUrl(
        "projectrecall://auth/reset?code=expired-code&type=recovery",
      ),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_EXPIRED",
    });
  });

  it("maps an explicit expired callback to a stable expired-link error", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      completePasswordRecoveryFromUrl(
        "projectrecall://auth/reset?error=access_denied&error_code=otp_expired&error_description=Email%20link%20is%20invalid%20or%20has%20expired",
      ),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_EXPIRED",
    });

    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("distinguishes a bare callback route from an expired callback", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      completePasswordRecoveryFromUrl(
        "projectrecall://auth/reset",
      ),
    ).rejects.toMatchObject({
      code: "AUTH_PASSWORD_RECOVERY_CALLBACK_MISSING",
    });
  });
});
