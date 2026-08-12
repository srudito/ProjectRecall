import {
  TranscriptionProviderError,
  type NormalizedTranscript,
  type NormalizedTranscriptSegment,
  type ProviderFailure,
  type ProviderSubmission,
  type ProviderSubmissionInput,
  type TranscriptionProvider,
} from "../_shared/transcription/provider.ts";

export const DEFAULT_WORKER_CLAIM_LIMIT = 1;
export const DEFAULT_CLEANUP_CLAIM_LIMIT = 1;
export const DEFAULT_LEASE_SECONDS = 45;
export const DEFAULT_PROVIDER_PROCESSING_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_POLL_AFTER_SECONDS = 15;
export const DEFAULT_RECOVERY_LIMIT = 20;
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const UTF8_ENCODER = new TextEncoder();
const utf8Bytes = (value: string): number => UTF8_ENCODER.encode(value).byteLength;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export interface DurableRequestPayload {
  contractVersion: 1;
  languageMode: "AUTO_DETECT" | "SINGLE_LANGUAGE" | "MULTILINGUAL";
  requestedLanguages: string[];
  speakerDiarization: boolean;
}

export interface TranscriptionClaim {
  jobId: string;
  runId: string;
  action: "submit" | "poll";
  workspaceId: string;
  sessionId: string;
  recordingId: string;
  privateStoragePath: string;
  mimeType: string;
  durationMs: number;
  requestPayload: DurableRequestPayload;
  providerKey: "assemblyai";
  providerModel: "universal-2";
  providerRegion: "EU" | "US";
  providerJobId: string | null;
  leaseExpiresAt: string;
}

export interface CleanupClaim {
  runId: string;
  providerKey: "assemblyai";
  providerRegion: "EU" | "US";
  providerJobId: string;
  leaseExpiresAt: string;
}

export interface RecoveryResult {
  requeuedJobs: number;
  ambiguousJobs: number;
  repollJobs: number;
  deadlineFailedJobs: number;
  cleanupRequeuedRuns: number;
}

export interface TranscriptionWorkerRunResult {
  recovered: RecoveryResult;
  claimed: number;
  submitted: number;
  polled: number;
  completed: number;
  failed: number;
  cleanupClaimed: number;
  cleanupCompleted: number;
  cleanupRetried: number;
}

export type SubmissionFailureState =
  | "already_submitted"
  | "reconcile_provider_job"
  | "retry_submission"
  | "failed";
export type PollFailureState = "retry_poll" | "retry_new_run" | "failed";
export type CleanupFailureState = "retry_cleanup" | "manual_review";

interface SafeWorkerFailure {
  code: string;
  retryable: boolean;
  safeMessage: string;
  retryAfterMs?: number;
  providerJobId?: string;
}

