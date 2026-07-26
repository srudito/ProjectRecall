// Public runtime configuration. EXPO_PUBLIC_* is embedded into the mobile
// bundle. Never place service-role keys or JWT secrets here.

export const env = {
  appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? "development",
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "",
  apiBaseUrl: process.env.EXPO_PUBLIC_BACKEND_URL ?? "",
} as const;

export const isSupabaseConfigured = (): boolean =>
  env.supabaseUrl.length > 0 && env.supabaseAnonKey.length > 0;
