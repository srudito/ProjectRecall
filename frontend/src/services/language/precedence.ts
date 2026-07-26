// Language preference precedence resolution.
//
// Given a user default, a project default (nullable), and a session-specific
// selection (nullable), pick the effective value using the documented order:
//   1. Session-specific selection
//   2. Project default
//   3. User default
//   4. Application default (final fallback)
//
// Application language and spoken-language preferences are DIFFERENT concepts
// and MUST NEVER share the same field. This resolver operates only on
// spoken-language settings.

import { SpokenLanguageMode } from "@/src/domain/enums";

export interface LanguagePreferenceInputs<T> {
  session: T | null | undefined;
  project: T | null | undefined;
  user: T | null | undefined;
  appDefault: T;
}

export const resolveLanguagePreference = <T>(inputs: LanguagePreferenceInputs<T>): T => {
  if (inputs.session != null) return inputs.session;
  if (inputs.project != null) return inputs.project;
  if (inputs.user != null) return inputs.user;
  return inputs.appDefault;
};

// Validate a spoken-language selection against the current mode.
export const validateSpokenLanguageSelection = (
  mode: SpokenLanguageMode,
  selection: readonly string[],
): { valid: true } | { valid: false; code: "LANGUAGE_SELECTION_INVALID"; reason: string } => {
  switch (mode) {
    case SpokenLanguageMode.AUTO_DETECT:
      // Hints are optional, may be empty.
      return { valid: true };
    case SpokenLanguageMode.SINGLE_LANGUAGE:
      if (selection.length !== 1) {
        return {
          valid: false,
          code: "LANGUAGE_SELECTION_INVALID",
          reason: "Single-language mode requires exactly one language.",
        };
      }
      return { valid: true };
    case SpokenLanguageMode.MULTILINGUAL:
      if (selection.length < 2) {
        return {
          valid: false,
          code: "LANGUAGE_SELECTION_INVALID",
          reason: "Multilingual mode requires at least two languages.",
        };
      }
      return { valid: true };
    default:
      return {
        valid: false,
        code: "LANGUAGE_SELECTION_INVALID",
        reason: "Unknown spoken-language mode.",
      };
  }
};
