// Auth service. Wraps Supabase email/password and OAuth flows, then translates
// provider errors into stable application error codes.

import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import type {
  AuthError,
  Session,
  User,
} from "@supabase/supabase-js";

import { branding } from "@/src/config/branding";
import { AppError, ErrorCode } from "@/src/domain/errors";
import {
  buildNativeAuthRedirectUrl,
  parseAuthCallbackUrl,
} from "@/src/services/auth/oauth-utils";

import { getSupabase } from "./client";

const mapAuthError = (
  error: AuthError | null,
  fallbackCode: keyof typeof ErrorCode = ErrorCode.UNKNOWN_ERROR,
): AppError | null => {
  if (!error) return null;

  const message = error.message.toLowerCase();

  if (
    message.includes("invalid login credentials") ||
    message.includes("invalid credentials")
  ) {
    return new AppError(
      ErrorCode.AUTH_INVALID_CREDENTIALS,
      error.message,
      error,
    );
  }

  if (
    message.includes("email not confirmed") ||
    message.includes("not verified")
  ) {
    return new AppError(
      ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
      error.message,
      error,
    );
  }

  if (
    message.includes("provider is not enabled") ||
    message.includes("unsupported provider") ||
    message.includes("provider not found")
  ) {
    return new AppError(
      ErrorCode.AUTH_OAUTH_PROVIDER_NOT_CONFIGURED,
      error.message,
      error,
    );
  }

  if (message.includes("session")) {
    return new AppError(
      ErrorCode.AUTH_SESSION_EXPIRED,
      error.message,
      error,
    );
  }

  return new AppError(
    fallbackCode,
    error.message,
    error,
  );
};

const normalizedAuthErrorCode = (error: AuthError | null): string => {
  const code = (error as (AuthError & { code?: string }) | null)?.code;
  return typeof code === "string" ? code.toLowerCase() : "";
};

const isIdentityLinkConflict = (
  code: string | null | undefined,
  message: string | null | undefined,
): boolean => {
  const normalizedCode = code?.toLowerCase() ?? "";
  const normalizedMessage = message?.toLowerCase() ?? "";

  return (
    normalizedCode === "identity_already_exists" ||
    normalizedCode === "conflict" ||
    normalizedMessage.includes("identity already exists") ||
    normalizedMessage.includes("already linked") ||
    normalizedMessage.includes("already associated")
  );
};

const mapIdentityLinkError = (error: AuthError | null): AppError | null => {
  if (!error) return null;

  const code = normalizedAuthErrorCode(error);
  const message = error.message.toLowerCase();

  if (
    code === "manual_linking_disabled" ||
    message.includes("manual linking")
  ) {
    return new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_NOT_CONFIGURED,
      error.message,
      error,
    );
  }

  if (
    code === "provider_disabled" ||
    code === "oauth_provider_not_supported" ||
    message.includes("provider is not enabled")
  ) {
    return new AppError(
      ErrorCode.AUTH_OAUTH_PROVIDER_NOT_CONFIGURED,
      error.message,
      error,
    );
  }

  return mapAuthError(error, ErrorCode.AUTH_IDENTITY_LINK_FAILED);
};

export interface AuthResult {
  session: Session | null;
  user: User | null;
}

export type OAuthSignInResult =
  | {
      status: "authenticated";
      session: Session;
      user: User;
    }
  | {
      status: "cancelled";
    };

const callbackPromises = new Map<
  string,
  Promise<AuthResult>
>();
const completedCallbackUrls = new Set<string>();

const rememberCompletedCallback = (url: string): void => {
  completedCallbackUrls.add(url);

  // Keep the in-memory replay guard bounded. Callback URLs can contain
  // short-lived credentials, so they must never be persisted or logged.
  while (completedCallbackUrls.size > 10) {
    const oldest = completedCallbackUrls.values().next().value;
    if (typeof oldest !== "string") break;
    completedCallbackUrls.delete(oldest);
  }
};

export const getAuthRedirectUrl = (
  path: "auth/callback" | "auth/reset" | "auth/link-callback",
  platform: string = Platform.OS,
): string => {
  if (platform === "web") {
    return Linking.createURL(path);
  }

  return buildNativeAuthRedirectUrl(
    branding.deepLinkScheme,
    path,
  );
};

export const signUpWithEmail = async (
  email: string,
  password: string,
  displayName?: string,
): Promise<AuthResult> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: getAuthRedirectUrl("auth/callback"),
      data: displayName
        ? { display_name: displayName }
        : undefined,
    },
  });

  const appError = mapAuthError(error);
  if (appError) throw appError;

  return {
    session: data.session,
    user: data.user,
  };
};

