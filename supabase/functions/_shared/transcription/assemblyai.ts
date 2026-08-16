import {
  TranscriptionProviderError,
  type FetchLike,
  type NormalizedTranscript,
  type NormalizedTranscriptSegment,
  type ProviderArtifactDeletion,
  type ProviderDiagnosticCode,
  type ProviderFailure,
  type ProviderFailureCode,
  type ProviderJobStatus,
  type ProviderPollResult,
  type ProviderSubmission,
  type ProviderSubmissionInput,
  type TranscriptionProvider,
} from "./provider.ts";

export const ASSEMBLYAI_PROVIDER_KEY = "assemblyai" as const;
export const ASSEMBLYAI_PROVIDER_MODEL = "universal-2" as const;
export const ASSEMBLYAI_EU_BASE_URL = "https://api.eu.assemblyai.com" as const;
export const ASSEMBLYAI_US_BASE_URL = "https://api.assemblyai.com" as const;

export type AssemblyAIRegion = "EU" | "US";

type AssemblyAIOperation = "submit" | "poll" | "delete";

export interface AssemblyAIProviderConfig {
  apiKey: string;
  region?: AssemblyAIRegion;
  fetchImplementation?: FetchLike;
}

interface AssemblyAISubmissionRequest {
  audio_url: string;
  speech_models: [typeof ASSEMBLYAI_PROVIDER_MODEL];
  punctuate: true;
  format_text: true;
  disfluencies: false;
  language_detection?: true;
  language_detection_options?: {
    expected_languages: string[];
    fallback_language: "auto";
  };
  language_code?: string;
  language_codes?: ["en", "id"];
  speaker_labels?: true;
}

interface AssemblyAIWord {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
  speaker?: unknown;
}

interface AssemblyAITranscriptResponse {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  text?: unknown;
  words?: unknown;
  utterances?: unknown;
  language_code?: unknown;
  language_codes?: unknown;
  language_confidence?: unknown;
  language_detection?: unknown;
  speech_model_used?: unknown;
  audio_duration?: unknown;
  speaker_labels?: unknown;
}

const INITIAL_SINGLE_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  en: "en",
  "en-au": "en_au",
  "en-gb": "en_uk",
  "en-uk": "en_uk",
  "en-us": "en_us",
  id: "id",
};

const ASSEMBLYAI_SUPPORTED_LANGUAGE_CODES: ReadonlySet<string> = new Set([
  "en",
  "en-au",
  "en-uk",
  "en-us",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "af",
  "sq",
  "am",
  "ar",
  "hy",
  "as",
  "az",
  "ba",
  "eu",
  "be",
  "bn",
  "bs",
  "br",
  "bg",
  "my",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "et",
  "fo",
  "fi",
  "gl",
  "ka",
  "el",
  "gu",
  "ht",
  "ha",
  "haw",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "ja",
  "jw",
  "kn",
  "kk",
  "km",
  "ko",
  "lo",
  "la",
  "lv",
  "ln",
  "lt",
  "lb",
  "mk",
  "mg",
  "ms",
  "ml",
  "mt",
  "mi",
  "mr",
  "mn",
  "ne",
  "no",
  "nn",
  "oc",
  "pa",
  "ps",
  "fa",
  "pl",
  "ro",
  "ru",
  "sa",
  "sr",
  "sn",
  "sd",
  "si",
  "sk",
  "sl",
  "so",
  "su",
  "sw",
  "sv",
  "tl",
  "tg",
  "ta",
  "tt",
  "te",
  "th",
  "bo",
  "tr",
  "tk",
  "uk",
  "ur",
  "uz",
  "vi",
  "cy",
  "yi",
  "yo",
]);

const SAFE_MESSAGES: Readonly<Record<ProviderFailureCode, string>> = {
  TRANSCRIPTION_PROVIDER_AUTH_FAILED:
    "The transcription provider is not configured correctly.",
  TRANSCRIPTION_PROVIDER_RATE_LIMITED:
    "The transcription provider is busy. The job will be retried.",
  TRANSCRIPTION_PROVIDER_UNAVAILABLE:
    "The transcription provider is temporarily unavailable.",
  TRANSCRIPTION_PROVIDER_REQUEST_INVALID:
    "The transcription request could not be submitted.",
  TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE:
    "The synchronized recording could not be read by the transcription provider.",
  TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED:
    "The selected language configuration is not supported by the transcription provider.",
  TRANSCRIPTION_PROVIDER_NOT_FOUND:
    "The transcription provider job no longer exists.",
  TRANSCRIPTION_PROVIDER_NETWORK_FAILED:
    "The transcription provider could not be reached.",
  TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN:
    "The transcription provider submission result could not be confirmed.",
  TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN:
    "The transcription provider deletion result could not be confirmed.",
  TRANSCRIPTION_PROVIDER_RESULT_INVALID:
    "The transcription provider returned an invalid result.",
  TRANSCRIPTION_PROVIDER_JOB_FAILED:
    "The transcription provider could not complete this recording.",
};

