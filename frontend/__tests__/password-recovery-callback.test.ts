import {
  buildPasswordRecoveryCallbackUrl,
  getPasswordRecoveryCallbackKey,
  isActionablePasswordRecoveryCallbackUrl,
  isPasswordRecoveryCallbackRoute,
  selectPasswordRecoveryCallbackUrl,
} from "@/src/services/auth/password-recovery-callback";

describe("password recovery callback capture", () => {
  it("rebuilds a PKCE callback from Expo Router search parameters", () => {
    expect(
      buildPasswordRecoveryCallbackUrl(
        "projectrecall://auth/reset",
        {
          code: "recovery-code",
          type: "recovery",
        },
      ),
    ).toBe(
      "projectrecall://auth/reset?code=recovery-code&type=recovery",
    );
  });

  it("keeps waiting when Expo Router only exposes the bare route", () => {
    expect(
      buildPasswordRecoveryCallbackUrl(
        "projectrecall://auth/reset",
        {},
      ),
    ).toBeNull();
    expect(
      isActionablePasswordRecoveryCallbackUrl(
        "projectrecall://auth/reset",
      ),
    ).toBe(false);
  });

  it("accepts an explicit Supabase callback error for safe mapping", () => {
    const url = buildPasswordRecoveryCallbackUrl(
      "projectrecall://auth/reset",
      {
        error: "access_denied",
        error_code: "otp_expired",
        error_description: "Email link expired",
      },
    );

    expect(url).toContain("error_code=otp_expired");
    expect(isActionablePasswordRecoveryCallbackUrl(url)).toBe(true);
  });

  it("selects a later full callback instead of an earlier bare route", () => {
    expect(
      selectPasswordRecoveryCallbackUrl(
        "projectrecall://auth/reset",
        null,
        "projectrecall://auth/reset?code=latest-code&type=recovery",
      ),
    ).toBe(
      "projectrecall://auth/reset?code=latest-code&type=recovery",
    );
  });

  it("deduplicates equivalent callback URLs by their one-time code", () => {
    const first = getPasswordRecoveryCallbackKey(
      "projectrecall://auth/reset?code=same-code&type=recovery",
    );
    const second = getPasswordRecoveryCallbackKey(
      "projectrecall://auth/reset?type=recovery&code=same-code",
    );

    expect(first).toBe(second);
  });

  it("reconstructs an implicit fragment without exposing it elsewhere", () => {
    const url = buildPasswordRecoveryCallbackUrl(
      "projectrecall://auth/reset",
      {
        "#": "access_token=a&refresh_token=b&type=recovery",
      },
    );

    expect(url).toBe(
      "projectrecall://auth/reset#access_token=a&refresh_token=b&type=recovery",
    );
    expect(isActionablePasswordRecoveryCallbackUrl(url)).toBe(true);
  });
  it("accepts only the dedicated native and web recovery routes", () => {
    expect(
      isPasswordRecoveryCallbackRoute(
        "projectrecall://auth/reset?code=recovery-code",
      ),
    ).toBe(true);
    expect(
      isPasswordRecoveryCallbackRoute(
        "https://app.example/auth/reset?code=recovery-code",
      ),
    ).toBe(true);
    expect(
      isPasswordRecoveryCallbackRoute(
        "projectrecall://auth/callback?code=sign-in-code",
      ),
    ).toBe(false);
    expect(
      isPasswordRecoveryCallbackRoute(
        "projectrecall://auth/link-callback?code=link-code",
      ),
    ).toBe(false);
  });

  it("ignores actionable-looking codes from other auth routes", () => {
    expect(
      isActionablePasswordRecoveryCallbackUrl(
        "projectrecall://auth/callback?code=sign-in-code",
      ),
    ).toBe(false);
    expect(
      isActionablePasswordRecoveryCallbackUrl(
        "projectrecall://auth/link-callback?code=link-code",
      ),
    ).toBe(false);
  });
});
