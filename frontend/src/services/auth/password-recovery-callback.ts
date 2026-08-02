import { parseAuthCallbackUrl } from "@/src/services/auth/oauth-utils";

export type PasswordRecoveryRouteParams = Partial<
  Record<
    | "code"
    | "type"
    | "error"
    | "error_code"
    | "error_description"
    | "error_message"
    | "access_token"
    | "refresh_token"
    | "#",
    string | string[]
  >
>;

const firstString = (
  value: string | string[] | undefined,
): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.find((item) => typeof item === "string") ?? null;
  }
  return null;
};

const RECOVERY_QUERY_KEYS = [
  "code",
  "type",
  "error",
  "error_code",
  "error_description",
  "error_message",
  "access_token",
  "refresh_token",
] as const;

/**
 * Expo Router can expose callback query parameters even when expo-linking
 * initially reports only the bare route. Rebuild a callback URL from those
 * route-local parameters without logging or persisting any credential.
 */
export const buildPasswordRecoveryCallbackUrl = (
  baseUrl: string,
  params: PasswordRecoveryRouteParams,
): string | null => {
  const query = new URLSearchParams();

  for (const key of RECOVERY_QUERY_KEYS) {
    const value = firstString(params[key]);
    if (value) query.set(key, value);
  }

  const hash = firstString(params["#"]);
  const queryString = query.toString();
  const candidate = `${baseUrl}${queryString ? `?${queryString}` : ""}${
    hash ? `#${hash.replace(/^#/, "")}` : ""
  }`;

  return isActionablePasswordRecoveryCallbackUrl(candidate)
    ? candidate
    : null;
};

export const isActionablePasswordRecoveryCallbackUrl = (
  url: string | null | undefined,
): url is string => {
  if (!url) return false;

  const parsed = parseAuthCallbackUrl(url);
  return Boolean(
    parsed.authorizationCode ||
      parsed.errorCode ||
      (parsed.accessToken && parsed.refreshToken),
  );
};

export const selectPasswordRecoveryCallbackUrl = (
  ...candidates: Array<string | null | undefined>
): string | null =>
  candidates.find(isActionablePasswordRecoveryCallbackUrl) ?? null;

/**
 * Use a credential-derived in-memory key so Expo Router and expo-linking can
 * present the same callback with different query ordering without consuming a
 * single-use PKCE code twice. The key is never persisted or logged.
 */
export const getPasswordRecoveryCallbackKey = (
  url: string,
): string | null => {
  const parsed = parseAuthCallbackUrl(url);

  if (parsed.authorizationCode) {
    return `code:${parsed.authorizationCode}`;
  }

  if (parsed.accessToken && parsed.refreshToken) {
    return `session:${parsed.accessToken}:${parsed.refreshToken}`;
  }

  if (parsed.errorCode) {
    return `error:${parsed.errorCode}:${parsed.errorDescription ?? ""}`;
  }

  return null;
};