const createFailure = (
  code: ProviderFailureCode,
  options: {
    retryable: boolean;
    diagnosticCode?: ProviderDiagnosticCode;
    httpStatus?: number;
    retryAfterMs?: number;
    providerJobId?: string;
  },
): ProviderFailure => ({
  code,
  retryable: options.retryable,
  safeMessage: SAFE_MESSAGES[code],
  ...(options.diagnosticCode === undefined
    ? {}
    : { diagnosticCode: options.diagnosticCode }),
  ...(options.httpStatus === undefined
    ? {}
    : { httpStatus: options.httpStatus }),
  ...(options.retryAfterMs === undefined
    ? {}
    : { retryAfterMs: options.retryAfterMs }),
  ...(options.providerJobId === undefined
    ? {}
    : { providerJobId: options.providerJobId }),
});

const throwFailure = (
  code: ProviderFailureCode,
  options: {
    retryable: boolean;
    diagnosticCode?: ProviderDiagnosticCode;
    httpStatus?: number;
    retryAfterMs?: number;
    providerJobId?: string;
  },
): never => {
  throw new TranscriptionProviderError(createFailure(code, options));
};

type AssemblyAIResultDiagnosticCode = Extract<
  ProviderDiagnosticCode,
  | "TRANSCRIPTION_PROVIDER_RESULT_ENVELOPE_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING"
  | "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_SHAPE_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_EMPTY"
  | "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_MEMBER_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_DUPLICATE"
  | "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_NOT_IN_LANGUAGE_CODES"
  | "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_TEXT_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID"
>;

const throwResultInvalid = (
  diagnosticCode: AssemblyAIResultDiagnosticCode,
  options: { httpStatus?: number; providerJobId?: string } = {},
): never =>
  throwFailure("TRANSCRIPTION_PROVIDER_RESULT_INVALID", {
    retryable: false,
    diagnosticCode,
    ...options,
  });

const normalizeLanguageCode = (value: string): string =>
  value.trim().replace(/_/g, "-").toLowerCase();

const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return false;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const containsDatabaseUnsafeText = (value: string): boolean =>
  value.includes("\u0000") || !isWellFormedUnicode(value);

const isDenseStringArray = (value: unknown): value is string[] => {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      typeof value[index] !== "string"
    ) {
      return false;
    }
  }

  return true;
};

const validateSubmissionInput = (
  input: ProviderSubmissionInput,
): ProviderSubmissionInput => {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.audioUrl !== "string" ||
    !isDenseStringArray(input.requestedLanguages) ||
    typeof input.speakerDiarization !== "boolean" ||
    ![
      "AUTO_DETECT",
      "SINGLE_LANGUAGE",
      "MULTILINGUAL",
    ].includes(input.languageMode)
  ) {
    return throwFailure("TRANSCRIPTION_PROVIDER_REQUEST_INVALID", {
      retryable: false,
    });
  }

  return input;
};

const detectedLanguagePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

const normalizeDetectedLanguageCode = (
  value: unknown,
  diagnosticCode: AssemblyAIResultDiagnosticCode,
): string | null => {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    containsDatabaseUnsafeText(value)
  ) {
    return throwResultInvalid(diagnosticCode);
  }
  const normalized = normalizeLanguageCode(value);
  if (
    !detectedLanguagePattern.test(normalized) ||
    !ASSEMBLYAI_SUPPORTED_LANGUAGE_CODES.has(normalized)
  ) {
    return throwResultInvalid(diagnosticCode);
  }
  return normalized;
};

const normalizeRequestedLanguages = (
  values: readonly string[],
): string[] => {
  const normalized = values.map((value) => {
    if (
      !value.trim() ||
      containsDatabaseUnsafeText(value) ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      return throwFailure("TRANSCRIPTION_PROVIDER_REQUEST_INVALID", {
        retryable: false,
      });
    }
    return normalizeLanguageCode(value);
  });

  return [...new Set(normalized)].sort();
};

