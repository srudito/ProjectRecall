import {
  SpokenLanguageMode,
  type SpokenLanguageMode as SpokenLanguageModeValue,
} from "@/src/domain/enums";

export const SUPPORTED_TRANSCRIPTION_LANGUAGE_CODES = ["en", "id"] as const;
export type SupportedTranscriptionLanguageCode =
  (typeof SUPPORTED_TRANSCRIPTION_LANGUAGE_CODES)[number];

export const TRANSCRIPTION_CODE_SWITCHING_LANGUAGES = ["en", "id"] as const;

export type TranscriptionLanguageCapabilityErrorCode =
  | "TRANSCRIPTION_LANGUAGE_CODE_INVALID"
  | "TRANSCRIPTION_LANGUAGE_UNSUPPORTED"
  | "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID";

export type SupportedTranscriptionLanguageSelectionResult =
  | {
      ok: true;
      languages: SupportedTranscriptionLanguageCode[];
    }
  | {
      ok: false;
      code: TranscriptionLanguageCapabilityErrorCode;
      reason: string;
    };

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ENGLISH_LANGUAGE_ALIASES = new Set([
  "en",
  "en-au",
  "en-gb",
  "en-uk",
  "en-us",
]);

/**
 * General syntactic normalization retained for callers that need stable BCP-47
 * fingerprints. It does not decide whether the current transcription rollout
 * supports a language.
 */
export const normalizeTranscriptionLanguageCodes = (
  values: readonly string[],
): string[] => {
  const normalized = values
    .map((value) => value.trim().replace(/_/g, "-").toLowerCase())
    .filter(Boolean);

  return [...new Set(normalized)].sort();
};

const failure = (
  code: TranscriptionLanguageCapabilityErrorCode,
  reason: string,
): SupportedTranscriptionLanguageSelectionResult => ({
  ok: false,
  code,
  reason,
});

const canonicalizeLanguage = (
  value: unknown,
):
  | { ok: true; language: SupportedTranscriptionLanguageCode }
  | {
      ok: false;
      code:
        | "TRANSCRIPTION_LANGUAGE_CODE_INVALID"
        | "TRANSCRIPTION_LANGUAGE_UNSUPPORTED";
      reason: string;
    } => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return {
      ok: false,
      code: "TRANSCRIPTION_LANGUAGE_CODE_INVALID",
      reason: "One or more spoken-language codes are invalid.",
    };
  }

  const normalized = value.replace(/_/g, "-").toLowerCase();
  if (!LANGUAGE_CODE_PATTERN.test(normalized)) {
    return {
      ok: false,
      code: "TRANSCRIPTION_LANGUAGE_CODE_INVALID",
      reason: "One or more spoken-language codes are invalid.",
    };
  }

  if (ENGLISH_LANGUAGE_ALIASES.has(normalized)) {
    return { ok: true, language: "en" };
  }
  if (normalized === "id") {
    return { ok: true, language: "id" };
  }

  return {
    ok: false,
    code: "TRANSCRIPTION_LANGUAGE_UNSUPPORTED",
    reason:
      "Manual transcription selection currently supports English, Bahasa Indonesia, or English–Bahasa Indonesia code-switching.",
  };
};

export const resolveSupportedTranscriptionLanguageSelection = (
  mode: SpokenLanguageModeValue,
  values: readonly string[],
): SupportedTranscriptionLanguageSelectionResult => {
  if (!Array.isArray(values)) {
    return failure(
      "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID",
      "The spoken-language selection is invalid.",
    );
  }

  const canonicalLanguages: SupportedTranscriptionLanguageCode[] = [];
  for (const value of values) {
    const canonical = canonicalizeLanguage(value);
    if (!canonical.ok) return failure(canonical.code, canonical.reason);
    if (!canonicalLanguages.includes(canonical.language)) {
      canonicalLanguages.push(canonical.language);
    }
  }
  canonicalLanguages.sort();

  if (mode === SpokenLanguageMode.AUTO_DETECT) {
    if (canonicalLanguages.length > 2) {
      return failure(
        "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID",
        "Automatic detection accepts at most English and Bahasa Indonesia hints.",
      );
    }
    return { ok: true, languages: canonicalLanguages };
  }

  if (mode === SpokenLanguageMode.SINGLE_LANGUAGE) {
    if (values.length !== 1 || canonicalLanguages.length !== 1) {
      return failure(
        "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID",
        "Single-language transcription requires exactly one supported language.",
      );
    }
    return { ok: true, languages: canonicalLanguages };
  }

  if (mode === SpokenLanguageMode.MULTILINGUAL) {
    if (
      values.length !== 2 ||
      canonicalLanguages.length !== 2 ||
      canonicalLanguages[0] !== TRANSCRIPTION_CODE_SWITCHING_LANGUAGES[0] ||
      canonicalLanguages[1] !== TRANSCRIPTION_CODE_SWITCHING_LANGUAGES[1]
    ) {
      return failure(
        "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID",
        "Code-switching transcription requires English and Bahasa Indonesia.",
      );
    }
    return {
      ok: true,
      languages: [...TRANSCRIPTION_CODE_SWITCHING_LANGUAGES],
    };
  }

  return failure(
    "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID",
    "The spoken-language mode is invalid.",
  );
};

/**
 * Keeps mode changes deterministic in the session setup UI. Multilingual mode
 * is a fixed English–Bahasa Indonesia pair; single-language mode preserves the
 * first supported current choice when possible.
 */
export const getTranscriptionLanguageSelectionForMode = (
  mode: SpokenLanguageModeValue,
  currentValues: readonly string[],
): SupportedTranscriptionLanguageCode[] => {
  if (mode === SpokenLanguageMode.AUTO_DETECT) return [];
  if (mode === SpokenLanguageMode.MULTILINGUAL) {
    return [...TRANSCRIPTION_CODE_SWITCHING_LANGUAGES];
  }

  for (const value of currentValues) {
    const selection = resolveSupportedTranscriptionLanguageSelection(
      SpokenLanguageMode.SINGLE_LANGUAGE,
      [value],
    );
    if (selection.ok) return selection.languages;
  }
  return [];
};
