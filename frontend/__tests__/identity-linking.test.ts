import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";

import {
  getAuthRedirectUrl,
  hasConnectedProvider,
  linkGoogleIdentity,
  waitForGoogleIdentityLinkCompletion,
} from "@/src/services/supabase/auth";
import { getSupabase } from "@/src/services/supabase/client";

jest.mock("expo-linking", () => ({
  createURL: jest.fn((path: string) => `https://app.example/${path}`),
}));

jest.mock("expo-web-browser", () => ({
  openAuthSessionAsync: jest.fn(),
}));

jest.mock("@/src/services/supabase/client", () => ({
  getSupabase: jest.fn(),
}));

const mockedGetSupabase = getSupabase as jest.MockedFunction<
  typeof getSupabase
>;
const mockedOpenAuthSessionAsync =
  WebBrowser.openAuthSessionAsync as jest.MockedFunction<
    typeof WebBrowser.openAuthSessionAsync
  >;

const googleIdentity = {
  identity_id: "google-identity-1",
  provider: "google",
  created_at: "2026-08-01T00:00:00.000Z",
  identity_data: { email: "person@example.com" },
};

const emptyIdentities = {
  data: { identities: [] },
  error: null,
};

const linkedIdentities = {
  data: { identities: [googleIdentity] },
  error: null,
};

const originalSession = {
  access_token: "original-access",
  refresh_token: "original-refresh",
  user: { id: "user-1" },
};

const linkedSession = {
  access_token: "linked-access",
  refresh_token: "linked-refresh",
  user: { id: "user-1" },
};

function createAuthMock() {
  return {
    getSession: jest.fn().mockResolvedValue({
      data: { session: originalSession },
      error: null,
    }),
    getUser: jest.fn().mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    }),
    getUserIdentities: jest
      .fn()
      .mockResolvedValueOnce(emptyIdentities)
      .mockResolvedValue(linkedIdentities),
    linkIdentity: jest.fn().mockResolvedValue({
      data: { provider: "google", url: "https://accounts.example/link" },
      error: null,
    }),
    exchangeCodeForSession: jest.fn().mockResolvedValue({
      data: { session: linkedSession, user: linkedSession.user },
      error: null,
    }),
    setSession: jest.fn().mockResolvedValue({
      data: { session: originalSession, user: originalSession.user },
      error: null,
    }),
  };
}