export interface TranscriptionWorkerDatabase {
  recoverExpired(limit: number): Promise<RecoveryResult>;
  claimJobs(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<TranscriptionClaim[]>;
  beginSubmission(input: {
    jobId: string;
    runId: string;
    workerId: string;
  }): Promise<boolean>;
  markSubmitted(input: {
    jobId: string;
    runId: string;
    workerId: string;
    providerJobId: string;
    providerMetadata: Readonly<Record<string, unknown>>;
    pollAfterSeconds: number;
    processingTimeoutSeconds: number;
  }): Promise<boolean>;
  recordSubmissionFailure(input: {
    jobId: string;
    runId: string;
    workerId: string;
    errorCode: string;
    safeError: string;
    retryable: boolean;
    providerJobId: string | null;
    retryAfterSeconds: number;
  }): Promise<SubmissionFailureState>;
  recordPollResult(input: {
    jobId: string;
    runId: string;
    workerId: string;
    providerMetadata: Readonly<Record<string, unknown>>;
    pollAfterSeconds: number;
  }): Promise<boolean>;
  recordPollFailure(input: {
    jobId: string;
    runId: string;
    workerId: string;
    errorCode: string;
    safeError: string;
    retryable: boolean;
    providerTerminal: boolean;
    retryAfterSeconds: number;
  }): Promise<PollFailureState>;
  completeJob(input: {
    jobId: string;
    runId: string;
    workerId: string;
    providerJobId: string;
    transcript: NormalizedTranscript;
    checksumSha256: string;
  }): Promise<string>;
  claimCleanup(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<CleanupClaim[]>;
  completeCleanup(input: {
    runId: string;
    workerId: string;
    providerJobId: string;
  }): Promise<boolean>;
  failCleanup(input: {
    runId: string;
    workerId: string;
    errorCode: string;
    safeError: string;
    retryable: boolean;
    retryAfterSeconds: number;
  }): Promise<CleanupFailureState>;
}

export interface TranscriptionWorkerDependencies {
  database: TranscriptionWorkerDatabase;
  createSignedAudioUrl: (
    privateStoragePath: string,
    expiresInSeconds: number,
  ) => Promise<string>;
  getProvider: (input: {
    providerKey: "assemblyai";
    providerRegion: "EU" | "US";
  }) => TranscriptionProvider;
  checksumSha256: (text: string) => Promise<string>;
  workerId: string;
  claimLimit?: number;
  cleanupClaimLimit?: number;
  leaseSeconds?: number;
  processingTimeoutSeconds?: number;
  pollAfterSeconds?: number;
  recoveryLimit?: number;
  signedUrlTtlSeconds?: number;
}

const isDenseArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
};

const isDenseStringArray = (value: unknown): value is string[] =>
  isDenseArray(value) && value.every((item) => typeof item === "string");

const normalizeReviewedLanguage = (value: string): "en" | "id" | null => {
  if (!value || value.trim() !== value || CONTROL_PATTERN.test(value)) {
    return null;
  }
  const normalized = value.replace(/_/g, "-").toLowerCase();
  if (["en", "en-au", "en-gb", "en-uk", "en-us"].includes(normalized)) {
    return "en";
  }
  return normalized === "id" ? "id" : null;
};

const parseRequestPayload = (value: unknown): DurableRequestPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.join(",") !==
      "contractVersion,languageMode,requestedLanguages,speakerDiarization" ||
    candidate.contractVersion !== 1 ||
    typeof candidate.languageMode !== "string" ||
    !["AUTO_DETECT", "SINGLE_LANGUAGE", "MULTILINGUAL"].includes(
      candidate.languageMode,
    ) ||
    !isDenseStringArray(candidate.requestedLanguages) ||
    typeof candidate.speakerDiarization !== "boolean"
  ) {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }

  const rawLanguages = candidate.requestedLanguages;
  if (rawLanguages.length > 2) throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  const reviewed = rawLanguages.map(normalizeReviewedLanguage);
  if (reviewed.some((language) => language === null)) {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }
  const normalized = [...new Set(reviewed as ("en" | "id")[])].sort();
  const mode = candidate.languageMode as DurableRequestPayload["languageMode"];
  const rawIsCanonical =
    rawLanguages.every((language) => language === "en" || language === "id") &&
    rawLanguages.join(",") === normalized.join(",");

  if (
    !rawIsCanonical ||
    (mode === "AUTO_DETECT" && normalized.length > 2) ||
    (mode === "SINGLE_LANGUAGE" && normalized.length !== 1) ||
    (mode === "MULTILINGUAL" && normalized.join(",") !== "en,id")
  ) {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }

  return {
    contractVersion: 1,
    languageMode: mode,
    requestedLanguages: normalized,
    speakerDiarization: candidate.speakerDiarization,
  };
};

const canonicalStoragePath = (claim: {
  privateStoragePath: string;
  workspaceId: string;
  sessionId: string;
  recordingId: string;
}): boolean => {
  const prefix = `${claim.workspaceId}/${claim.sessionId}/${claim.recordingId}/`;
  if (
    !claim.privateStoragePath ||
    claim.privateStoragePath.length > 2048 ||
    claim.privateStoragePath.trim() !== claim.privateStoragePath ||
    !claim.privateStoragePath.startsWith(prefix) ||
    CONTROL_PATTERN.test(claim.privateStoragePath) ||
    claim.privateStoragePath.includes("\\")
  ) {
    return false;
  }

  const suffix = claim.privateStoragePath.slice(prefix.length);
  if (!suffix || suffix.startsWith("/") || suffix.endsWith("/")) return false;
  return suffix.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segment.trim() === segment,
  );
};

const requireUuid = (value: unknown, errorCode: string): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(errorCode);
  }
  return value.toLowerCase();
};

const requireTimestamp = (value: unknown, errorCode: string): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(errorCode);
  }
  return value;
};

