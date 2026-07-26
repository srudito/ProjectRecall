// Auth service. Wraps supabase-js sign-in/up/reset flows and translates
// Supabase errors into stable AppError codes.

import { AuthError, Session, User } from "@supabase/supabase-js";

import { branding } from "@/src/config/branding";
import { AppError, ErrorCode } from "@/src/domain/errors";
import { getSupabase } from "./client";

const mapAuthError = (error: AuthError | null): AppError | null => {
  if (!error) return null;
  const message = error.message.toLowerCase();
  if (message.includes("invalid login credentials") || message.includes("invalid credentials")) {
    return new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, error.message, error);
  }
  if (message.includes("email not confirmed") || message.includes("not verified")) {
    return new AppError(ErrorCode.AUTH_EMAIL_NOT_VERIFIED, error.message, error);
  }
  if (message.includes("session")) {
    return new AppError(ErrorCode.AUTH_SESSION_EXPIRED, error.message, error);
  }
  return new AppError(ErrorCode.UNKNOWN_ERROR, error.message, error);
};

export interface AuthResult {
  session: Session | null;
  user: User | null;
}

const redirectTo = `${branding.deepLinkScheme}://auth/callback`;

export const signUpWithEmail = async (
  email: string,
  password: string,
  displayName?: string,
): Promise<AuthResult> => {
  const supabase = getSupabase();
  if (!supabase) throw new AppError(ErrorCode.UNKNOWN_ERROR, "Supabase is not configured");
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: redirectTo,
      data: displayName ? { display_name: displayName } : undefined,
    },
  });
  const appErr = mapAuthError(error);
  if (appErr) throw appErr;
  return { session: data.session, user: data.user };
};

export const signInWithEmail = async (email: string, password: string): Promise<AuthResult> => {
  const supabase = getSupabase();
  if (!supabase) throw new AppError(ErrorCode.UNKNOWN_ERROR, "Supabase is not configured");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  const appErr = mapAuthError(error);
  if (appErr) throw appErr;
  return { session: data.session, user: data.user };
};

export const sendPasswordReset = async (email: string): Promise<void> => {
  const supabase = getSupabase();
  if (!supabase) throw new AppError(ErrorCode.UNKNOWN_ERROR, "Supabase is not configured");
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${branding.deepLinkScheme}://auth/reset`,
  });
  const appErr = mapAuthError(error);
  if (appErr) throw appErr;
};

export const updatePassword = async (newPassword: string): Promise<void> => {
  const supabase = getSupabase();
  if (!supabase) throw new AppError(ErrorCode.UNKNOWN_ERROR, "Supabase is not configured");
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  const appErr = mapAuthError(error);
  if (appErr) throw appErr;
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

export const resendVerificationEmail = async (email: string): Promise<void> => {
  const supabase = getSupabase();
  if (!supabase) throw new AppError(ErrorCode.UNKNOWN_ERROR, "Supabase is not configured");
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: redirectTo },
  });
  const appErr = mapAuthError(error);
  if (appErr) throw appErr;
};