const mapSingleLanguage = (language: string): string => {
  if (
    !Object.prototype.hasOwnProperty.call(
      INITIAL_SINGLE_LANGUAGE_MAP,
      language,
    )
  ) {
    return throwFailure("TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED", {
      retryable: false,
    });
  }

  const providerLanguage = INITIAL_SINGLE_LANGUAGE_MAP[language];
  if (typeof providerLanguage !== "string") {
    return throwFailure("TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED", {
      retryable: false,
    });
  }

  return providerLanguage;
};

const mapAutomaticLanguageHints = (languages: readonly string[]): string[] =>
  [...new Set(languages.map(mapSingleLanguage))];

const mapCodeSwitchingLanguages = (
  languages: readonly string[],
): ["en", "id"] => {
  if (languages.length !== 2) {
    throwFailure("TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED", {
      retryable: false,
    });
  }

  const providerCodes = languages.map(mapSingleLanguage);
  const codeSwitchingCodes = providerCodes.map((providerCode) =>
    providerCode === "en" || providerCode.startsWith("en_")
      ? "en"
      : providerCode,
  );
  const uniqueCodes = [...new Set(codeSwitchingCodes)].sort();

  if (
    uniqueCodes.length !== 2 ||
    uniqueCodes[0] !== "en" ||
    uniqueCodes[1] !== "id"
  ) {
    throwFailure("TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED", {
      retryable: false,
    });
  }

  return ["en", "id"];
};

const validateAudioUrl = (audioUrl: string): string => {
  if (
    typeof audioUrl !== "string" ||
    audioUrl.trim() !== audioUrl ||
    /[\u0000-\u0020\u007f]/.test(audioUrl) ||
    !isWellFormedUnicode(audioUrl)
  ) {
    throwFailure("TRANSCRIPTION_PROVIDER_REQUEST_INVALID", {
      retryable: false,
    });
  }

  try {
    const parsed = new URL(audioUrl);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error("Unsafe audio URL");
    }
    return parsed.toString();
  } catch {
    return throwFailure("TRANSCRIPTION_PROVIDER_REQUEST_INVALID", {
      retryable: false,
    });
  }
};

export const buildAssemblyAISubmissionRequest = (
  input: ProviderSubmissionInput,
): AssemblyAISubmissionRequest => {
  const validatedInput = validateSubmissionInput(input);
  const audioUrl = validateAudioUrl(validatedInput.audioUrl);
  const requestedLanguageEntryCount =
    validatedInput.requestedLanguages.length;
  const requestedLanguages = normalizeRequestedLanguages(
    validatedInput.requestedLanguages,
  );

  const request: AssemblyAISubmissionRequest = {
    audio_url: audioUrl,
    speech_models: [ASSEMBLYAI_PROVIDER_MODEL],
    punctuate: true,
    format_text: true,
    disfluencies: false,
  };

  if (validatedInput.speakerDiarization) {
    request.speaker_labels = true;
  }

  switch (validatedInput.languageMode) {
    case "AUTO_DETECT":
      request.language_detection = true;
      if (requestedLanguages.length > 0) {
        request.language_detection_options = {
          expected_languages: mapAutomaticLanguageHints(requestedLanguages),
          fallback_language: "auto",
        };
      }
      break;

    case "SINGLE_LANGUAGE":
      if (
        requestedLanguageEntryCount !== 1 ||
        requestedLanguages.length !== 1
      ) {
        throwFailure("TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED", {
          retryable: false,
        });
      }
      request.language_code = mapSingleLanguage(requestedLanguages[0]);
      break;

    case "MULTILINGUAL":
      if (
        requestedLanguageEntryCount !== 2 ||
        requestedLanguages.length !== 2
      ) {
        throwFailure("TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED", {
          retryable: false,
        });
      }
      request.language_codes = mapCodeSwitchingLanguages(requestedLanguages);
      break;

    default:
      throwFailure("TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED", {
        retryable: false,
      });
  }

  return request;
};

const isProviderJobStatus = (value: unknown): value is ProviderJobStatus =>
  value === "queued" ||
  value === "processing" ||
  value === "completed" ||
  value === "error";

const assemblyAITranscriptIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requireProviderJobId = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !assemblyAITranscriptIdPattern.test(value)
  ) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_ENVELOPE_INVALID",
    );
  }
  return value.toLowerCase();
};

const normalizeOptionalBoolean = (
  value: unknown,
  diagnosticCode: AssemblyAIResultDiagnosticCode,
): boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") {
    return throwResultInvalid(diagnosticCode);
  }
  return value;
};

const normalizeOptionalArray = (
  value: unknown,
  diagnosticCode: AssemblyAIResultDiagnosticCode,
): readonly unknown[] | null => {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    return throwResultInvalid(diagnosticCode);
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return throwResultInvalid(diagnosticCode);
    }
  }

  return value;
};