export const parseTranscriptionClaim = (value: unknown): TranscriptionClaim => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }

  const row = value as Record<string, unknown>;
  const expectedKeys = [
    "action",
    "duration_ms",
    "job_id",
    "lease_expires_at",
    "mime_type",
    "private_storage_path",
    "provider_job_id",
    "provider_key",
    "provider_model",
    "provider_region",
    "recording_id",
    "request_payload",
    "run_id",
    "session_id",
    "workspace_id",
  ];
  if (Object.keys(row).sort().join(",") !== expectedKeys.join(",")) {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }

  const action = row.action;
  if (action !== "submit" && action !== "poll") {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }

  const providerJobId =
    row.provider_job_id === null
      ? null
      : requireUuid(row.provider_job_id, "TRANSCRIPTION_CLAIM_INVALID");

  const claim: TranscriptionClaim = {
    jobId: requireUuid(row.job_id, "TRANSCRIPTION_CLAIM_INVALID"),
    runId: requireUuid(row.run_id, "TRANSCRIPTION_CLAIM_INVALID"),
    action,
    workspaceId: requireUuid(row.workspace_id, "TRANSCRIPTION_CLAIM_INVALID"),
    sessionId: requireUuid(row.session_id, "TRANSCRIPTION_CLAIM_INVALID"),
    recordingId: requireUuid(row.recording_id, "TRANSCRIPTION_CLAIM_INVALID"),
    privateStoragePath:
      typeof row.private_storage_path === "string"
        ? row.private_storage_path
        : "",
    mimeType:
      typeof row.mime_type === "string" &&
      row.mime_type.length <= 255 &&
      row.mime_type.trim() === row.mime_type &&
      /^(?:audio|video)\/[A-Za-z0-9.+-]+$/.test(row.mime_type)
        ? row.mime_type
        : "",
    durationMs:
      typeof row.duration_ms === "number" &&
      Number.isSafeInteger(row.duration_ms) &&
      row.duration_ms > 0
        ? row.duration_ms
        : -1,
    requestPayload: parseRequestPayload(row.request_payload),
    providerKey:
      row.provider_key === "assemblyai"
        ? "assemblyai"
        : (() => {
            throw new Error("TRANSCRIPTION_CLAIM_INVALID");
          })(),
    providerModel:
      row.provider_model === "universal-2"
        ? "universal-2"
        : (() => {
            throw new Error("TRANSCRIPTION_CLAIM_INVALID");
          })(),
    providerRegion:
      row.provider_region === "EU" || row.provider_region === "US"
        ? row.provider_region
        : (() => {
            throw new Error("TRANSCRIPTION_CLAIM_INVALID");
          })(),
    providerJobId,
    leaseExpiresAt: requireTimestamp(
      row.lease_expires_at,
      "TRANSCRIPTION_CLAIM_INVALID",
    ),
  };

  if (!claim.mimeType || !canonicalStoragePath(claim)) {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }
  if (
    (claim.action === "submit" && claim.providerJobId !== null) ||
    (claim.action === "poll" && claim.providerJobId === null)
  ) {
    throw new Error("TRANSCRIPTION_CLAIM_INVALID");
  }
  return claim;
};

export const parseCleanupClaim = (value: unknown): CleanupClaim => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TRANSCRIPTION_CLEANUP_CLAIM_INVALID");
  }
  const row = value as Record<string, unknown>;
  const expectedKeys = [
    "lease_expires_at",
    "provider_job_id",
    "provider_key",
    "provider_region",
    "run_id",
  ];
  if (Object.keys(row).sort().join(",") !== expectedKeys.join(",")) {
    throw new Error("TRANSCRIPTION_CLEANUP_CLAIM_INVALID");
  }
  if (
    row.provider_key !== "assemblyai" ||
    (row.provider_region !== "EU" && row.provider_region !== "US")
  ) {
    throw new Error("TRANSCRIPTION_CLEANUP_CLAIM_INVALID");
  }

  return {
    runId: requireUuid(row.run_id, "TRANSCRIPTION_CLEANUP_CLAIM_INVALID"),
    providerKey: "assemblyai",
    providerRegion: row.provider_region,
    providerJobId: requireUuid(
      row.provider_job_id,
      "TRANSCRIPTION_CLEANUP_CLAIM_INVALID",
    ),
    leaseExpiresAt: requireTimestamp(
      row.lease_expires_at,
      "TRANSCRIPTION_CLEANUP_CLAIM_INVALID",
    ),
  };
};

const defaultFailure = (providerJobId?: string): ProviderFailure => ({
  code: "TRANSCRIPTION_PROVIDER_NETWORK_FAILED",
  retryable: true,
  safeMessage: "The transcription provider could not be reached.",
  ...(providerJobId ? { providerJobId } : {}),
});

const normalizeProviderFailure = (
  error: unknown,
  providerJobId?: string,
): ProviderFailure => {
  if (error instanceof TranscriptionProviderError) {
    return error.failure.providerJobId || !providerJobId
      ? error.failure
      : { ...error.failure, providerJobId };
  }
  return defaultFailure(providerJobId);
};

