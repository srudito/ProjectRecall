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
  path: "auth/callback" | "auth/reset",
): string => {
  if (Platform.OS === "web") {
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