const REVIEWED_ENGLISH_RESULT_CODES: ReadonlySet<string> = new Set([
  "en",
  "en-au",
  "en-uk",
  "en-us",
]);

const canonicalizeReviewedResultLanguage = (languageCode: string): string =>
  REVIEWED_ENGLISH_RESULT_CODES.has(languageCode) ? "en" : languageCode;

const normalizeProviderLanguageCodes = (value: unknown): string[] => {
  const rawLanguageCodes = normalizeOptionalArray(
    value,
    "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_SHAPE_INVALID",
  );
  if (rawLanguageCodes === null) return [];
  if (rawLanguageCodes.length === 0) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_EMPTY",
    );
  }
  if (rawLanguageCodes.length > 2) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_SHAPE_INVALID",
    );
  }

  const normalized = rawLanguageCodes.map((languageCode) => {
    const code = normalizeDetectedLanguageCode(
      languageCode,
      "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_MEMBER_INVALID",
    );
    if (code === null) {
      return throwResultInvalid(
        "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_MEMBER_INVALID",
      );
    }
    return code;
  });
  const canonical = normalized.map(canonicalizeReviewedResultLanguage);
  const uniqueCodes = [...new Set(canonical)].sort();

  if (uniqueCodes.length !== canonical.length) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_DUPLICATE",
    );
  }
  if (
    uniqueCodes.some(
      (languageCode) => languageCode !== "en" && languageCode !== "id",
    )
  ) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_MEMBER_INVALID",
    );
  }

  return uniqueCodes;
};

const normalizeOptionalText = (
  value: unknown,
  diagnosticCode: AssemblyAIResultDiagnosticCode,
): string => {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" || containsDatabaseUnsafeText(value)) {
    return throwResultInvalid(diagnosticCode);
  }
  return value.trim();
};

const normalizeOptionalNumber = (
  value: unknown,
  options: { min?: number; max?: number; integer?: boolean } = {},
  diagnosticCode: AssemblyAIResultDiagnosticCode,
): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return throwResultInvalid(diagnosticCode);
  }
  const numberValue = value;
  if (options.min !== undefined && numberValue < options.min) {
    return throwResultInvalid(diagnosticCode);
  }
  if (options.max !== undefined && numberValue > options.max) {
    return throwResultInvalid(diagnosticCode);
  }
  if (options.integer && !Number.isSafeInteger(numberValue)) {
    return throwResultInvalid(diagnosticCode);
  }
  return numberValue;
};

const normalizeWord = (
  rawWord: unknown,
  input: {
    providerJobId: string;
    segmentIndex: number;
    primaryLanguage: string | null;
  },
): NormalizedTranscriptSegment => {
  if (!rawWord || typeof rawWord !== "object" || Array.isArray(rawWord)) {
    return throwResultInvalid("TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID");
  }
  const word = rawWord as AssemblyAIWord;
  if (
    typeof word.text !== "string" ||
    !word.text.trim() ||
    containsDatabaseUnsafeText(word.text)
  ) {
    return throwResultInvalid("TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID");
  }
  const wordText = word.text.trim();

  const startMs = normalizeOptionalNumber(
    word.start,
    { min: 0, integer: true },
    "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
  );
  const endMs = normalizeOptionalNumber(
    word.end,
    { min: 0, integer: true },
    "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
  );
  if (startMs === null || endMs === null || endMs < startMs) {
    return throwResultInvalid("TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID");
  }

  const confidence = normalizeOptionalNumber(
    word.confidence,
    { min: 0, max: 1 },
    "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
  );
  let speakerLabel: string | null = null;
  if (word.speaker !== null && word.speaker !== undefined) {
    if (
      typeof word.speaker !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(word.speaker.trim())
    ) {
      return throwResultInvalid("TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID");
    }
    speakerLabel = word.speaker.trim();
  }

  return {
    segmentIndex: input.segmentIndex,
    startMs: Math.trunc(startMs),
    endMs: Math.trunc(endMs),
    text: wordText,
    confidence,
    languageCode: input.primaryLanguage,
    speakerLabel,
    providerSegmentId: `${input.providerJobId}:word:${input.segmentIndex}`,
  };
};