const normalizeSubmissionFailure = (error: unknown): ProviderFailure => {
  if (error instanceof TranscriptionProviderError) return error.failure;
  return {
    code: "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
    retryable: false,
    safeMessage:
      "The transcription provider submission result requires reconciliation.",
  };
};

const normalizeCleanupFailure = (
  error: unknown,
  providerJobId: string,
): ProviderFailure => {
  if (error instanceof TranscriptionProviderError) {
    return error.failure.providerJobId
      ? error.failure
      : { ...error.failure, providerJobId };
  }
  return {
    code: "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN",
    retryable: true,
    safeMessage:
      "The transcription provider deletion result could not be confirmed.",
    providerJobId,
  };
};

const resultInvalidFailure = (providerJobId?: string): ProviderFailure => ({
  code: "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
  retryable: false,
  safeMessage: "The transcription provider returned an invalid result.",
  ...(providerJobId ? { providerJobId } : {}),
});

const retryAfterSeconds = (failure: SafeWorkerFailure, fallback: number): number => {
  const milliseconds = failure.retryAfterMs;
  if (milliseconds === undefined) return fallback;
  const seconds = Math.ceil(milliseconds / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86400
    ? seconds
    : fallback;
};

const submissionInput = (
  claim: TranscriptionClaim,
  audioUrl: string,
): ProviderSubmissionInput => ({
  audioUrl,
  languageMode: claim.requestPayload.languageMode,
  requestedLanguages: claim.requestPayload.requestedLanguages,
  speakerDiarization: claim.requestPayload.speakerDiarization,
});

const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const containsDatabaseUnsafeText = (value: string): boolean =>
  value.includes("\u0000") || !isWellFormedUnicode(value);

const containsIdentifierUnsafeText = (value: string): boolean =>
  containsDatabaseUnsafeText(value) || CONTROL_PATTERN.test(value);

const validateSignedAudioUrl = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 8192 ||
    value.trim() !== value ||
    containsIdentifierUnsafeText(value)
  ) {
    throw new Error("TRANSCRIPTION_STORAGE_SIGNING_FAILED");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TRANSCRIPTION_STORAGE_SIGNING_FAILED");
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("TRANSCRIPTION_STORAGE_SIGNING_FAILED");
  }

  return value;
};

const PROVIDER_LANGUAGE_PATTERN =
  /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

const normalizeProviderLanguage = (value: string): string =>
  value.replace(/_/g, "-").toLowerCase();

const validateLanguageCode = (value: string): boolean =>
  Boolean(value) &&
  value.trim() === value &&
  !containsIdentifierUnsafeText(value) &&
  PROVIDER_LANGUAGE_PATTERN.test(value) &&
  value === normalizeProviderLanguage(value);

const validateSegment = (
  segment: NormalizedTranscriptSegment,
  index: number,
  transcript: NormalizedTranscript,
  claim: TranscriptionClaim,
  previousStartMs: number,
): boolean => {
  if (
    !segment ||
    typeof segment !== "object" ||
    segment.segmentIndex !== index ||
    !Number.isSafeInteger(segment.startMs) ||
    !Number.isSafeInteger(segment.endMs) ||
    segment.startMs < 0 ||
    segment.startMs < previousStartMs ||
    segment.endMs < segment.startMs ||
    typeof segment.text !== "string" ||
    !segment.text.trim() ||
    utf8Bytes(segment.text) > 10000 ||
    containsDatabaseUnsafeText(segment.text) ||
    (segment.confidence !== null &&
      (typeof segment.confidence !== "number" ||
        !Number.isFinite(segment.confidence) ||
        segment.confidence < 0 ||
        segment.confidence > 1)) ||
    (segment.languageCode !== null &&
      (typeof segment.languageCode !== "string" ||
        !validateLanguageCode(segment.languageCode) ||
        !transcript.languageSummary.detectedLanguages.includes(
          segment.languageCode,
        ))) ||
    (segment.speakerLabel !== null &&
      (typeof segment.speakerLabel !== "string" ||
        !segment.speakerLabel.trim() ||
        segment.speakerLabel.length > 200 ||
        containsIdentifierUnsafeText(segment.speakerLabel))) ||
    (!claim.requestPayload.speakerDiarization &&
      segment.speakerLabel !== null) ||
    typeof segment.providerSegmentId !== "string" ||
    !segment.providerSegmentId.trim() ||
    segment.providerSegmentId.length > 500 ||
    containsIdentifierUnsafeText(segment.providerSegmentId)
  ) {
    return false;
  }
  return true;
};