export const signInWithEmail = async (
  email: string,
  password: string,
): Promise<AuthResult> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const { data, error } =
    await supabase.auth.signInWithPassword({
      email,
      password,
    });

  const appError = mapAuthError(error);
  if (appError) throw appError;

  return {
    session: data.session,
    user: data.user,
  };
};

const completeAuthSessionFromUrlInternal = async (
  url: string,
): Promise<AuthResult> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const parsed = parseAuthCallbackUrl(url);

  if (parsed.errorCode) {
    const description =
      parsed.errorDescription ?? parsed.errorCode;

    if (
      parsed.errorCode === "access_denied" ||
      description.toLowerCase().includes("cancel")
    ) {
      throw new AppError(
        ErrorCode.AUTH_OAUTH_CANCELLED,
        description,
      );
    }

    throw new AppError(
      ErrorCode.AUTH_OAUTH_FAILED,
      description,
    );
  }

  if (parsed.accessToken) {
    if (!parsed.refreshToken) {
      throw new AppError(
        ErrorCode.AUTH_OAUTH_CALLBACK_INVALID,
        "The authentication callback did not include a refresh token.",
      );
    }

    const { data, error } = await supabase.auth.setSession({
      access_token: parsed.accessToken,
      refresh_token: parsed.refreshToken,
    });

    const appError = mapAuthError(
      error,
      ErrorCode.AUTH_OAUTH_FAILED,
    );
    if (appError) throw appError;

    return {
      session: data.session,
      user: data.session?.user ?? null,
    };
  }

  if (parsed.authorizationCode) {
    // On web, detectSessionInUrl may have already exchanged the PKCE code.
    // Reuse that session rather than attempting to consume the single-use
    // authorization code a second time.
    const existing = await supabase.auth.getSession();

    if (existing.data.session) {
      return {
        session: existing.data.session,
        user: existing.data.session.user,
      };
    }

    const { data, error } =
      await supabase.auth.exchangeCodeForSession(
        parsed.authorizationCode,
      );

    const appError = mapAuthError(
      error,
      ErrorCode.AUTH_OAUTH_FAILED,
    );

    if (appError) {
      // A second callback observer may have exchanged the single-use PKCE
      // code first. Reuse the resulting session instead of showing a false
      // verification failure.
      const recovered = await waitForCurrentSession();
      if (recovered) {
        return {
          session: recovered,
          user: recovered.user,
        };
      }

      throw appError;
    }

    return {
      session: data.session,
      user: data.session?.user ?? null,
    };
  }

  // Some Android deep-link deliveries expose the route before the full query
  // string reaches this component, while WebBrowser is still finishing the
  // same OAuth callback. Give that consumer a short opportunity to persist
  // the session before treating the callback as invalid.
  const recovered = await waitForCurrentSession();

  if (recovered) {
    return {
      session: recovered,
      user: recovered.user,
    };
  }

  throw new AppError(
    ErrorCode.AUTH_OAUTH_CALLBACK_INVALID,
    "The authentication callback did not contain a session or authorization code.",
  );
};

/**
 * Complete an OAuth/email callback exactly once within the current process.
 * Both Expo Router and WebBrowser may observe the same deep link, so the
 * replay guard prevents a PKCE code or refresh token from being consumed
 * twice concurrently.
 */
export const completeAuthSessionFromUrl = async (
  url: string,
): Promise<AuthResult> => {
  if (completedCallbackUrls.has(url)) {
    const current = await getCurrentSession();

    if (current) {
      return {
        session: current,
        user: current.user,
      };
    }
  }

  const existingPromise = callbackPromises.get(url);
  if (existingPromise) return existingPromise;

  const promise = completeAuthSessionFromUrlInternal(url);
  callbackPromises.set(url, promise);

  try {
    const result = await promise;
    rememberCompletedCallback(url);
    return result;
  } finally {
    callbackPromises.delete(url);
  }
};

