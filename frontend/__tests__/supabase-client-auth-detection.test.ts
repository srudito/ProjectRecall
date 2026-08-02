import { shouldDetectSessionInUrl } from "@/src/services/supabase/client";

describe("Supabase web auth URL detection", () => {
  it("keeps automatic detection enabled for the normal sign-in callback", () => {
    expect(
      shouldDetectSessionInUrl("web", "/auth/callback"),
    ).toBe(true);
  });

  it("disables automatic PKCE exchange on the identity-link callback", () => {
    expect(
      shouldDetectSessionInUrl("web", "/auth/link-callback"),
    ).toBe(false);
    expect(
      shouldDetectSessionInUrl("web", "/auth/link-callback/"),
    ).toBe(false);
  });

  it("never auto-detects callback sessions on native platforms", () => {
    expect(
      shouldDetectSessionInUrl("android", "/auth/link-callback"),
    ).toBe(false);
    expect(
      shouldDetectSessionInUrl("ios", "/auth/callback"),
    ).toBe(false);
  });
});
