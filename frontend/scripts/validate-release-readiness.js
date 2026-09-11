#!/usr/bin/env node
/* global __dirname, Buffer */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
const readText = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const app = readJson("app.json");
const {
  resolveProjectRecallConfig,
  systemAlertWindowPermission,
} = require("../app.config.js");
const eas = readJson("eas.json");
const pkg = readJson("package.json");
const nvmrc = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
const transcriptionRelease = readText("src/config/transcription-release.ts");
const errors = [];

const fail = (message) => errors.push(message);
const easCheck = process.argv.includes("--eas");
const easBuildProfile =
  typeof process.env.EAS_BUILD_PROFILE === "string"
    ? process.env.EAS_BUILD_PROFILE.trim()
    : "";
const publicAppEnvironment =
  typeof process.env.EXPO_PUBLIC_APP_ENV === "string"
    ? process.env.EXPO_PUBLIC_APP_ENV.trim().toLowerCase()
    : "";
const configuredEasEnvironment =
  easBuildProfile &&
  typeof eas.build?.[easBuildProfile]?.environment === "string"
    ? eas.build[easBuildProfile].environment.trim().toLowerCase()
    : "";
const production =
  process.argv.includes("--production") ||
  (easCheck &&
    (easBuildProfile === "production" ||
      configuredEasEnvironment === "production" ||
      publicAppEnvironment === "production"));

const expectedNode = "20.19.4";
const expectedYarn = "1.22.22";
const forbiddenExplicitPermissions = [
  "android.permission.READ_MEDIA_AUDIO",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  systemAlertWindowPermission,
];
const requiredBlockedPermissions = [
  "android.permission.READ_MEDIA_AUDIO",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];
const requiredPermissions = [
  "android.permission.RECORD_AUDIO",
  "android.permission.CAMERA",
];

const productionMutationApproval =
  /export const TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED\s*=\s*false\s*;/;
if (!productionMutationApproval.test(transcriptionRelease)) {
  fail(
    "Production transcription mutations must remain source-locked until the separate live rollout gate is approved.",
  );
}

for (const relativePath of [
  "src/services/transcription/feature-availability.ts",
  "src/services/transcription/service.ts",
  "src/services/sync/transcription-request-worker.ts",
  "src/services/sync/transcript-edit-worker.ts",
  "src/services/sync/ProjectSyncCoordinator.tsx",
  "app/session/[id].tsx",
]) {
  const source = readText(relativePath);
  if (!source.includes("isTranscriptionMutationReleased")) {
    fail(
      `${relativePath} must enforce the production transcription mutation lock.`,
    );
  }
}

if (
  !transcriptionRelease.includes('normalized === "development"') ||
  !transcriptionRelease.includes('normalized === "preview"') ||
  !transcriptionRelease.includes('normalized === "production"')
) {
  fail(
    "The transcription mutation release gate must explicitly allow development/preview and fail closed for production.",
  );
}

if (app.expo?.android?.allowBackup !== false) {
  fail("expo.android.allowBackup must be false.");
}

const declaredPermissions = new Set(app.expo?.android?.permissions ?? []);
const blockedPermissions = new Set(app.expo?.android?.blockedPermissions ?? []);
const resolvedProductionApp = resolveProjectRecallConfig(app.expo ?? {}, {
  EAS_BUILD_PROFILE: "production",
  EXPO_PUBLIC_APP_ENV: "production",
});
const resolvedProductionBlockedPermissions = new Set(
  resolvedProductionApp.android?.blockedPermissions ?? [],
);
const resolvedNonProductionBlockedPermissions = ["development", "preview"].map(
  (profileName) =>
    new Set(
      resolveProjectRecallConfig(app.expo ?? {}, {
        EAS_BUILD_PROFILE: profileName,
        EXPO_PUBLIC_APP_ENV: profileName,
      }).android?.blockedPermissions ?? [],
    ),
);

for (const permission of forbiddenExplicitPermissions) {
  if (declaredPermissions.has(permission)) {
    fail(`${permission} must not be declared explicitly.`);
  }
}

for (const permission of requiredBlockedPermissions) {
  if (!blockedPermissions.has(permission)) {
    fail(`${permission} must be blocked explicitly.`);
  }
}

if (blockedPermissions.has(systemAlertWindowPermission)) {
  fail(
    `${systemAlertWindowPermission} must be applied through the production-only app.config.js rule.`,
  );
}

