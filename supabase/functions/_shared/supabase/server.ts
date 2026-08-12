export type SupabaseKeyClass = "publishable" | "privileged" | "unknown";

const MAX_KEY_LENGTH = 4096;
const MIN_MODERN_KEY_SUFFIX_LENGTH = 16;
const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MODERN_PUBLISHABLE_KEY_PATTERN = new RegExp(
  `^sb_publishable_[A-Za-z0-9_-]{${MIN_MODERN_KEY_SUFFIX_LENGTH},}$`,
);
const MODERN_SECRET_KEY_PATTERN = new RegExp(
  `^sb_secret_[A-Za-z0-9_-]{${MIN_MODERN_KEY_SUFFIX_LENGTH},}$`,
);

const normalizeKey = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  if (
    value.length === 0 ||
    value.length > MAX_KEY_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
};

const decodeBase64UrlJsonObject = (
  value: string,
): Record<string, unknown> | null => {
  if (!value || !BASE64URL_SEGMENT_PATTERN.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const jwtRole = (value: string): string | null => {
  const segments = value.split(".");
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) => !segment || !BASE64URL_SEGMENT_PATTERN.test(segment),
    )
  ) {
    return null;
  }

  const header = decodeBase64UrlJsonObject(segments[0]);
  const payload = decodeBase64UrlJsonObject(segments[1]);
  if (!header || !payload || typeof header.alg !== "string") return null;

  return typeof payload.role === "string" ? payload.role : null;
};

export const classifySupabaseApiKey = (value: unknown): SupabaseKeyClass => {
  const key = normalizeKey(value);
  if (!key) return "unknown";
  if (MODERN_PUBLISHABLE_KEY_PATTERN.test(key)) return "publishable";
  if (MODERN_SECRET_KEY_PATTERN.test(key)) return "privileged";

  const role = jwtRole(key);
  if (role === "anon") return "publishable";
  if (role === "service_role") return "privileged";
  return "unknown";
};

const keyDictionaryCandidates = (value: unknown): unknown[] => {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    return Object.keys(record)
      .sort((left, right) => {
        if (left === "default") return -1;
        if (right === "default") return 1;
        return left.localeCompare(right);
      })
      .map((name) => record[name]);
  } catch {
    return [];
  }
};

export const resolvePublishableApiKey = (input: {
  publishableKeysJson?: unknown;
  publishableKey?: unknown;
  legacyAnonKey?: unknown;
}): string | null => {
  for (const candidate of [
    ...keyDictionaryCandidates(input.publishableKeysJson),
    input.publishableKey,
    input.legacyAnonKey,
  ]) {
    const normalized = normalizeKey(candidate);
    if (
      normalized &&
      classifySupabaseApiKey(normalized) === "publishable"
    ) {
      return normalized;
    }
  }
  return null;
};

export const resolvePrivilegedApiKey = (input: {
  secretKeysJson?: unknown;
  legacyServiceRoleKey?: unknown;
}): string | null => {
  for (const candidate of [
    ...keyDictionaryCandidates(input.secretKeysJson),
    input.legacyServiceRoleKey,
  ]) {
    const normalized = normalizeKey(candidate);
    if (
      normalized &&
      classifySupabaseApiKey(normalized) === "privileged"
    ) {
      return normalized;
    }
  }
  return null;
};

export const requireServerEnvironment = (
  name: string,
  value: unknown,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8192 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Missing or invalid server environment: ${name}`);
  }
  return value;
};

export const constantTimeTokenMatches = async (
  expected: string,
  supplied: string,
): Promise<boolean> => {
  const encoder = new TextEncoder();
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);

  const left = new Uint8Array(expectedDigest);
  const right = new Uint8Array(suppliedDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};
