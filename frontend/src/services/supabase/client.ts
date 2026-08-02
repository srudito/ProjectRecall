import "react-native-url-polyfill/auto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { env, isSupabaseConfigured } from "@/src/config/env";

// Storage adapter for Supabase Auth.
// - Native: expo-secure-store (Keychain / EncryptedSharedPreferences).
// - Web: fall back to localStorage which supabase-js already handles by default.
const secureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

let cached: SupabaseClient | null = null;

const currentBrowserPathname = (): string => {
  const location = (globalThis as {
    location?: { pathname?: string };
  }).location;

  return typeof location?.pathname === "string"
    ? location.pathname
    : "";
};

/**
 * Keep the normal web OAuth callback auto-detection enabled, but never let
 * Supabase automatically exchange a PKCE code on the dedicated identity-link
 * callback routes. Dedicated identity-link and password-recovery services own
 * those one-time exchanges so no second observer can consume the same code.
 */
export const shouldDetectSessionInUrl = (
  platform: string = Platform.OS,
  pathname: string = currentBrowserPathname(),
): boolean => {
  if (platform !== "web") return false;

  const normalizedPath = pathname.replace(/\/+$/, "");
  return !(
    normalizedPath.endsWith("/auth/link-callback") ||
    normalizedPath.endsWith("/auth/reset")
  );
};

export const getSupabase = (): SupabaseClient | null => {
  if (!isSupabaseConfigured()) return null;
  if (cached) return cached;
  cached = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      storage: Platform.OS === "web" ? undefined : (secureStoreAdapter as any),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: shouldDetectSessionInUrl(),
      flowType: "pkce",
    },
  });
  return cached;
};

// Convenience for code that assumes configuration is present after checking.
export const requireSupabase = (): SupabaseClient => {
  const client = getSupabase();
  if (!client) {
    throw new Error(
      "Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  return client;
};