describe("Google identity linking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Linking.createURL as jest.Mock).mockImplementation(
      (path: string) => `https://app.example/${path}`,
    );
    mockedOpenAuthSessionAsync.mockResolvedValue({
      type: "success",
      url: "projectrecall://auth/link-callback?code=single-use-code",
    });
  });

  it("returns only a safe status and exchanges the dedicated callback code once", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);

    const result = await linkGoogleIdentity();

    expect(result).toEqual({ status: "linked" });
    expect(Object.keys(result)).toEqual(["status"]);

    const linkCall = auth.linkIdentity.mock.calls[0]?.[0] as {
      options: { redirectTo: string };
    };
    const redirectTo = linkCall.options.redirectTo;

    expect(auth.linkIdentity).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: expect.stringMatching(/auth\/link-callback$/),
        skipBrowserRedirect: true,
        queryParams: { prompt: "select_account" },
      },
    });
    expect(mockedOpenAuthSessionAsync).toHaveBeenCalledWith(
      "https://accounts.example/link",
      redirectTo,
    );
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith(
      "single-use-code",
    );
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it("does not start OAuth when Google is already connected", async () => {
    const auth = createAuthMock();
    auth.getUserIdentities.mockReset();
    auth.getUserIdentities.mockResolvedValue(linkedIdentities);
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(linkGoogleIdentity()).resolves.toEqual({
      status: "linked",
    });

    expect(auth.linkIdentity).not.toHaveBeenCalled();
    expect(mockedOpenAuthSessionAsync).not.toHaveBeenCalled();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("treats browser cancellation as a non-fatal result", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);
    mockedOpenAuthSessionAsync.mockResolvedValue({
      type: "cancel",
    } as Awaited<ReturnType<typeof WebBrowser.openAuthSessionAsync>>);

    await expect(linkGoogleIdentity()).resolves.toEqual({
      status: "cancelled",
    });

    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("maps a direct identity conflict without exposing another account", async () => {
    const auth = createAuthMock();
    auth.getUserIdentities.mockReset();
    auth.getUserIdentities.mockResolvedValue(emptyIdentities);
    auth.linkIdentity.mockResolvedValue({
      data: null,
      error: {
        name: "AuthApiError",
        message: "Identity already exists",
        code: "identity_already_exists",
        status: 422,
      },
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(linkGoogleIdentity()).resolves.toEqual({
      status: "alreadyLinkedElsewhere",
    });

    expect(mockedOpenAuthSessionAsync).not.toHaveBeenCalled();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("maps an exchange-time identity conflict to the same safe result", async () => {
    const auth = createAuthMock();
    auth.getUserIdentities.mockReset();
    auth.getUserIdentities.mockResolvedValue(emptyIdentities);
    auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null },
      error: {
        name: "AuthApiError",
        message: "Identity already linked",
        code: "identity_already_exists",
        status: 422,
      },
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(linkGoogleIdentity()).resolves.toEqual({
      status: "alreadyLinkedElsewhere",
    });

    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it("maps disabled manual linking to a stable app error", async () => {
    const auth = createAuthMock();
    auth.linkIdentity.mockResolvedValue({
      data: null,
      error: {
        name: "AuthApiError",
        message: "Manual linking is disabled",
        code: "manual_linking_disabled",
        status: 422,
      },
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(linkGoogleIdentity()).rejects.toMatchObject({
      code: "AUTH_IDENTITY_LINK_NOT_CONFIGURED",
    });
  });

  it("restores the original session if the callback returns another user", async () => {
    const auth = createAuthMock();
    auth.exchangeCodeForSession.mockResolvedValue({
      data: {
        session: {
          access_token: "unexpected-access",
          refresh_token: "unexpected-refresh",
          user: { id: "user-2" },
        },
        user: { id: "user-2" },
      },
      error: null,
    });
    mockedGetSupabase.mockReturnValue({ auth } as never);

    await expect(linkGoogleIdentity()).rejects.toMatchObject({
      code: "AUTH_IDENTITY_LINK_SESSION_CHANGED",
    });

    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(auth.setSession).toHaveBeenCalledWith({
      access_token: "original-access",
      refresh_token: "original-refresh",
    });
  });

  it("rejects a callback that does not contain a PKCE code", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);
    mockedOpenAuthSessionAsync.mockResolvedValue({
      type: "success",
      url: "projectrecall://auth/link-callback",
    });

    await expect(linkGoogleIdentity()).rejects.toMatchObject({
      code: "AUTH_OAUTH_CALLBACK_INVALID",
    });

    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("lets a remounted Profile wait for the active single-flight operation", async () => {
    const auth = createAuthMock();
    let resolveLink: ((value: unknown) => void) | undefined;
    auth.linkIdentity.mockReturnValue(
      new Promise((resolve) => {
        resolveLink = resolve;
      }) as never,
    );
    mockedGetSupabase.mockReturnValue({ auth } as never);

    const linking = linkGoogleIdentity();
    const profileWait = waitForGoogleIdentityLinkCompletion();

    let profileWaitFinished = false;
    void profileWait.then(() => {
      profileWaitFinished = true;
    });
    await Promise.resolve();
    expect(profileWaitFinished).toBe(false);

    resolveLink?.({
      data: { provider: "google", url: "https://accounts.example/link" },
      error: null,
    });

    await expect(linking).resolves.toEqual({ status: "linked" });
    await expect(profileWait).resolves.toBeUndefined();
  });

  it("uses one in-flight promise for concurrent presses and code exchange", async () => {
    const auth = createAuthMock();
    let resolveLink: ((value: unknown) => void) | undefined;
    auth.linkIdentity.mockReturnValue(
      new Promise((resolve) => {
        resolveLink = resolve;
      }) as never,
    );
    mockedGetSupabase.mockReturnValue({ auth } as never);

    const first = linkGoogleIdentity();
    const second = linkGoogleIdentity();

    expect(second).toBe(first);

    resolveLink?.({
      data: { provider: "google", url: "https://accounts.example/link" },
      error: null,
    });

    await expect(first).resolves.toEqual({ status: "linked" });
    expect(auth.linkIdentity).toHaveBeenCalledTimes(1);
    expect(mockedOpenAuthSessionAsync).toHaveBeenCalledTimes(1);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it("treats an access-denied callback as cancellation", async () => {
    const auth = createAuthMock();
    mockedGetSupabase.mockReturnValue({ auth } as never);
    mockedOpenAuthSessionAsync.mockResolvedValue({
      type: "success",
      url: "projectrecall://auth/link-callback?error=access_denied&error_description=User%20cancelled",
    });

    await expect(linkGoogleIdentity()).resolves.toEqual({
      status: "cancelled",
    });

    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("builds dedicated native and web redirect URLs", () => {
    expect(
      getAuthRedirectUrl("auth/link-callback", "android"),
    ).toBe("projectrecall://auth/link-callback");
    expect(
      getAuthRedirectUrl("auth/link-callback", "web"),
    ).toBe("https://app.example/auth/link-callback");
  });

  it("detects connected providers without inspecting raw identity data", () => {
    expect(
      hasConnectedProvider(
        [
          {
            identityId: "email-1",
            provider: "email",
            createdAt: null,
            email: "person@example.com",
          },
          {
            identityId: "google-1",
            provider: "google",
            createdAt: null,
            email: "person@example.com",
          },
        ],
        "google",
      ),
    ).toBe(true);
  });
});