export const signInWithGoogle = async (): Promise<OAuthSignInResult> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const redirectTo = getAuthRedirectUrl("auth/callback");
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      queryParams: {
        prompt: "select_account",
      },
    },
  });

  const appError = mapAuthError(
    error,
    ErrorCode.AUTH_OAUTH_FAILED,
  );
  if (appError) throw appError;

  if (!data.url) {
    throw new AppError(
      ErrorCode.AUTH_OAUTH_FAILED,
      "Google did not return an authentication URL.",
    );
  }

  const browserResult = await WebBrowser.openAuthSessionAsync(
    data.url,
    redirectTo,
  );

  if (
    browserResult.type === "cancel" ||
    browserResult.type === "dismiss"
  ) {
    return { status: "cancelled" };
  }

  if (
    browserResult.type !== "success" ||
    !("url" in browserResult) ||
    !browserResult.url
  ) {
    throw new AppError(
      ErrorCode.AUTH_OAUTH_FAILED,
      "Google sign-in did not return a valid callback.",
    );
  }

  const completed = await completeAuthSessionFromUrl(
    browserResult.url,
  );

  if (!completed.session || !completed.user) {
    throw new AppError(
      ErrorCode.AUTH_OAUTH_CALLBACK_INVALID,
      "Google sign-in completed without an authenticated session.",
    );
  }

  return {
    status: "authenticated",
    session: completed.session,
    user: completed.user,
  };
};

export const sendPasswordReset = async (
  email: string,
): Promise<void> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const { error } = await supabase.auth.resetPasswordForEmail(
    email,
    {
      redirectTo: getAuthRedirectUrl("auth/reset"),
    },
  );

  const appError = mapAuthError(error);
  if (appError) throw appError;
};

export const updatePassword = async (
  newPassword: string,
): Promise<void> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const { error } = await supabase.auth.updateUser({
    password: newPassword,
  });

  const appError = mapAuthError(error);
  if (appError) throw appError;
};

export const signOut = async (): Promise<void> => {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.auth.signOut();
};

export const getCurrentSession = async (): Promise<Session | null> => {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data } = await supabase.auth.getSession();
  return data.session;
};

/**
 * Wait briefly for another OAuth callback consumer to finish persisting the
 * Supabase session. On Android, Expo Router and WebBrowser can observe the
 * same deep link through slightly different URL shapes or timing. The PKCE
 * authorization code is single-use, so the consumer that loses that race must
 * reuse the session created by the successful consumer instead of reporting a
 * false callback-verification error.
 */
export const waitForCurrentSession = async (
  timeoutMs = 2500,
  pollIntervalMs = 100,
): Promise<Session | null> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const interval = Math.max(25, pollIntervalMs);

  do {
    const session = await getCurrentSession();
    if (session) return session;

    if (Date.now() >= deadline) break;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, interval);
    });
  } while (Date.now() <= deadline);

  return getCurrentSession();
};

/**
 * Read-only, narrowed view of a Supabase auth identity for display purposes.
 * Deliberately excludes every raw or sensitive field (tokens, provider
 * tokens, raw `identity_data`) — only the four fields the UI needs to show
 * a connected provider are surfaced.
 */
export interface ConnectedIdentity {
  identityId: string;
  provider: string;
  createdAt: string | null;
  email: string | null;
}

const toConnectedIdentity = (identity: {
  identity_id: string;
  provider: string;
  created_at?: string | null;
  identity_data?: Record<string, unknown> | null;
}): ConnectedIdentity => {
  const rawEmail = identity.identity_data?.email;

  return {
    identityId: identity.identity_id,
    provider: identity.provider,
    createdAt: identity.created_at ?? null,
    email: typeof rawEmail === "string" ? rawEmail : null,
  };
};

/**
 * List the auth identities linked to the current session, narrowed to a
 * display-safe shape. Never returns access tokens, refresh tokens, provider
 * tokens, raw `identity_data`, or the raw Supabase identity object — see
 * `ConnectedIdentity` and `toConnectedIdentity` above for the exact field
 * allow-list.
 *
 * Read-only: this function does not link, unlink, or modify anything.
 */
export const listUserIdentities = async (): Promise<ConnectedIdentity[]> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const { data, error } = await supabase.auth.getUserIdentities();

  const appError = mapAuthError(error);
  if (appError) throw appError;

  const identities = data?.identities ?? [];
  return identities.map(toConnectedIdentity);
};

export type GoogleIdentityLinkResult =
  | { status: "linked" }
  | { status: "cancelled" }
  | { status: "alreadyLinkedElsewhere" };

export const hasConnectedProvider = (
  identities: readonly ConnectedIdentity[],
  provider: string,
): boolean => identities.some((identity) => identity.provider === provider);

