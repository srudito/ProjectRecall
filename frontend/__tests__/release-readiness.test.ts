import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isConfiguredPublicUrl,
  isConfiguredSupportEmail,
} from "@/src/config/public-release-values";

const readFrontendJson = <T>(relativePath: string): T =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), relativePath), "utf8"),
  ) as T;

interface AppConfig {
  expo: {
    android: {
      allowBackup: boolean;
      permissions: string[];
      blockedPermissions: string[];
    };
  };
}

interface EasConfig {
  cli: { appVersionSource: string };
  build: Record<
    "development" | "preview" | "production",
    { node: string; yarn: string; autoIncrement?: boolean }
  >;
}

interface PackageConfig {
  engines: { node: string; yarn: string };
}

const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "..", relativePath), "utf8");

const encodeJwtSegment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const makeLegacySupabaseJwt = (role: string): string =>
  `${encodeJwtSegment({ alg: "HS256", typ: "JWT" })}.${encodeJwtSegment({ role })}.test-signature`;

const validProductionEnv = {
  EXPO_PUBLIC_APP_ENV: "production",
  EXPO_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  EXPO_PUBLIC_SUPABASE_ANON_KEY:
    "sb_publishable_test_public_key_for_release_checks",
  EXPO_PUBLIC_SUPPORT_EMAIL: "support@project-recall.co",
  EXPO_PUBLIC_PRIVACY_POLICY_URL: "https://project-recall.co/privacy",
  EXPO_PUBLIC_TERMS_OF_SERVICE_URL: "https://project-recall.co/terms",
};

const runProductionCheck = (overrides: Record<string, string> = {}) =>
  spawnSync(
    process.execPath,
    ["./scripts/validate-release-readiness.js", "--production"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...validProductionEnv,
        ...overrides,
      },
      encoding: "utf8",
    },
  );

const runEasCheck = (
  profile: "development" | "preview" | "production",
  overrides: Record<string, string> = {},
) =>
  spawnSync(
    process.execPath,
    ["./scripts/validate-release-readiness.js", "--eas"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...validProductionEnv,
        EAS_BUILD_PROFILE: profile,
        ...overrides,
      },
      encoding: "utf8",
    },
  );