const validateTranscriptForClaim = (
  claim: TranscriptionClaim,
  transcript: NormalizedTranscript,
): void => {
  const fail = (): never => {
    throw new TranscriptionProviderError(
      resultInvalidFailure(claim.providerJobId ?? undefined),
    );
  };

  if (
    !transcript ||
    typeof transcript !== "object" ||
    transcript.providerKey !== claim.providerKey ||
    transcript.providerModel !== claim.providerModel ||
    transcript.providerJobId !== claim.providerJobId ||
    typeof transcript.plainText !== "string" ||
    !transcript.plainText.trim() ||
    utf8Bytes(transcript.plainText) > 8 * 1024 * 1024 ||
    containsDatabaseUnsafeText(transcript.plainText) ||
    !isDenseArray(transcript.segments) ||
    transcript.segments.length === 0 ||
    transcript.segments.length > 200000 ||
    !transcript.languageSummary ||
    typeof transcript.languageSummary !== "object" ||
    Array.isArray(transcript.languageSummary) ||
    !isDenseStringArray(transcript.languageSummary.detectedLanguages) ||
    transcript.languageSummary.detectedLanguages.length === 0 ||
    transcript.languageSummary.detectedLanguages.length > 2 ||
    typeof transcript.languageSummary.primaryLanguage !== "string" ||
    !validateLanguageCode(transcript.languageSummary.primaryLanguage) ||
    !transcript.languageSummary.detectedLanguages.includes(
      transcript.languageSummary.primaryLanguage,
    ) ||
    typeof transcript.languageSummary.detectionEnabled !== "boolean" ||
    (transcript.languageSummary.confidence !== null &&
      (typeof transcript.languageSummary.confidence !== "number" ||
        !Number.isFinite(transcript.languageSummary.confidence) ||
        transcript.languageSummary.confidence < 0 ||
        transcript.languageSummary.confidence > 1))
  ) {
    fail();
  }

  const detected = transcript.languageSummary.detectedLanguages;
  if (
    detected.some((language) => !validateLanguageCode(language)) ||
    new Set(detected).size !== detected.length
  ) {
    fail();
  }

  const normalizedDetected = detected.map(normalizeProviderLanguage).map(
    (language) =>
      ["en", "en-au", "en-gb", "en-uk", "en-us"].includes(language)
        ? "en"
        : language,
  );
  const requested = claim.requestPayload.requestedLanguages.map(
    normalizeReviewedLanguage,
  );
  const mode = claim.requestPayload.languageMode;
  if (
    (mode === "AUTO_DETECT" &&
      !transcript.languageSummary.detectionEnabled) ||
    (mode !== "AUTO_DETECT" &&
      transcript.languageSummary.detectionEnabled) ||
    (mode === "SINGLE_LANGUAGE" &&
      (normalizedDetected.length !== 1 ||
        normalizedDetected[0] !== requested[0])) ||
    (mode === "MULTILINGUAL" &&
      [...new Set(normalizedDetected)].sort().join(",") !== "en,id")
  ) {
    fail();
  }

  const metadata = transcript.providerMetadata;
  const expectedMetadataKeys = [
    "audioDurationSeconds",
    "languageConfidence",
    "region",
    "speakerLabels",
    "speechModelUsed",
    "status",
    "utteranceCount",
    "wordCount",
  ];
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(",") !== expectedMetadataKeys.join(",") ||
    metadata.status !== "completed" ||
    metadata.speechModelUsed !== claim.providerModel ||
    metadata.region !== claim.providerRegion ||
    metadata.speakerLabels !== claim.requestPayload.speakerDiarization ||
    typeof metadata.wordCount !== "number" ||
    !Number.isSafeInteger(metadata.wordCount) ||
    metadata.wordCount !== transcript.segments.length ||
    typeof metadata.utteranceCount !== "number" ||
    !Number.isSafeInteger(metadata.utteranceCount) ||
    metadata.utteranceCount < 0 ||
    metadata.utteranceCount > transcript.segments.length ||
    (metadata.audioDurationSeconds !== null &&
      (typeof metadata.audioDurationSeconds !== "number" ||
        !Number.isFinite(metadata.audioDurationSeconds) ||
        metadata.audioDurationSeconds < 0 ||
        metadata.audioDurationSeconds > SAFE_INTEGER_MAX)) ||
    (metadata.languageConfidence !== null &&
      (typeof metadata.languageConfidence !== "number" ||
        !Number.isFinite(metadata.languageConfidence) ||
        metadata.languageConfidence < 0 ||
        metadata.languageConfidence > 1)) ||
    metadata.languageConfidence !== transcript.languageSummary.confidence
  ) {
    fail();
  }

  const providerSegmentIds = new Set<string>();
  let previousStartMs = -1;
  for (let index = 0; index < transcript.segments.length; index += 1) {
    const segment = transcript.segments[index];
    if (
      !validateSegment(
        segment,
        index,
        transcript,
        claim,
        previousStartMs,
      ) ||
      providerSegmentIds.has(segment.providerSegmentId)
    ) {
      fail();
    }
    providerSegmentIds.add(segment.providerSegmentId);
    previousStartMs = segment.startMs;
  }
};

