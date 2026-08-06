// Public runtime configuration. EXPO_PUBLIC_* is embedded into the mobile
// bundle. The Supabase frontend key must be publishable or legacy anon-role.
// Never place secret/service-role keys, OAuth client secrets, JWT secrets,
// database passwords, access tokens, or refresh tokens here.

const publicValue = (value: string | undefined): string => value?.trim() ?? "";

export const env = {
  appEnv: publicValue(process.env.EXPO_PUBLIC_APP_ENV) || "development",
  supabaseUrl: publicValue(process.env.EXPO_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: publicValue(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
  apiBaseUrl: publicValue(process.env.EXPO_PUBLIC_BACKEND_URL),
  supportEmail: publicValue(process.env.EXPO_PUBLIC_SUPPORT_EMAIL),
  privacyPolicyUrl: publicValue(
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
  ),
  termsOfServiceUrl: publicValue(
    process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL,
  ),
} as const;

export const isSupabaseConfigured = (): boolean =>
  env.supabaseUrl.length > 0 && env.supabaseAnonKey.length > 0;
