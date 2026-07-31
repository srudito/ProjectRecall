import {
  buildNativeAuthRedirectUrl,
  parseAuthCallbackUrl,
} from "@/src/services/auth/oauth-utils";

describe("OAuth callback utilities", () => {
  it("builds a native callback using the configured scheme", () => {
    expect(
      buildNativeAuthRedirectUrl(
        "projectrecall",
        "/auth/callback",
      ),
    ).toBe("projectrecall://auth/callback");
  });

  it("parses implicit-flow tokens from the URL fragment", () => {
    const parsed = parseAuthCallbackUrl(
      "projectrecall://auth/callback#access_token=access-123&refresh_token=refresh-456&type=signup",
    );

    expect(parsed).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      authorizationCode: null,
      callbackType: "signup",
      errorCode: null,
      errorDescription: null,
    });
  });

  it("parses a PKCE authorization code from the query string", () => {
    const parsed = parseAuthCallbackUrl(
      "projectrecall://auth/callback?code=pkce-code-123&type=recovery",
    );

    expect(parsed.authorizationCode).toBe("pkce-code-123");
    expect(parsed.callbackType).toBe("recovery");
    expect(parsed.accessToken).toBeNull();
  });

  it("prefers query parameters when the same key exists in the fragment", () => {
    const parsed = parseAuthCallbackUrl(
      "https://example.test/auth/callback?code=query-code#code=fragment-code",
    );

    expect(parsed.authorizationCode).toBe("query-code");
  });

  it("parses provider errors without throwing or logging callback credentials", () => {
    const parsed = parseAuthCallbackUrl(
      "projectrecall://auth/callback?error=access_denied&error_description=User%20cancelled",
    );

    expect(parsed.errorCode).toBe("access_denied");
    expect(parsed.errorDescription).toBe("User cancelled");
  });
});