const validateProviderSubmission = (
  claim: TranscriptionClaim,
  value: unknown,
): ProviderSubmission => {
  const candidate = value as Partial<ProviderSubmission> | null;
  const knownProviderJobId =
    candidate &&
    typeof candidate.providerJobId === "string" &&
    UUID_PATTERN.test(candidate.providerJobId)
      ? candidate.providerJobId.toLowerCase()
      : undefined;

  const metadata = candidate?.providerMetadata;
  const metadataKeys =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? Object.keys(metadata).sort().join(",")
      : "";

  if (
    !candidate ||
    typeof candidate !== "object" ||
    candidate.providerKey !== claim.providerKey ||
    candidate.providerModel !== claim.providerModel ||
    !knownProviderJobId ||
    !["queued", "processing", "completed"].includes(
      String(candidate.status),
    ) ||
    metadataKeys !== "region,speechModelRequested,status" ||
    metadata?.status !== candidate.status ||
    metadata?.region !== claim.providerRegion ||
    metadata?.speechModelRequested !== claim.providerModel
  ) {
    throw new TranscriptionProviderError(
      resultInvalidFailure(knownProviderJobId),
    );
  }

  return {
    providerKey: claim.providerKey,
    providerModel: claim.providerModel,
    providerJobId: knownProviderJobId,
    status: candidate.status as ProviderSubmission["status"],
    providerMetadata: metadata as Readonly<Record<string, unknown>>,
  };
};

const safeChecksum = async (
  dependencies: TranscriptionWorkerDependencies,
  transcript: NormalizedTranscript,
): Promise<string> => {
  const checksum = await dependencies.checksumSha256(transcript.plainText);
  if (!SHA256_PATTERN.test(checksum)) {
    throw new TranscriptionProviderError(
      resultInvalidFailure(transcript.providerJobId),
    );
  }
  return checksum;
};

const requireInteger = (
  value: number,
  min: number,
  max: number,
  name: string,
): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`TRANSCRIPTION_WORKER_CONFIG_INVALID:${name}`);
  }
  return value;
};

const validateDependencies = (
  dependencies: TranscriptionWorkerDependencies,
): Required<
  Pick<
    TranscriptionWorkerDependencies,
    | "claimLimit"
    | "cleanupClaimLimit"
    | "leaseSeconds"
    | "processingTimeoutSeconds"
    | "pollAfterSeconds"
    | "recoveryLimit"
    | "signedUrlTtlSeconds"
  >
> => {
  if (
    !dependencies ||
    typeof dependencies.workerId !== "string" ||
    !dependencies.workerId ||
    dependencies.workerId.length > 200 ||
    dependencies.workerId.trim() !== dependencies.workerId ||
    CONTROL_PATTERN.test(dependencies.workerId)
  ) {
    throw new Error("TRANSCRIPTION_WORKER_CONFIG_INVALID:workerId");
  }

  return {
    claimLimit: requireInteger(
      dependencies.claimLimit ?? DEFAULT_WORKER_CLAIM_LIMIT,
      1,
      3,
      "claimLimit",
    ),
    cleanupClaimLimit: requireInteger(
      dependencies.cleanupClaimLimit ?? DEFAULT_CLEANUP_CLAIM_LIMIT,
      1,
      3,
      "cleanupClaimLimit",
    ),
    leaseSeconds: requireInteger(
      dependencies.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      15,
      300,
      "leaseSeconds",
    ),
    processingTimeoutSeconds: requireInteger(
      dependencies.processingTimeoutSeconds ??
        DEFAULT_PROVIDER_PROCESSING_TIMEOUT_SECONDS,
      300,
      86400,
      "processingTimeoutSeconds",
    ),
    pollAfterSeconds: requireInteger(
      dependencies.pollAfterSeconds ?? DEFAULT_POLL_AFTER_SECONDS,
      1,
      3600,
      "pollAfterSeconds",
    ),
    recoveryLimit: requireInteger(
      dependencies.recoveryLimit ?? DEFAULT_RECOVERY_LIMIT,
      1,
      100,
      "recoveryLimit",
    ),
    signedUrlTtlSeconds: requireInteger(
      dependencies.signedUrlTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS,
      60,
      2 * 60 * 60,
      "signedUrlTtlSeconds",
    ),
  };
};

