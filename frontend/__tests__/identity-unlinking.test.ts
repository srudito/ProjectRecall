import {
  canDisconnectConnectedIdentity,
  unlinkGoogleIdentity,
} from "@/src/services/supabase/auth";
import { getSupabase } from "@/src/services/supabase/client";

jest.mock("@/src/services/supabase/client", () => ({
  getSupabase: jest.fn(),
}));

const mockedGetSupabase = getSupabase as jest.MockedFunction<
  typeof getSupabase
>;

const emailIdentity = {
  id: "email-row-1",
  user_id: "user-1",
  identity_id: "email-identity-1",
  provider: "email",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  last_sign_in_at: "2026-08-01T00:00:00.000Z",
  identity_data: {
    email: "person@example.com",
  },
};

const googleIdentity = {
  id: "google-row-1",
  user_id: "user-1",
  identity_id: "google-identity-1",
  provider: "google",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  last_sign_in_at: "2026-08-01T00:00:00.000Z",
  identity_data: {
    email: "google@example.com",
    provider_token: "must-never-leave-auth-service",
  },
};

const identitiesResponse = (identities: unknown[]) => ({
  data: { identities },
  error: null,
});

function createAuthMock() {
  return {
    getUser: jest.fn().mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    }),
    getUserIdentities: jest
      .fn()
      .mockResolvedValueOnce(
        identitiesResponse([emailIdentity, googleIdentity]),
      )
      .mockResolvedValue(identitiesResponse([emailIdentity])),
    unlinkIdentity: jest.fn().mockResolvedValue({
      data: {},
      error: null,
    }),
  };
}

describe("Google identity unlinking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("unlinks the requested raw Google identity and returns only a safe status", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    const result = await unlinkGoogleIdentity("google-identity-1");

    expect(result).toEqual({ status: "unlinked" });
    expect(Object.keys(result)).toEqual(["status"]);
    expect(JSON.stringify(result)).not.toContain("provider_token");
    expect(JSON.stringify(result)).not.toContain("must-never-leave");
    expect(auth.unlinkIdentity).toHaveBeenCalledTimes(1);
    expect(auth.unlinkIdentity).toHaveBeenCalledWith(googleIdentity);
    expect(auth.getUser).toHaveBeenCalledTimes(4);
  });

  it("returns notConnected without calling Supabase when the target is absent", async () => {
    const auth = createAuthMock();
    auth.getUserIdentities.mockReset();
    auth.getUserIdentities.mockResolvedValue(
      identitiesResponse([emailIdentity]),
    );
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      unlinkGoogleIdentity("missing-google-identity"),
    ).resolves.toEqual({ status: "notConnected" });

    expect(auth.unlinkIdentity).not.toHaveBeenCalled();
  });

  it("protects the last connected identity before sending an unlink request", async () => {
    const auth = createAuthMock();
    auth.getUserIdentities.mockReset();
    auth.getUserIdentities.mockResolvedValue(
      identitiesResponse([googleIdentity]),
    );
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      unlinkGoogleIdentity("google-identity-1"),
    ).resolves.toEqual({ status: "lastIdentity" });

    expect(auth.unlinkIdentity).not.toHaveBeenCalled();
  });

  it("maps Supabase single-identity protection to the same safe result", async () => {
    const auth = createAuthMock();
    auth.unlinkIdentity.mockResolvedValue({
      data: null,
      error: {
        name: "AuthApiError",
        message: "A user must have at least one identity",
        code: "single_identity_not_deletable",
        status: 422,
      },
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      unlinkGoogleIdentity("google-identity-1"),
    ).resolves.toEqual({ status: "lastIdentity" });
  });

  it("treats an identity removed by another request as already disconnected", async () => {
    const auth = createAuthMock();
    auth.unlinkIdentity.mockResolvedValue({
      data: null,
      error: {
        name: "AuthApiError",
        message: "Identity not found",
        code: "identity_not_found",
        status: 404,
      },
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      unlinkGoogleIdentity("google-identity-1"),
    ).resolves.toEqual({ status: "notConnected" });
  });

  it("maps disabled manual unlinking to a stable application error", async () => {
    const auth = createAuthMock();
    auth.unlinkIdentity.mockResolvedValue({
      data: null,
      error: {
        name: "AuthApiError",
        message: "Manual linking is disabled",
        code: "manual_linking_disabled",
        status: 422,
      },
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      unlinkGoogleIdentity("google-identity-1"),
    ).rejects.toMatchObject({
      code: "AUTH_IDENTITY_UNLINK_NOT_CONFIGURED",
    });
  });

  it("maps email-conflict protection without exposing the provider response", async () => {
    const auth = createAuthMock();
    auth.unlinkIdentity.mockResolvedValue({
      data: null,
      error: {
        name: "AuthApiError",
        message: "Provider supplied sensitive conflict details",
        code: "email_conflict_identity_not_deletable",
        status: 422,
      },
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      unlinkGoogleIdentity("google-identity-1"),
    ).rejects.toMatchObject({
      code: "AUTH_IDENTITY_UNLINK_EMAIL_CONFLICT",
    });
  });

  it("fails safely if the authenticated user changes during unlinking", async () => {
    const auth = createAuthMock();
    auth.getUser
      .mockResolvedValueOnce({
        data: { user: { id: "user-1" } },
        error: null,
      })
      .mockResolvedValue({
        data: { user: { id: "user-2" } },
        error: null,
      });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(
      unlinkGoogleIdentity("google-identity-1"),
    ).rejects.toMatchObject({
      code: "AUTH_IDENTITY_UNLINK_SESSION_CHANGED",
    });
  });

  it("uses one in-flight promise for rapid duplicate confirmations", async () => {
    const auth = createAuthMock();
    let resolveUnlink: ((value: unknown) => void) | undefined;
    auth.unlinkIdentity.mockReturnValue(
      new Promise((resolve) => {
        resolveUnlink = resolve;
      }) as never,
    );
    mockedGetSupabase.mockReturnValue({ auth } as never);

    const first = unlinkGoogleIdentity("google-identity-1");
    const second = unlinkGoogleIdentity("google-identity-1");

    expect(second).toBe(first);

    resolveUnlink?.({ data: {}, error: null });

    await expect(first).resolves.toEqual({ status: "unlinked" });
    expect(auth.unlinkIdentity).toHaveBeenCalledTimes(1);
  });

  it("only permits disconnect when another connected identity remains", () => {
    const identities = [
      {
        identityId: "email-identity-1",
        provider: "email",
        createdAt: null,
        email: "person@example.com",
      },
      {
        identityId: "google-identity-1",
        provider: "google",
        createdAt: null,
        email: "google@example.com",
      },
    ];

    expect(
      canDisconnectConnectedIdentity(
        identities,
        "google-identity-1",
      ),
    ).toBe(true);
    expect(
      canDisconnectConnectedIdentity(
        [identities[1]],
        "google-identity-1",
      ),
    ).toBe(false);
    expect(
      canDisconnectConnectedIdentity(
        identities,
        "missing-identity",
      ),
    ).toBe(false);
  });
});