export const normalizeAssemblyAICompletedTranscript = (
  value: unknown,
): NormalizedTranscript => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return throwResultInvalid("TRANSCRIPTION_PROVIDER_RESULT_ENVELOPE_INVALID");
  }

  const response = value as AssemblyAITranscriptResponse;
  const providerJobId = requireProviderJobId(response.id);
  const rawWords = normalizeOptionalArray(
    response.words,
    "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
  );
  if (response.status !== "completed") {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_ENVELOPE_INVALID",
      { providerJobId },
    );
  }
  if (rawWords === null) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
      { providerJobId },
    );
  }

  if (response.language_code === null || response.language_code === undefined) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING",
      { providerJobId },
    );
  }
  const primaryLanguage = normalizeDetectedLanguageCode(
    response.language_code,
    "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_INVALID",
  );
  if (primaryLanguage === null) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING",
      { providerJobId },
    );
  }
  const providerLanguageCodes = normalizeProviderLanguageCodes(
    response.language_codes,
  );
  const canonicalPrimaryLanguage = canonicalizeReviewedResultLanguage(
    primaryLanguage,
  );
  if (
    providerLanguageCodes.length > 0 &&
    !providerLanguageCodes.includes(canonicalPrimaryLanguage)
  ) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_NOT_IN_LANGUAGE_CODES",
      { providerJobId },
    );
  }
  const codeSwitchingEnabled = providerLanguageCodes.length > 1;
  const summaryLanguageCodes =
    providerLanguageCodes.length === 1
      ? [primaryLanguage]
      : providerLanguageCodes;
  const segmentLanguage = codeSwitchingEnabled ? null : primaryLanguage;
  const segments = rawWords.map((word: unknown, segmentIndex: number) =>
    normalizeWord(word, {
      providerJobId,
      segmentIndex,
      primaryLanguage: segmentLanguage,
    }),
  );

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startMs < segments[index - 1].startMs) {
      return throwResultInvalid(
        "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
        { providerJobId },
      );
    }
  }

  if (segments.length === 0) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
      { providerJobId },
    );
  }

  const providerText = normalizeOptionalText(
    response.text,
    "TRANSCRIPTION_PROVIDER_RESULT_TEXT_INVALID",
  );
  const plainText =
    providerText || segments.map((segment) => segment.text).join(" ");

  if (!plainText) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_TEXT_INVALID",
      { providerJobId },
    );
  }

  const languageConfidence = normalizeOptionalNumber(
    response.language_confidence,
    { min: 0, max: 1 },
    "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID",
  );
  const audioDurationSeconds = normalizeOptionalNumber(
    response.audio_duration,
    { min: 0, max: Number.MAX_SAFE_INTEGER },
    "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID",
  );
  const languageDetection = normalizeOptionalBoolean(
    response.language_detection,
    "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID",
  );
  const speakerLabels = normalizeOptionalBoolean(
    response.speaker_labels,
    "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID",
  );
  const utterances = normalizeOptionalArray(
    response.utterances,
    "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID",
  );
  if (response.speech_model_used !== ASSEMBLYAI_PROVIDER_MODEL) {
    return throwResultInvalid(
      "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID",
      { providerJobId },
    );
  }
  const speechModelUsed = ASSEMBLYAI_PROVIDER_MODEL;

  return {
    providerKey: ASSEMBLYAI_PROVIDER_KEY,
    providerModel: speechModelUsed,
    providerJobId,
    plainText,
    languageSummary: {
      primaryLanguage,
      detectedLanguages:
        summaryLanguageCodes.length > 0
          ? summaryLanguageCodes
          : [primaryLanguage],
      confidence: languageConfidence,
      detectionEnabled: languageDetection === true,
    },
    segments,
    providerMetadata: {
      status: "completed",
      speechModelUsed,
      audioDurationSeconds,
      languageConfidence,
      speakerLabels: speakerLabels === true,
      wordCount: segments.length,
      utteranceCount: utterances?.length ?? 0,
    },
  };
};

const MAX_PROVIDER_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const retryAfterHttpDatePattern =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

const parseRetryAfterMs = (
  retryAfter: string | null,
  nowMs = Date.now(),
): number | undefined => {
  if (!retryAfter) return undefined;

  if (/^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (!Number.isSafeInteger(seconds)) return undefined;

    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) &&
      milliseconds <= MAX_PROVIDER_RETRY_AFTER_MS
      ? milliseconds
      : undefined;
  }

  if (!retryAfterHttpDatePattern.test(retryAfter)) return undefined;

  const dateMs = Date.parse(retryAfter);
  if (!Number.isFinite(dateMs)) return undefined;

  const milliseconds = Math.max(0, Math.ceil(dateMs - nowMs));
  return Number.isSafeInteger(milliseconds) &&
    milliseconds <= MAX_PROVIDER_RETRY_AFTER_MS
    ? milliseconds
    : undefined;
};