if (!resolvedProductionBlockedPermissions.has(systemAlertWindowPermission)) {
  fail(`${systemAlertWindowPermission} must be blocked in production config.`);
}

for (const nonProductionBlockedPermissions of resolvedNonProductionBlockedPermissions) {
  if (nonProductionBlockedPermissions.has(systemAlertWindowPermission)) {
    fail(
      `${systemAlertWindowPermission} must remain production-only to preserve non-production build behavior.`,
    );
  }
}

for (const permission of requiredPermissions) {
  if (!declaredPermissions.has(permission)) {
    fail(`${permission} is required by a current Milestone 1 feature.`);
  }
}

for (const profileName of [
  "development",
  "preview",
  "production",
  "production-canary",
]) {
  const profile = eas.build?.[profileName];
  if (profile?.node !== expectedNode) {
    fail(`EAS profile ${profileName} must pin Node ${expectedNode}.`);
  }
  if (profile?.yarn !== expectedYarn) {
    fail(`EAS profile ${profileName} must pin Yarn ${expectedYarn}.`);
  }
}

if (eas.cli?.appVersionSource !== "remote") {
  fail('eas.cli.appVersionSource must be "remote".');
}

if (eas.build?.production?.environment !== "production") {
  fail('Production EAS builds must use the "production" environment.');
}

if (eas.build?.production?.autoIncrement !== true) {
  fail("Production EAS builds must enable autoIncrement.");
}

const productionCanaryProfile = eas.build?.["production-canary"];
if (productionCanaryProfile?.distribution !== "internal") {
  fail('The production-canary EAS profile must use internal distribution.');
}
if (productionCanaryProfile?.environment !== "production") {
  fail('The production-canary EAS profile must use the "production" environment.');
}
if (productionCanaryProfile?.android?.buildType !== "apk") {
  fail("The production-canary EAS profile must build an Android APK.");
}
if (productionCanaryProfile?.autoIncrement !== true) {
  fail("The production-canary EAS profile must enable autoIncrement.");
}
if (productionCanaryProfile?.developmentClient === true) {
  fail(
    "The production-canary EAS profile must not create a development client.",
  );
}
if (eas.submit?.["production-canary"] !== undefined) {
  fail(
    "The production-canary gate must not define a matching submit profile.",
  );
}

if (pkg.engines?.node !== ">=20.19.4") {
  fail("package.json must require Node >=20.19.4.");
}

if (pkg.engines?.yarn !== expectedYarn) {
  fail(`package.json must pin Yarn ${expectedYarn}.`);
}

if (nvmrc !== expectedNode) {
  fail(`.nvmrc must pin Node ${expectedNode}.`);
}

if (app.expo?.version !== pkg.version) {
  fail("app.json and package.json user-facing versions must match.");
}

const unicodeDotPattern = /[\u3002\uff0e\uff61]/;

const normalizeHostname = (hostname) => hostname.trim().toLowerCase();

const hasSpecialUseSuffix = (hostname, suffix) =>
  hostname === suffix || hostname.endsWith(`.${suffix}`);

const isReservedPublicHostname = (hostname) =>
  hostname === "example.com" ||
  hostname.endsWith(".example.com") ||
  hostname === "example.org" ||
  hostname.endsWith(".example.org") ||
  hostname === "example.net" ||
  hostname.endsWith(".example.net") ||
  hasSpecialUseSuffix(hostname, "localhost") ||
  hasSpecialUseSuffix(hostname, "local") ||
  hasSpecialUseSuffix(hostname, "home.arpa") ||
  hasSpecialUseSuffix(hostname, "example") ||
  hasSpecialUseSuffix(hostname, "test") ||
  hasSpecialUseSuffix(hostname, "invalid");

const isValidDomainLabel = (label) =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);

const isPublicDnsHostname = (hostname) => {
  const normalized = normalizeHostname(hostname);
  if (
    !normalized ||
    unicodeDotPattern.test(normalized) ||
    normalized.endsWith(".") ||
    normalized.includes(":")
  ) {
    return false;
  }

  const labels = normalized.split(".");
  const topLevelDomain = labels[labels.length - 1] ?? "";

  return (
    normalized.length <= 253 &&
    labels.length >= 2 &&
    labels.every(isValidDomainLabel) &&
    !/^\d+$/.test(topLevelDomain) &&
    !isReservedPublicHostname(normalized)
  );
};

