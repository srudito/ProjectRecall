export interface ParsedAuthCallbackUrl {
  accessToken: string | null;
  refreshToken: string | null;
  authorizationCode: string | null;
  callbackType: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

const normalizedPath = (path: string): string =>
  path.trim().replace(/^\/+/, "");

export const buildNativeAuthRedirectUrl = (
  scheme: string,
  path: string,
): string => `${scheme}://${normalizedPath(path)}`;

/**
 * Supabase may return OAuth data in either the query string (PKCE code flow)
 * or the URL fragment (implicit token flow). Parse both so the same callback
 * handler remains compatible while the project transitions to PKCE.
 */
export const parseAuthCallbackUrl = (
  url: string,
): ParsedAuthCallbackUrl => {
  const queryStart = url.indexOf("?");
  const hashStart = url.indexOf("#");

  const queryEnd =
    queryStart >= 0 && hashStart > queryStart ? hashStart : url.length;

  const query =
    queryStart >= 0
      ? url.slice(queryStart + 1, queryEnd)
      : "";

  const fragment = hashStart >= 0 ? url.slice(hashStart + 1) : "";

  const combined = new URLSearchParams(query);
  const fragmentParams = new URLSearchParams(fragment);

  fragmentParams.forEach((value, key) => {
    if (!combined.has(key)) {
      combined.set(key, value);
    }
  });

  return {
    accessToken: combined.get("access_token"),
    refreshToken: combined.get("refresh_token"),
    authorizationCode: combined.get("code"),
    callbackType: combined.get("type"),
    errorCode:
      combined.get("error_code") ??
      combined.get("error"),
    errorDescription:
      combined.get("error_description") ??
      combined.get("error_message"),
  };
};