const classifyHttpFailure = (
  response: Response,
  operation: AssemblyAIOperation,
): ProviderFailure => {
  const retryAfterMs = parseRetryAfterMs(
    response.headers.get("Retry-After"),
  );

  if (response.status === 401 || response.status === 403) {
    return createFailure("TRANSCRIPTION_PROVIDER_AUTH_FAILED", {
      retryable: false,
      httpStatus: response.status,
    });
  }
  if (response.status === 404) {
    return createFailure(
      operation === "submit"
        ? "TRANSCRIPTION_PROVIDER_REQUEST_INVALID"
        : "TRANSCRIPTION_PROVIDER_NOT_FOUND",
      {
        retryable: false,
        httpStatus: response.status,
      },
    );
  }
  if (response.status === 429) {
    return createFailure("TRANSCRIPTION_PROVIDER_RATE_LIMITED", {
      retryable: true,
      httpStatus: response.status,
      retryAfterMs,
    });
  }
  if (
    operation === "submit" &&
    (response.status === 408 || response.status >= 500)
  ) {
    return createFailure(
      "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
      {
        retryable: false,
        httpStatus: response.status,
        retryAfterMs,
      },
    );
  }
  if (response.status === 408 || response.status >= 500) {
    return createFailure("TRANSCRIPTION_PROVIDER_UNAVAILABLE", {
      retryable: true,
      httpStatus: response.status,
      retryAfterMs,
    });
  }
  return createFailure("TRANSCRIPTION_PROVIDER_REQUEST_INVALID", {
    retryable: false,
    httpStatus: response.status,
  });
};

export const classifyAssemblyAIJobError = (
  value: unknown,
): ProviderFailure => {
  const errorText = typeof value === "string" ? value.toLowerCase() : "";

  if (
    /download error|unable to access|unreachable/.test(errorText)
  ) {
    return createFailure("TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE", {
      retryable: true,
    });
  }
  if (/unsupported file|file format|no audio|speech threshold/.test(errorText)) {
    return createFailure("TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE", {
      retryable: false,
    });
  }
  if (
    /language/.test(errorText) &&
    /unsupported|not available|language_codes|code switching/.test(errorText)
  ) {
    return createFailure("TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED", {
      retryable: false,
    });
  }
  if (/server|internal|temporary|temporarily|timeout/.test(errorText)) {
    return createFailure("TRANSCRIPTION_PROVIDER_UNAVAILABLE", {
      retryable: true,
    });
  }
  return createFailure("TRANSCRIPTION_PROVIDER_JOB_FAILED", {
    retryable: false,
  });
};

const parseJsonResponse = async (
  response: Response,
  operation: AssemblyAIOperation,
): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    const code =
      operation === "submit"
        ? "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN"
        : operation === "delete"
          ? "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN"
          : "TRANSCRIPTION_PROVIDER_UNAVAILABLE";
    throwFailure(code, {
      retryable: operation !== "submit",
      httpStatus: response.status,
    });
  }
};

const requireTranscriptResponse = (
  value: unknown,
): AssemblyAITranscriptResponse => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throwFailure("TRANSCRIPTION_PROVIDER_RESULT_INVALID", {
      retryable: false,
    });
  }
  return value as AssemblyAITranscriptResponse;
};

const requireSubmissionResponse = (
  value: unknown,
): {
  transcript: AssemblyAITranscriptResponse;
  providerJobId: string;
  status: ProviderJobStatus;
} => {
  let transcript: AssemblyAITranscriptResponse;
  try {
    transcript = requireTranscriptResponse(value);
  } catch (error) {
    if (
      error instanceof TranscriptionProviderError &&
      error.failure.code === "TRANSCRIPTION_PROVIDER_RESULT_INVALID"
    ) {
      return throwFailure(
        "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
        { retryable: false },
      );
    }
    throw error;
  }

  let providerJobId: string;
  try {
    providerJobId = requireProviderJobId(transcript.id);
  } catch (error) {
    if (
      error instanceof TranscriptionProviderError &&
      error.failure.code === "TRANSCRIPTION_PROVIDER_RESULT_INVALID"
    ) {
      return throwFailure(
        "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
        { retryable: false },
      );
    }
    throw error;
  }

  const status = transcript.status;
  if (!isProviderJobStatus(status)) {
    return throwFailure(
      "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
      { retryable: false, providerJobId },
    );
  }

  return { transcript, providerJobId, status };
};