const waitForConnectedProvider = async (
  provider: string,
  timeoutMs = 4000,
  pollIntervalMs = 200,
): Promise<ConnectedIdentity[]> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const interval = Math.max(50, pollIntervalMs);

  do {
    const identities = await listUserIdentities();
    if (hasConnectedProvider(identities, provider)) {
      return identities;
    }

    if (Date.now() >= deadline) {
      return identities;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, interval);
    });
  } while (Date.now() <= deadline);

  return listUserIdentities();
};

const getAuthenticatedUserId = async (): Promise<string> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const { data, error } = await supabase.auth.getUser();
  const appError = mapAuthError(
    error,
    ErrorCode.AUTH_SESSION_EXPIRED,
  );
  if (appError) throw appError;

  if (!data.user) {
    throw new AppError(
      ErrorCode.AUTH_SESSION_EXPIRED,
      "A signed-in user is required to link an identity.",
    );
  }

  return data.user.id;
};

const requireSameSignedInUser = async (
  expectedUserId: string,
): Promise<void> => {
  const currentUserId = await getAuthenticatedUserId();

  if (currentUserId !== expectedUserId) {
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_SESSION_CHANGED,
      "The signed-in user changed while linking an identity.",
    );
  }
};

interface IdentityLinkSessionSnapshot {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

const getIdentityLinkSessionSnapshot = async (): Promise<
  IdentityLinkSessionSnapshot
> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const { data, error } = await supabase.auth.getSession();
  const appError = mapAuthError(
    error,
    ErrorCode.AUTH_SESSION_EXPIRED,
  );
  if (appError) throw appError;

  const session = data.session;
  if (!session) {
    throw new AppError(
      ErrorCode.AUTH_SESSION_EXPIRED,
      "A signed-in session is required to link an identity.",
    );
  }

  const authenticatedUserId = await getAuthenticatedUserId();
  if (session.user.id !== authenticatedUserId) {
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_SESSION_CHANGED,
      "The authenticated user did not match the stored session.",
    );
  }

  return {
    userId: authenticatedUserId,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  };
};

const restoreIdentityLinkSession = async (
  snapshot: IdentityLinkSessionSnapshot,
): Promise<void> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_SESSION_CHANGED,
      "Supabase became unavailable while restoring the session.",
    );
  }

  const { data, error } = await supabase.auth.setSession({
    access_token: snapshot.accessToken,
    refresh_token: snapshot.refreshToken,
  });
  const appError = mapAuthError(
    error,
    ErrorCode.AUTH_IDENTITY_LINK_SESSION_CHANGED,
  );
  if (appError) throw appError;

  if (data.session?.user.id !== snapshot.userId) {
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_SESSION_CHANGED,
      "The original signed-in session could not be restored.",
    );
  }

  await requireSameSignedInUser(snapshot.userId);
};

const ensureOriginalSessionActive = async (
  snapshot: IdentityLinkSessionSnapshot,
): Promise<void> => {
  try {
    const currentUserId = await getAuthenticatedUserId();
    if (currentUserId === snapshot.userId) {
      return;
    }
  } catch {
    // Restore below. Never expose the intermediate auth failure or tokens.
  }

  await restoreIdentityLinkSession(snapshot);
};

const linkedGoogleResultIfPresent = async (): Promise<
  GoogleIdentityLinkResult | null
> => {
  try {
    const identities = await listUserIdentities();
    return hasConnectedProvider(identities, "google")
      ? { status: "linked" }
      : null;
  } catch {
    return null;
  }
};

let googleIdentityLinkPromise: Promise<GoogleIdentityLinkResult> | null = null;