const persistSubmissionFailure = async (
  dependencies: TranscriptionWorkerDependencies,
  claim: TranscriptionClaim,
  failure: SafeWorkerFailure,
): Promise<SubmissionFailureState> =>
  dependencies.database.recordSubmissionFailure({
    jobId: claim.jobId,
    runId: claim.runId,
    workerId: dependencies.workerId,
    errorCode: failure.code,
    safeError: failure.safeMessage,
    retryable: failure.retryable,
    providerJobId: failure.providerJobId ?? null,
    retryAfterSeconds: retryAfterSeconds(failure, 30),
  });

const processSubmission = async (
  dependencies: TranscriptionWorkerDependencies,
  claim: TranscriptionClaim,
  signedUrlTtlSeconds: number,
  pollAfterSeconds: number,
  processingTimeoutSeconds: number,
): Promise<"submitted" | "failed"> => {
  let signedUrl: string;
  try {
    signedUrl = validateSignedAudioUrl(
      await dependencies.createSignedAudioUrl(
        claim.privateStoragePath,
        signedUrlTtlSeconds,
      ),
    );
  } catch {
    await persistSubmissionFailure(dependencies, claim, {
      code: "TRANSCRIPTION_STORAGE_SIGNING_FAILED",
      retryable: true,
      safeMessage:
        "The synchronized recording could not be prepared for transcription.",
    });
    return "failed";
  }

  const began = await dependencies.database.beginSubmission({
    jobId: claim.jobId,
    runId: claim.runId,
    workerId: dependencies.workerId,
  });
  if (!began) return "failed";

  let submitted: Awaited<ReturnType<TranscriptionProvider["submit"]>>;
  try {
    const provider = dependencies.getProvider({
      providerKey: claim.providerKey,
      providerRegion: claim.providerRegion,
    });
    submitted = validateProviderSubmission(
      claim,
      await provider.submit(submissionInput(claim, signedUrl)),
    );
  } catch (error) {
    const state = await persistSubmissionFailure(
      dependencies,
      claim,
      normalizeSubmissionFailure(error),
    );
    return state === "already_submitted" ||
        state === "reconcile_provider_job"
      ? "submitted"
      : "failed";
  }

  try {
    const persisted = await dependencies.database.markSubmitted({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: dependencies.workerId,
      providerJobId: submitted.providerJobId,
      providerMetadata: submitted.providerMetadata,
      pollAfterSeconds,
      processingTimeoutSeconds,
    });
    if (persisted) return "submitted";
  } catch {
    // The provider job exists. Reconcile its ID instead of classifying a
    // database write failure as a provider transport failure.
  }

  const reconciliationState = await persistSubmissionFailure(
    dependencies,
    claim,
    {
      code: "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
      retryable: false,
      safeMessage:
        "The transcription provider submission result requires reconciliation.",
      providerJobId: submitted.providerJobId,
    },
  );
  return reconciliationState === "already_submitted" ||
      reconciliationState === "reconcile_provider_job"
    ? "submitted"
    : "failed";
};