const requirePollingResponse = (
  value: unknown,
  expectedProviderJobId: string,
): {
  transcript: AssemblyAITranscriptResponse;
  status: ProviderJobStatus;
} => {
  let transcript: AssemblyAITranscriptResponse;
  try {
    transcript = requireTranscriptResponse(value);
  } catch (error) {
    if (
      error instanceof TranscriptionProviderError &&
      error.failure.code === "TRANSCRIPTION_PROVIDER_RESULT_INVALID"
    ) {
      return throwFailure("TRANSCRIPTION_PROVIDER_UNAVAILABLE", {
        retryable: true,
        httpStatus: 200,
        providerJobId: expectedProviderJobId,
      });
    }
    throw error;
  }

  let responseProviderJobId: string;
  try {
    responseProviderJobId = requireProviderJobId(transcript.id);
  } catch (error) {
    if (
      error instanceof TranscriptionProviderError &&
      error.failure.code === "TRANSCRIPTION_PROVIDER_RESULT_INVALID"
    ) {
      return throwFailure("TRANSCRIPTION_PROVIDER_UNAVAILABLE", {
        retryable: true,
        httpStatus: 200,
        providerJobId: expectedProviderJobId,
      });
    }
    throw error;
  }

  if (responseProviderJobId !== expectedProviderJobId) {
    return throwFailure("TRANSCRIPTION_PROVIDER_RESULT_INVALID", {
      retryable: false,
      httpStatus: 200,
      providerJobId: expectedProviderJobId,
    });
  }

  if (transcript.status === null || transcript.status === undefined) {
    return throwFailure("TRANSCRIPTION_PROVIDER_UNAVAILABLE", {
      retryable: true,
      httpStatus: 200,
      providerJobId: expectedProviderJobId,
    });
  }

  if (!isProviderJobStatus(transcript.status)) {
    return throwFailure("TRANSCRIPTION_PROVIDER_RESULT_INVALID", {
      retryable: false,
      httpStatus: 200,
      providerJobId: expectedProviderJobId,
    });
  }

  return { transcript, status: transcript.status };
};

