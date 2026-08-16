export type TranscriptionLanguageMode =
  | "AUTO_DETECT"
  | "SINGLE_LANGUAGE"
  | "MULTILINGUAL";

export type ProviderJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "error";

export type ProviderFailureCode =
  | "TRANSCRIPTION_PROVIDER_AUTH_FAILED"
  | "TRANSCRIPTION_PROVIDER_RATE_LIMITED"
  | "TRANSCRIPTION_PROVIDER_UNAVAILABLE"
  | "TRANSCRIPTION_PROVIDER_REQUEST_INVALID"
  | "TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE"
  | "TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED"
  | "TRANSCRIPTION_PROVIDER_NOT_FOUND"
  | "TRANSCRIPTION_PROVIDER_NETWORK_FAILED"
  | "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN"
  | "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN"
  | "TRANSCRIPTION_PROVIDER_RESULT_INVALID"
  | "TRANSCRIPTION_PROVIDER_JOB_FAILED";

export type ProviderDiagnosticCode =
  | "TRANSCRIPTION_PROVIDER_RESULT_ENVELOPE_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_METADATA_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_TEXT_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_CLAIM_SHAPE_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_CLAIM_LANGUAGE_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_CLAIM_METADATA_INVALID"
  | "TRANSCRIPTION_PROVIDER_RESULT_CLAIM_SEGMENTS_INVALID";

export interface ProviderFailure {
  code: ProviderFailureCode;
  retryable: boolean;
  safeMessage: string;
  diagnosticCode?: ProviderDiagnosticCode;
  httpStatus?: number;
  retryAfterMs?: number;
  providerJobId?: string;
}

export class TranscriptionProviderError extends Error {
  readonly failure: ProviderFailure;

  constructor(failure: ProviderFailure) {
    super(failure.safeMessage);
    this.name = "TranscriptionProviderError";
    this.failure = failure;
  }
}

export interface ProviderSubmissionInput {
  audioUrl: string;
  languageMode: TranscriptionLanguageMode;
  requestedLanguages: readonly string[];
  speakerDiarization: boolean;
}

export interface ProviderSubmission {
  providerKey: string;
  providerModel: string;
  providerJobId: string;
  status: Exclude<ProviderJobStatus, "error">;
  providerMetadata: Readonly<Record<string, unknown>>;
}

export interface NormalizedTranscriptSegment {
  segmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  languageCode: string | null;
  speakerLabel: string | null;
  providerSegmentId: string;
}

export interface NormalizedTranscriptLanguageSummary {
  primaryLanguage: string | null;
  detectedLanguages: readonly string[];
  confidence: number | null;
  detectionEnabled: boolean;
}

export interface NormalizedTranscript {
  providerKey: string;
  providerModel: string;
  providerJobId: string;
  plainText: string;
  languageSummary: NormalizedTranscriptLanguageSummary;
  segments: readonly NormalizedTranscriptSegment[];
  providerMetadata: Readonly<Record<string, unknown>>;
}

export type ProviderPollResult =
  | {
      status: "queued" | "processing";
      providerJobId: string;
      providerMetadata: Readonly<Record<string, unknown>>;
    }
  | {
      status: "completed";
      providerJobId: string;
      transcript: NormalizedTranscript;
    }
  | {
      status: "error";
      providerJobId: string;
      failure: ProviderFailure;
    };

export interface ProviderArtifactDeletion {
  providerJobId: string;
  deleted: boolean;
  alreadyAbsent: boolean;
}

export interface TranscriptionProvider {
  readonly providerKey: string;
  readonly providerModel: string;

  submit(input: ProviderSubmissionInput): Promise<ProviderSubmission>;
  getStatus(providerJobId: string): Promise<ProviderPollResult>;
  deleteArtifact(providerJobId: string): Promise<ProviderArtifactDeletion>;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