const getHttpsHostname = (value) => {
  const normalized = value.trim();
  if (
    !normalized ||
    /\s/.test(normalized) ||
    normalized.includes("\\") ||
    unicodeDotPattern.test(normalized)
  ) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      !parsed.hostname
    ) {
      return null;
    }

    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
};

const isConfiguredPublicUrl = (value) => {
  const hostname = getHttpsHostname(value);
  return hostname !== null && isPublicDnsHostname(hostname);
};

const isConfiguredSupportEmail = (value) => {
  const normalized = value.trim();
  const match = /^([^@]+)@([^@]+)$/.exec(normalized);
  if (!match || normalized.length > 254) return false;

  const localPart = match[1];
  const rawDomain = match[2];

  if (
    localPart.length === 0 ||
    localPart.length > 64 ||
    !/^[a-z0-9._+-]+$/i.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    rawDomain !== rawDomain.trim() ||
    unicodeDotPattern.test(rawDomain)
  ) {
    return false;
  }

  return isPublicDnsHostname(rawDomain);
};

const base64UrlSegmentPattern = /^[A-Za-z0-9_-]+$/;

const isValidBase64UrlSegment = (segment) =>
  base64UrlSegmentPattern.test(segment) && segment.length % 4 !== 1;

const decodeBase64UrlJson = (segment) => {
  if (!isValidBase64UrlSegment(segment)) return null;

  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

const isFrontendSafeSupabaseKey = (value) => {
  const key = value.trim();
  if (!key || /YOUR_|PLACEHOLDER|REPLACE(?:_ME)?/i.test(key)) return false;
  if (/^sb_secret_/i.test(key)) return false;

  if (/^sb_publishable_[A-Za-z0-9._-]{12,}$/.test(key)) {
    return true;
  }

  const parts = key.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => !isValidBase64UrlSegment(part))
  ) {
    return false;
  }

  const header = decodeBase64UrlJson(parts[0]);
  const payload = decodeBase64UrlJson(parts[1]);

  return header?.alg === "HS256" && payload?.role === "anon";
};

const validateHttpsUrl = (name, value) => {
  if (!value) {
    fail(`${name} is required for a production build.`);
    return;
  }

  if (!isConfiguredPublicUrl(value)) {
    fail(
      `${name} must be a credential-free HTTPS URL using a non-reserved, non-loopback hostname.`,
    );
  }
};

const validateSupportEmail = (value) => {
  if (!value) {
    fail("EXPO_PUBLIC_SUPPORT_EMAIL is required for a production build.");
    return;
  }

  if (!isConfiguredSupportEmail(value)) {
    fail(
      "EXPO_PUBLIC_SUPPORT_EMAIL must be a valid non-reserved public email address.",
    );
  }
};

const validateRunningNode = () => {
  const runningNode = process.versions.node;
  const [major, minor, patch] = runningNode.split(".").map(Number);
  const supported =
    major > 20 ||
    (major === 20 && (minor > 19 || (minor === 19 && patch >= 4)));

  if (!supported) {
    fail(
      `Release checks require Node >=20.19.4; current Node is ${runningNode}.`,
    );
  }
};

if (production || easCheck) {
  validateRunningNode();
}

const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
if (anonKey && !isFrontendSafeSupabaseKey(anonKey)) {
  fail(
    "EXPO_PUBLIC_SUPABASE_ANON_KEY must contain a Supabase publishable key or legacy anon-role JWT; secret and privileged keys are forbidden.",
  );
}

if (production) {
  if (process.env.EXPO_PUBLIC_APP_ENV !== "production") {
    fail('EXPO_PUBLIC_APP_ENV must equal "production".');
  }

  validateHttpsUrl(
    "EXPO_PUBLIC_SUPABASE_URL",
    process.env.EXPO_PUBLIC_SUPABASE_URL,
  );

  if (!anonKey) {
    fail("EXPO_PUBLIC_SUPABASE_ANON_KEY is required for a production build.");
  }

  validateSupportEmail(process.env.EXPO_PUBLIC_SUPPORT_EMAIL);
  validateHttpsUrl(
    "EXPO_PUBLIC_PRIVACY_POLICY_URL",
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
  );
  validateHttpsUrl(
    "EXPO_PUBLIC_TERMS_OF_SERVICE_URL",
    process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL,
  );
}

if (errors.length > 0) {
  console.error("Release readiness validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  production
    ? "Production release configuration is valid."
    : "Static release configuration is valid.",
);