export class AssemblyAITranscriptionProvider
  implements TranscriptionProvider
{
  readonly providerKey = ASSEMBLYAI_PROVIDER_KEY;
  readonly providerModel = ASSEMBLYAI_PROVIDER_MODEL;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #region: AssemblyAIRegion;
  readonly #fetchImplementation: FetchLike;

  constructor(config: AssemblyAIProviderConfig) {
    if (!config || typeof config !== "object") {
      throwFailure("TRANSCRIPTION_PROVIDER_AUTH_FAILED", {
        retryable: false,
      });
    }

    if (typeof config.apiKey !== "string") {
      throwFailure("TRANSCRIPTION_PROVIDER_AUTH_FAILED", {
        retryable: false,
      });
    }
    this.#apiKey = config.apiKey.trim();
    if (
      !this.#apiKey ||
      this.#apiKey.length > 2048 ||
      /[\u0000-\u0020\u007f]/.test(this.#apiKey) ||
      !isWellFormedUnicode(this.#apiKey)
    ) {
      throwFailure("TRANSCRIPTION_PROVIDER_AUTH_FAILED", {
        retryable: false,
      });
    }

    if (
      config.region !== undefined &&
      config.region !== "EU" &&
      config.region !== "US"
    ) {
      throwFailure("TRANSCRIPTION_PROVIDER_REQUEST_INVALID", {
        retryable: false,
      });
    }
    this.#region = config.region ?? "EU";
    this.#baseUrl =
      this.#region === "US"
        ? ASSEMBLYAI_US_BASE_URL
        : ASSEMBLYAI_EU_BASE_URL;

    if (
      config.fetchImplementation !== undefined &&
      typeof config.fetchImplementation !== "function"
    ) {
      throwFailure("TRANSCRIPTION_PROVIDER_REQUEST_INVALID", {
        retryable: false,
      });
    }
    this.#fetchImplementation =
      config.fetchImplementation ??
      ((input, init) => globalThis.fetch(input, init));
  }

  async submit(
    input: ProviderSubmissionInput,
  ): Promise<ProviderSubmission> {
    const body = buildAssemblyAISubmissionRequest(input);
    const response = await this.fetchJson(
      "/v2/transcript",
      {
        method: "POST",
        headers: {
          Authorization: this.#apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "submit",
    );
    const { transcript, providerJobId, status } =
      requireSubmissionResponse(response);
    if (status === "error") {
      throw new TranscriptionProviderError({
        ...classifyAssemblyAIJobError(transcript.error),
        providerJobId,
      });
    }

    return {
      providerKey: this.providerKey,
      providerModel: this.providerModel,
      providerJobId,
      status,
      providerMetadata: {
        status,
        region: this.#region,
        speechModelRequested: this.providerModel,
      },
    };
  }

  async getStatus(providerJobId: string): Promise<ProviderPollResult> {
    const normalizedProviderJobId = requireProviderJobId(providerJobId);
    const encodedProviderJobId = encodeURIComponent(normalizedProviderJobId);
    let response: unknown;
    try {
      response = await this.fetchJson(
        `/v2/transcript/${encodedProviderJobId}`,
        {
          method: "GET",
          headers: { Authorization: this.#apiKey },
        },
        "poll",
      );
    } catch (error) {
      if (
        error instanceof TranscriptionProviderError &&
        error.failure.providerJobId === undefined
      ) {
        throw new TranscriptionProviderError({
          ...error.failure,
          providerJobId: normalizedProviderJobId,
        });
      }
      throw error;
    }

    const { transcript, status } = requirePollingResponse(
      response,
      normalizedProviderJobId,
    );

    if (status === "completed") {
      try {
        return {
          status: "completed",
          providerJobId: normalizedProviderJobId,
          transcript: this.withRegionMetadata(
            normalizeAssemblyAICompletedTranscript(transcript),
          ),
        };
      } catch (error) {
        if (
          error instanceof TranscriptionProviderError &&
          error.failure.providerJobId === undefined
        ) {
          throw new TranscriptionProviderError({
            ...error.failure,
            providerJobId: normalizedProviderJobId,
          });
        }
        throw error;
      }
    }
    if (status === "error") {
      return {
        status: "error",
        providerJobId: normalizedProviderJobId,
        failure: {
          ...classifyAssemblyAIJobError(transcript.error),
          providerJobId: normalizedProviderJobId,
        },
      };
    }

    return {
      status,
      providerJobId: normalizedProviderJobId,
      providerMetadata: { status, region: this.#region },
    };
  }

  async deleteArtifact(
    providerJobId: string,
  ): Promise<ProviderArtifactDeletion> {
    const normalizedProviderJobId = requireProviderJobId(providerJobId);
    const encodedProviderJobId = encodeURIComponent(normalizedProviderJobId);

    try {
      const deletionResponse = await this.fetchJson(
        `/v2/transcript/${encodedProviderJobId}`,
        {
          method: "DELETE",
          headers: { Authorization: this.#apiKey },
        },
        "delete",
      );
      const deletedTranscript = requireTranscriptResponse(deletionResponse);
      const deletedProviderJobId = requireProviderJobId(deletedTranscript.id);
      if (deletedProviderJobId !== normalizedProviderJobId) {
        return throwFailure(
          "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN",
          { retryable: true, providerJobId: normalizedProviderJobId },
        );
      }
      return {
        providerJobId: normalizedProviderJobId,
        deleted: true,
        alreadyAbsent: false,
      };
    } catch (error) {
      if (error instanceof TranscriptionProviderError) {
        if (error.failure.code === "TRANSCRIPTION_PROVIDER_NOT_FOUND") {
          return {
            providerJobId: normalizedProviderJobId,
            deleted: false,
            alreadyAbsent: true,
          };
        }
        if (
          error.failure.code === "TRANSCRIPTION_PROVIDER_RESULT_INVALID" ||
          error.failure.code ===
            "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN"
        ) {
          return throwFailure(
            "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN",
            {
              retryable: true,
              httpStatus: error.failure.httpStatus,
              providerJobId: normalizedProviderJobId,
            },
          );
        }
        if (error.failure.providerJobId === undefined) {
          throw new TranscriptionProviderError({
            ...error.failure,
            providerJobId: normalizedProviderJobId,
          });
        }
      }
      throw error;
    }
  }

  private withRegionMetadata(
    transcript: NormalizedTranscript,
  ): NormalizedTranscript {
    return {
      ...transcript,
      providerMetadata: {
        ...transcript.providerMetadata,
        region: this.#region,
      },
    };
  }

  private async fetchJson(
    path: string,
    init: RequestInit,
    operation: AssemblyAIOperation,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetchImplementation(
        `${this.#baseUrl}${path}`,
        { ...init, redirect: "error" },
      );
    } catch {
      return throwFailure(
        operation === "submit"
          ? "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN"
          : "TRANSCRIPTION_PROVIDER_NETWORK_FAILED",
        { retryable: operation !== "submit" },
      );
    }

    if (!response.ok) {
      throw new TranscriptionProviderError(
        classifyHttpFailure(response, operation),
      );
    }

    return parseJsonResponse(response, operation);
  }
}