const processPoll = async (
  dependencies: TranscriptionWorkerDependencies,
  claim: TranscriptionClaim,
  pollAfterSeconds: number,
): Promise<"polled" | "completed" | "failed"> => {
  const providerJobId = claim.providerJobId!;
  let poll: Awaited<ReturnType<TranscriptionProvider["getStatus"]>>;
  try {
    const provider = dependencies.getProvider({
      providerKey: claim.providerKey,
      providerRegion: claim.providerRegion,
    });
    poll = await provider.getStatus(providerJobId);
  } catch (error) {
    const failure = normalizeProviderFailure(error, providerJobId);
    await dependencies.database.recordPollFailure({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: dependencies.workerId,
      errorCode: failure.code,
      safeError: failure.safeMessage,
      retryable: failure.retryable,
      providerTerminal: false,
      retryAfterSeconds: retryAfterSeconds(failure, 30),
    });
    return "failed";
  }

  if (poll.status === "queued" || poll.status === "processing") {
    const persisted = await dependencies.database.recordPollResult({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: dependencies.workerId,
      providerMetadata: poll.providerMetadata,
      pollAfterSeconds,
    });
    if (!persisted) {
      throw new Error("TRANSCRIPTION_DATABASE_STATE_NOT_PERSISTED:poll");
    }
    return "polled";
  }

  if (poll.status === "error") {
    await dependencies.database.recordPollFailure({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: dependencies.workerId,
      errorCode: poll.failure.code,
      safeError: poll.failure.safeMessage,
      retryable: poll.failure.retryable,
      providerTerminal: true,
      retryAfterSeconds: retryAfterSeconds(poll.failure, 30),
    });
    return "failed";
  }

  if (poll.status !== "completed") {
    throw new Error("TRANSCRIPTION_PROVIDER_RESULT_STATE_INVALID");
  }

  try {
    validateTranscriptForClaim(claim, poll.transcript);
    const checksum = await safeChecksum(dependencies, poll.transcript);
    await dependencies.database.completeJob({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: dependencies.workerId,
      providerJobId,
      transcript: poll.transcript,
      checksumSha256: checksum,
    });
    return "completed";
  } catch (error) {
    if (!(error instanceof TranscriptionProviderError)) {
      // Database completion errors must leave the lease for bounded recovery;
      // they are not provider failures.
      throw error;
    }
    const failure = normalizeProviderFailure(error, providerJobId);
    await dependencies.database.recordPollFailure({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: dependencies.workerId,
      errorCode: failure.code,
      safeError: failure.safeMessage,
      retryable: failure.retryable,
      providerTerminal: true,
      retryAfterSeconds: retryAfterSeconds(failure, 30),
    });
    return "failed";
  }
};

const processCleanup = async (
  dependencies: TranscriptionWorkerDependencies,
  cleanup: CleanupClaim,
): Promise<"completed" | "retried" | "failed"> => {
  try {
    const provider = dependencies.getProvider({
      providerKey: cleanup.providerKey,
      providerRegion: cleanup.providerRegion,
    });
    await provider.deleteArtifact(cleanup.providerJobId);
  } catch (error) {
    const failure = normalizeCleanupFailure(error, cleanup.providerJobId);
    const state = await dependencies.database.failCleanup({
      runId: cleanup.runId,
      workerId: dependencies.workerId,
      errorCode: failure.code,
      safeError: failure.safeMessage,
      retryable: failure.retryable,
      retryAfterSeconds: retryAfterSeconds(failure, 60),
    });
    return state === "retry_cleanup" ? "retried" : "failed";
  }

  const persisted = await dependencies.database.completeCleanup({
    runId: cleanup.runId,
    workerId: dependencies.workerId,
    providerJobId: cleanup.providerJobId,
  });
  if (!persisted) {
    throw new Error("TRANSCRIPTION_DATABASE_STATE_NOT_PERSISTED:cleanup");
  }
  return "completed";
};

export const createTranscriptionWorker = (
  dependencies: TranscriptionWorkerDependencies,
) => {
  const config = validateDependencies(dependencies);

  const run = async (): Promise<TranscriptionWorkerRunResult> => {
    const recovered = await dependencies.database.recoverExpired(
      config.recoveryLimit,
    );
    const result: TranscriptionWorkerRunResult = {
      recovered,
      claimed: 0,
      submitted: 0,
      polled: 0,
      completed: 0,
      failed: 0,
      cleanupClaimed: 0,
      cleanupCompleted: 0,
      cleanupRetried: 0,
    };

    const claims = await dependencies.database.claimJobs({
      workerId: dependencies.workerId,
      limit: config.claimLimit,
      leaseSeconds: config.leaseSeconds,
    });

    for (const claim of claims) {
      result.claimed += 1;
      const state =
        claim.action === "submit"
          ? await processSubmission(
              dependencies,
              claim,
              config.signedUrlTtlSeconds,
              config.pollAfterSeconds,
              config.processingTimeoutSeconds,
            )
          : await processPoll(dependencies, claim, config.pollAfterSeconds);

      if (state === "submitted") result.submitted += 1;
      else if (state === "polled") result.polled += 1;
      else if (state === "completed") {
        result.polled += 1;
        result.completed += 1;
      } else result.failed += 1;
    }

    const cleanupClaims = await dependencies.database.claimCleanup({
      workerId: dependencies.workerId,
      limit: config.cleanupClaimLimit,
      leaseSeconds: config.leaseSeconds,
    });
    for (const cleanup of cleanupClaims) {
      result.cleanupClaimed += 1;
      const state = await processCleanup(dependencies, cleanup);
      if (state === "completed") result.cleanupCompleted += 1;
      else if (state === "retried") result.cleanupRetried += 1;
      else result.failed += 1;
    }

    return result;
  };

  return { run };
};
