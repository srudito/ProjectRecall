
import { getSupabase } from "@/src/services/supabase/client";
import { listUserIdentities } from "@/src/services/supabase/auth";

jest.mock("@/src/services/supabase/client", () => ({
  getSupabase: jest.fn(),
}));

const mockedGetSupabase = getSupabase as jest.MockedFunction<
  typeof getSupabase
>;

describe("listUserIdentities", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws AppError instead of resolving to an empty list when Supabase is not configured", async () => {
    mockedGetSupabase.mockReturnValue(null);

    // Client unavailability must enter the same safe error state as every
    // other auth.ts function (see sendPasswordReset/updatePassword), not the
    // "no identities" empty state — those are different conditions and the
    // UI must be able to tell them apart.
    await expect(listUserIdentities()).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
    });
  });

  it("returns an empty array when the account has no linked identities", async () => {
    mockedGetSupabase.mockReturnValue({
      auth: {
        getUserIdentities: jest.fn().mockResolvedValue({
          data: { identities: [] },
          error: null,
        }),
      },
    } as never);

    await expect(listUserIdentities()).resolves.toEqual([]);
  });

  it("maps a raw Supabase identity to the narrowed display-safe shape", async () => {
    mockedGetSupabase.mockReturnValue({
      auth: {
        getUserIdentities: jest.fn().mockResolvedValue({
          data: {
            identities: [
              {
                id: "row-1",
                user_id: "user-1",
                identity_id: "identity-1",
                provider: "google",
                created_at: "2026-07-01T00:00:00.000Z",
                updated_at: "2026-07-02T00:00:00.000Z",
                last_sign_in_at: "2026-07-03T00:00:00.000Z",
                identity_data: {
                  email: "person@example.com",
                  sub: "raw-google-sub",
                  picture: "https://example.com/avatar.png",
                },
              },
            ],
          },
          error: null,
        }),
      },
    } as never);

    const result = await listUserIdentities();

    expect(result).toEqual([
      {
        identityId: "identity-1",
        provider: "google",
        createdAt: "2026-07-01T00:00:00.000Z",
        email: "person@example.com",
      },
    ]);
  });

  it("returns a null email when identity_data has no email field", async () => {
    mockedGetSupabase.mockReturnValue({
      auth: {
        getUserIdentities: jest.fn().mockResolvedValue({
          data: {
            identities: [
              {
                identity_id: "identity-3",
                provider: "email",
                created_at: null,
                identity_data: {},
              },
            ],
          },
          error: null,
        }),
      },
    } as never);

    const result = await listUserIdentities();

    expect(result).toEqual([
      {
        identityId: "identity-3",
        provider: "email",
        createdAt: null,
        email: null,
      },
    ]);
  });

  it("never surfaces tokens or raw identity_data, even when the provider payload includes them", async () => {
    const dangerousIdentity = {
      id: "row-2",
      user_id: "user-2",
      identity_id: "identity-2",
      provider: "google",
      created_at: "2026-07-01T00:00:00.000Z",
      access_token: "leaked-access-token",
      refresh_token: "leaked-refresh-token",
      provider_token: "leaked-provider-token",
      provider_refresh_token: "leaked-provider-refresh-token",
      identity_data: {
        email: "person@example.com",
        access_token: "leaked-access-token",
        sub: "raw-google-sub",
      },
    };

    mockedGetSupabase.mockReturnValue({
      auth: {
        getUserIdentities: jest.fn().mockResolvedValue({
          data: { identities: [dangerousIdentity] },
          error: null,
        }),
      },
    } as never);

    const result = await listUserIdentities();

    expect(result).toHaveLength(1);

    // Exact-shape assertion: toEqual fails if the mapped object contains any
    // key beyond the four listed here, not merely if specific known token
    // fields happen to be undefined.
    expect(result).toEqual([
      {
        identityId: "identity-2",
        provider: "google",
        createdAt: "2026-07-01T00:00:00.000Z",
        email: "person@example.com",
      },
    ]);
    expect(Object.keys(result[0]).sort()).toEqual(
      ["createdAt", "email", "identityId", "provider"].sort(),
    );

    // Defense in depth: even if a future edit widened the mapper, no raw
    // token or provider-internal value may appear anywhere in the output.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("leaked-access-token");
    expect(serialized).not.toContain("leaked-refresh-token");
    expect(serialized).not.toContain("leaked-provider-token");
    expect(serialized).not.toContain("leaked-provider-refresh-token");
    expect(serialized).not.toContain("raw-google-sub");
  });

  it("throws a mapped AppError instead of the raw Supabase error", async () => {
    mockedGetSupabase.mockReturnValue({
      auth: {
        getUserIdentities: jest.fn().mockResolvedValue({
          data: null,
          error: {
            message: "session expired",
            name: "AuthError",
            status: 401,
          },
        }),
      },
    } as never);

    await expect(listUserIdentities()).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
    });
  });
});