const linkGoogleIdentityInternal = async (): Promise<GoogleIdentityLinkResult> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  // Keep the token-bearing snapshot strictly inside this service. It is used
  // only to recover the original account if an unexpected callback attempts
  // to establish a session for a different auth.users row.
  const originalSession = await getIdentityLinkSessionSnapshot();
  const existingIdentities = await listUserIdentities();
  if (hasConnectedProvider(existingIdentities, "google")) {
    return { status: "linked" };
  }

  const redirectTo = getAuthRedirectUrl("auth/link-callback");
  const { data, error } = await supabase.auth.linkIdentity({
    provider: "google",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      queryParams: {
        prompt: "select_account",
      },
    },
  });

  if (error) {
    if (isIdentityLinkConflict(normalizedAuthErrorCode(error), error.message)) {
      const linked = await linkedGoogleResultIfPresent();
      return linked ?? { status: "alreadyLinkedElsewhere" };
    }

    const appError = mapIdentityLinkError(error);
    if (appError) throw appError;
  }

  if (!data?.url) {
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_FAILED,
      "Google did not return an identity-linking URL.",
    );
  }

  const browserResult = await WebBrowser.openAuthSessionAsync(
    data.url,
    redirectTo,
  );

  if (
    browserResult.type === "cancel" ||
    browserResult.type === "dismiss"
  ) {
    await requireSameSignedInUser(originalSession.userId);
    return { status: "cancelled" };
  }

  if (
    browserResult.type !== "success" ||
    !("url" in browserResult) ||
    typeof browserResult.url !== "string"
  ) {
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_FAILED,
      "Google identity linking did not return a valid callback.",
    );
  }

  const callbackUrl = browserResult.url;
  const parsed = parseAuthCallbackUrl(callbackUrl);
  const description = parsed.errorDescription ?? parsed.errorCode ?? "";

  if (
    parsed.errorCode === "access_denied" ||
    description.toLowerCase().includes("cancel")
  ) {
    await requireSameSignedInUser(originalSession.userId);
    return { status: "cancelled" };
  }

  if (parsed.errorCode) {
    if (isIdentityLinkConflict(parsed.errorCode, description)) {
      const linked = await linkedGoogleResultIfPresent();
      return linked ?? { status: "alreadyLinkedElsewhere" };
    }

    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_FAILED,
      description,
    );
  }

  if (!parsed.authorizationCode) {
    throw new AppError(
      ErrorCode.AUTH_OAUTH_CALLBACK_INVALID,
      "The identity-link callback did not include an authorization code.",
    );
  }

  // This service is the only owner of the dedicated link-callback PKCE code.
  // The callback route disables Supabase URL auto-detection and never calls an
  // exchange method, preventing the single-use code from being consumed twice.
  const { data: exchangeData, error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(
      parsed.authorizationCode,
    );

  if (exchangeError) {
    await ensureOriginalSessionActive(originalSession);

    const linked = await linkedGoogleResultIfPresent();
    if (linked) {
      return linked;
    }

    if (
      isIdentityLinkConflict(
        normalizedAuthErrorCode(exchangeError),
        exchangeError.message,
      )
    ) {
      return { status: "alreadyLinkedElsewhere" };
    }

    const appError = mapIdentityLinkError(exchangeError);
    if (appError) throw appError;
  }

  const linkedSession = exchangeData.session;
  if (!linkedSession) {
    await ensureOriginalSessionActive(originalSession);
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_FAILED,
      "Identity linking completed without a session.",
    );
  }

  if (linkedSession.user.id !== originalSession.userId) {
    await restoreIdentityLinkSession(originalSession);
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_SESSION_CHANGED,
      "Identity linking returned a different signed-in user.",
    );
  }

  await requireSameSignedInUser(originalSession.userId);

  const identities = await waitForConnectedProvider("google");

  await requireSameSignedInUser(originalSession.userId);

  if (!hasConnectedProvider(identities, "google")) {
    throw new AppError(
      ErrorCode.AUTH_IDENTITY_LINK_FAILED,
      "Google identity linking completed without a linked identity.",
    );
  }

  return { status: "linked" };
};

/**
 * Link Google to the currently signed-in user without returning a Session,
 * User, callback URL, or token-bearing value to UI code. Calls are globally
 * single-flight so rapid presses cannot start multiple provider flows.
 */
export const linkGoogleIdentity = (): Promise<GoogleIdentityLinkResult> => {
  if (googleIdentityLinkPromise) {
    return googleIdentityLinkPromise;
  }

  googleIdentityLinkPromise = linkGoogleIdentityInternal().finally(() => {
    googleIdentityLinkPromise = null;
  });

  return googleIdentityLinkPromise;
};

/**
 * Let a remounted Profile screen wait for an identity-link flow that was
 * started before Expo Router handled the callback deep link. Errors are
 * intentionally swallowed here: Profile will perform its own safe identity
 * read and render either the connected state or its generic load-error state.
 */
export const waitForGoogleIdentityLinkCompletion = async (): Promise<void> => {
  const inFlight = googleIdentityLinkPromise;
  if (!inFlight) return;

  try {
    await inFlight;
  } catch {
    // The initiating button owns user-facing error handling.
  }
};

export const resendVerificationEmail = async (
  email: string,
): Promise<void> => {
  const supabase = getSupabase();

  if (!supabase) {
    throw new AppError(
      ErrorCode.UNKNOWN_ERROR,
      "Supabase is not configured",
    );
  }

  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: getAuthRedirectUrl("auth/callback"),
    },
  });

  const appError = mapAuthError(error);
  if (appError) throw appError;
};