describe("Milestone 1 release readiness configuration", () => {
  const app = readFrontendJson<AppConfig>("app.json");
  const eas = readFrontendJson<EasConfig>("eas.json");
  const pkg = readFrontendJson<PackageConfig>("package.json");

  it("disables Android backup for private local evidence", () => {
    expect(app.expo.android.allowBackup).toBe(false);
  });

  it("uses scoped pickers without broad Android media-library permissions", () => {
    const broadMediaPermissions = [
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ];

    for (const permission of broadMediaPermissions) {
      expect(app.expo.android.permissions).not.toContain(permission);
    }

    for (const permission of [
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
    ]) {
      expect(app.expo.android.blockedPermissions).toContain(permission);
    }

    for (const permission of [
      "android.permission.RECORD_AUDIO",
      "android.permission.CAMERA",
    ]) {
      expect(app.expo.android.permissions).toContain(permission);
    }
  });

  it("does not request Android media-library permission before the system picker", () => {
    const source = readRepositoryFile("frontend/app/record/active.tsx");

    expect(source).toContain('Platform.OS !== "ios"');
    expect(source).toContain("requestMediaLibraryPermissionsAsync");
    expect(source).toContain("launchImageLibraryAsync");
    expect(source).not.toMatch(
      /if \(!session\) return;\s+const perm = await ImagePicker\.requestMediaLibraryPermissionsAsync\(\)/,
    );
  });

  it("pins EAS build tools and auto-increments production builds", () => {
    for (const profileName of ["development", "preview", "production"] as const) {
      expect(eas.build[profileName]).toMatchObject({
        node: "20.19.4",
        yarn: "1.22.22",
      });
    }
    expect(eas.cli.appVersionSource).toBe("remote");
    expect(eas.build.production.autoIncrement).toBe(true);
  });

  it("pins local package-manager requirements", () => {
    expect(pkg.engines).toEqual({
      node: ">=20.19.4",
      yarn: "1.22.22",
    });
    expect(readFileSync(resolve(process.cwd(), ".nvmrc"), "utf8").trim()).toBe(
      "20.19.4",
    );
  });

  it("reads public legal values from release environment variables", () => {
    const source = readRepositoryFile("frontend/src/config/branding.ts");
    const envSource = readRepositoryFile("frontend/src/config/env.ts");

    expect(source).not.toContain("support@example.com");
    expect(source).not.toContain("https://example.com/privacy");
    expect(source).not.toContain("https://example.com/terms");
    expect(envSource).toContain("EXPO_PUBLIC_SUPPORT_EMAIL");
    expect(envSource).toContain("EXPO_PUBLIC_PRIVACY_POLICY_URL");
    expect(envSource).toContain("EXPO_PUBLIC_TERMS_OF_SERVICE_URL");
  });

  it("fails a production release check when public release values are absent", () => {
    const result = runProductionCheck({
      EXPO_PUBLIC_APP_ENV: "",
      EXPO_PUBLIC_SUPABASE_URL: "",
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "",
      EXPO_PUBLIC_SUPPORT_EMAIL: "",
      EXPO_PUBLIC_PRIVACY_POLICY_URL: "",
      EXPO_PUBLIC_TERMS_OF_SERVICE_URL: "",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Release readiness validation failed");
  });

  it("accepts a complete production public configuration", () => {
    const result = runProductionCheck();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Production release configuration is valid",
    );
  });

  it("accepts a legacy Supabase anon-role JWT", () => {
    const result = runProductionCheck({
      EXPO_PUBLIC_SUPABASE_ANON_KEY: makeLegacySupabaseJwt("anon"),
    });

    expect(result.status).toBe(0);
  });

  it.each(["development", "preview"] as const)(
    "rejects privileged Supabase keys in the %s EAS profile",
    (profile) => {
      for (const key of [
        "sb_secret_test_privileged_key",
        makeLegacySupabaseJwt("service_role"),
      ]) {
        const result = runEasCheck(profile, {
          EXPO_PUBLIC_SUPABASE_ANON_KEY: key,
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "secret and privileged keys are forbidden",
        );
        expect(result.stderr).not.toContain(key);
      }
    },
  );

  it("accepts frontend-safe Supabase keys in non-production EAS profiles", () => {
    const preview = runEasCheck("preview", {
      EXPO_PUBLIC_SUPABASE_ANON_KEY:
        "sb_publishable_test_public_key_for_release_checks",
    });
    const development = runEasCheck("development", {
      EXPO_PUBLIC_SUPABASE_ANON_KEY: makeLegacySupabaseJwt("anon"),
    });

    expect(preview.status).toBe(0);
    expect(development.status).toBe(0);
  });

  it("allows an absent Supabase key in a non-production EAS profile", () => {
    const result = runEasCheck("preview", {
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "",
    });

    expect(result.status).toBe(0);
  });

  it.each([
    "sb_secret_test_privileged_key",
    makeLegacySupabaseJwt("service_role"),
    makeLegacySupabaseJwt("authenticated"),
    "not-a-supabase-public-key",
    "malformed.jwt",
    `!!!!.${encodeJwtSegment({ role: "anon" })}.validchars`,
    `YWJj.${encodeJwtSegment({ role: "anon" })}.validchars`,
    `${encodeJwtSegment({ alg: "HS256", typ: "JWT" })}.!!!!${encodeJwtSegment({ role: "anon" })}***.validchars`,
    `${encodeJwtSegment({ alg: "HS256", typ: "JWT" })}.${encodeJwtSegment({ role: "anon" })}.***`,
    `${encodeJwtSegment({ alg: "RS256", typ: "JWT" })}.${encodeJwtSegment({ role: "anon" })}.validchars`,
  ])("rejects unsafe or malformed Supabase frontend key %s", (key) => {
    const result = runProductionCheck({
      EXPO_PUBLIC_SUPABASE_ANON_KEY: key,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "secret and privileged keys are forbidden",
    );
    expect(result.stderr).not.toContain(key);
  });

  it.each([
    "https://user:password@project-recall.co/privacy",
    "https://example.com./privacy",
    "https://sub.example.org./terms",
    "https://example/privacy",
    "https://test/terms",
    "https://invalid/privacy",
    "https://localhost./terms",
    "https://127.0.0.1/privacy",
    "https://0.0.0.0/privacy",
    "https://2130706433/privacy",
    "https://0x7f000001/privacy",
    "https://[::1]/privacy",
    "https://[0:0:0:0:0:0:0:1]/privacy",
    "https://example。com/privacy",
    "https://-project-recall.co/privacy",
    "https://project-recall-.co/privacy",
    "https://project_recall.co/privacy",
    "https://project..co/privacy",
    "https://project/privacy",
    "https://10.0.0.1/privacy",
    "https://169.254.169.254/privacy",
    "https://[::ffff:127.0.0.1]/privacy",
    "https://foo.local/privacy",
    "https://device.home.arpa/privacy",
  ])("rejects unsafe public URL %s in both runtime and build checks", (url) => {
    expect(isConfiguredPublicUrl(url)).toBe(false);

    const result = runProductionCheck({
      EXPO_PUBLIC_PRIVACY_POLICY_URL: url,
    });
    expect(result.status).not.toBe(0);
  });

  it.each([
    "support@example.com.",
    "support@localhost",
    "support@127.0.0.1",
    "mailto:support@project-recall.co",
    "support?body=hello@project-recall.co",
    ".support@project-recall.co",
    "support.@project-recall.co",
    "sup..port@project-recall.co",
    "support@-project-recall.co",
    "support@project-recall-.co",
    "support#ops@project-recall.co",
    "support%0a@project-recall.co",
    "support&ops@project-recall.co",
    "support=ops@project-recall.co",
    "support@project-recall.co。",
    "support@ project-recall.co",
    "support@\tproject-recall.co",
    "support@\nproject-recall.co",
    "support@10.0.0.1",
    "support@foo.local",
  ])("rejects unsafe support email %s in both runtime and build checks", (email) => {
    expect(isConfiguredSupportEmail(email)).toBe(false);

    const result = runProductionCheck({
      EXPO_PUBLIC_SUPPORT_EMAIL: email,
    });
    expect(result.status).not.toBe(0);
  });

  it("accepts valid runtime legal and support destinations", () => {
    expect(isConfiguredPublicUrl("https://project-recall.co/privacy")).toBe(
      true,
    );
    expect(isConfiguredSupportEmail("support@project-recall.co")).toBe(true);
    expect(isConfiguredSupportEmail("support+release@project-recall.co")).toBe(
      true,
    );
  });

  it("uses the app configuration version instead of a Milestone label", () => {
    const profileSource = readRepositoryFile(
      "frontend/app/(tabs)/profile.tsx",
    );
    const versionSource = readRepositoryFile(
      "frontend/src/config/release.ts",
    );

    expect(profileSource).toContain("getAppDisplayVersion");
    expect(profileSource).not.toContain("1.0.0 (Milestone 1)");
    expect(versionSource).toContain("Constants.expoConfig?.version");
  });
});
