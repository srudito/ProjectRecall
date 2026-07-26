// Feature flags for Milestone 1. All AI / transcription / billing / admin
// features are OFF and their screens/menus must be hidden while these are false.
//
// Do not lie about capability. If a flag is false, the corresponding UI must
// not be shown at all — no placeholder "coming soon" tab, no ghost menu.

export const featureFlags = {
  ask_ai_enabled: false,
  transcription_enabled: false,
  live_transcription_enabled: false,
  billing_enabled: false,
  ads_enabled: false,
  admin_enabled: false,
} as const;

export type FeatureFlagKey = keyof typeof featureFlags;

export const isFeatureEnabled = (key: FeatureFlagKey): boolean => featureFlags[key];
