import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabase } from "@/src/services/supabase/client";

import type {
  ProcessingJobStatus,
  SyncedProcessingJob,
  SyncedTranscriptSegment,
  SyncedTranscriptVersion,
  SyncedTranscriptionRun,
  TranscriptionResultSnapshot,
  TranscriptionRunStatus,
} from "./result-types";

export type TranscriptionResultClientErrorCode =
  | "SUPABASE_NOT_CONFIGURED"
  | "TRANSCRIPTION_RESULT_AUTHENTICATION_REQUIRED"
  | "TRANSCRIPTION_RESULT_NOT_FOUND"
  | "TRANSCRIPTION_RESULT_QUERY_FAILED"
  | "TRANSCRIPTION_RESULT_INVALID"
  | "NETWORK_UNAVAILABLE";

export class TranscriptionResultClientError extends Error {
  readonly code: TranscriptionResultClientErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: TranscriptionResultClientErrorCode,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message);
    this.name = "TranscriptionResultClientError";
    this.code = code;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/i;
const SEGMENT_PAGE_SIZE = 500;
const MAX_SEGMENTS = 100_000;

const processingStatuses: readonly ProcessingJobStatus[] = [
  "queued",
  "leased",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
];
const runStatuses: readonly TranscriptionRunStatus[] = [
  "queued",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
];

const invalid = (cause?: unknown): TranscriptionResultClientError =>
  new TranscriptionResultClientError(
    "TRANSCRIPTION_RESULT_INVALID",
    "The transcription service returned an invalid result.",
    { retryable: true, cause },
  );

const queryFailed = (cause: unknown): TranscriptionResultClientError =>
  new TranscriptionResultClientError(
    "TRANSCRIPTION_RESULT_QUERY_FAILED",
    "The transcription result could not be synchronized yet.",
    { retryable: true, cause },
  );

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};

const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalid();
  return value.toLowerCase();
};

const text = (value: unknown, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw invalid();
  return value;
};

const optionalText = (value: unknown): string | null =>
  value == null ? null : text(value, true);

const integer = (value: unknown, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw invalid();
  return value as number;
};

const optionalNumber = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
  return value;
};

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid();
  }
  return [...value] as string[];
};

const jsonObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};

const enumValue = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalid();
  return value as T;
};

export const parseSyncedProcessingJob = (value: unknown): SyncedProcessingJob => {
  const row = asRecord(value);
  return {
    id: uuid(row.id),
    workspace_id: uuid(row.workspace_id),
    session_id: uuid(row.session_id),
    recording_id: uuid(row.recording_id),
    created_by: row.created_by == null ? null : uuid(row.created_by),
    job_type: enumValue(row.job_type, ["batch_transcription"] as const),
    status: enumValue(row.status, processingStatuses),
    idempotency_key: text(row.idempotency_key),
    priority: integer(row.priority),
    attempt_count: integer(row.attempt_count),
    max_attempts: integer(row.max_attempts, 1),
    next_attempt_at: optionalText(row.next_attempt_at),
    lease_owner: optionalText(row.lease_owner),
    lease_expires_at: optionalText(row.lease_expires_at),
    started_at: optionalText(row.started_at),
    completed_at: optionalText(row.completed_at),
    cancelled_at: optionalText(row.cancelled_at),
    last_error_code: optionalText(row.last_error_code),
    last_safe_error: optionalText(row.last_safe_error),
    request_payload: jsonObject(row.request_payload),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
};

export const parseSyncedTranscriptionRun = (
  value: unknown,
): SyncedTranscriptionRun => {
  const row = asRecord(value);
  return {
    id: uuid(row.id),
    processing_job_id: uuid(row.processing_job_id),
    workspace_id: uuid(row.workspace_id),
    session_id: uuid(row.session_id),
    recording_id: uuid(row.recording_id),
    created_by: row.created_by == null ? null : uuid(row.created_by),
    run_attempt: integer(row.run_attempt, 1),
    provider_key: text(row.provider_key),
    provider_model: text(row.provider_model),
    request_mode: enumValue(row.request_mode, [
      "AUTO_DETECT",
      "SINGLE_LANGUAGE",
      "MULTILINGUAL",
    ] as const),
    requested_languages: stringArray(row.requested_languages),
    status: enumValue(row.status, runStatuses),
    provider_artifact_present:
      typeof row.provider_job_id === "string" && row.provider_job_id.length > 0,
    provider_cleanup_status: optionalText(row.provider_cleanup_status),
    detected_languages: stringArray(row.detected_languages),
    primary_detected_language: optionalText(row.primary_detected_language),
    language_detection_status: text(row.language_detection_status),
    started_at: optionalText(row.started_at),
    completed_at: optionalText(row.completed_at),
    last_error_code: optionalText(row.last_error_code),
    last_safe_error: optionalText(row.last_safe_error),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
};

export const parseSyncedTranscriptVersion = (
  value: unknown,
): SyncedTranscriptVersion => {
  const row = asRecord(value);
  if (row.is_current !== true) throw invalid();
  const checksum = optionalText(row.content_checksum_sha256);
  if (checksum !== null && !CHECKSUM_PATTERN.test(checksum)) throw invalid();
  return {
    id: uuid(row.id),
    workspace_id: uuid(row.workspace_id),
    session_id: uuid(row.session_id),
    transcription_run_id: uuid(row.transcription_run_id),
    created_by: row.created_by == null ? null : uuid(row.created_by),
    version: integer(row.version, 1),
    version_origin: enumValue(row.version_origin, [
      "provider",
      "user_edit",
      "import",
    ] as const),
    version_status: enumValue(row.version_status, ["draft", "final"] as const),
    parent_version_id:
      row.parent_version_id == null ? null : uuid(row.parent_version_id),
    plain_text: text(row.plain_text, true),
    language_summary: jsonObject(row.language_summary),
    content_checksum_sha256: checksum,
    is_current: true,
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
};

export const parseSyncedTranscriptSegment = (
  value: unknown,
): SyncedTranscriptSegment => {
  const row = asRecord(value);
  const start = integer(row.start_ms);
  const end = integer(row.end_ms);
  if (end < start) throw invalid();
  const confidence = optionalNumber(row.confidence);
  if (confidence !== null && (confidence < 0 || confidence > 1)) throw invalid();
  const segmentText = text(row.text);
  if (segmentText.trim().length === 0) throw invalid();
  return {
    id: uuid(row.id),
    workspace_id: uuid(row.workspace_id),
    session_id: uuid(row.session_id),
    transcript_version_id: uuid(row.transcript_version_id),
    segment_index: integer(row.segment_index),
    start_ms: start,
    end_ms: end,
    text: segmentText,
    language_code: optionalText(row.language_code),
    speaker_label: optionalText(row.speaker_label),
    confidence,
    provider_segment_id: optionalText(row.provider_segment_id),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
};

const looksLikeNetworkFailure = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "").toLowerCase()
      : String(error ?? "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("network request failed") ||
    message.includes("networkerror") ||
    message.includes("timeout")
  );
};

export const normalizeTranscriptionResultClientError = (
  error: unknown,
): TranscriptionResultClientError => {
  if (error instanceof TranscriptionResultClientError) return error;
  if (looksLikeNetworkFailure(error)) {
    return new TranscriptionResultClientError(
      "NETWORK_UNAVAILABLE",
      "The transcript result will retry when the network is available.",
      { retryable: true, cause: error },
    );
  }
  return queryFailed(error);
};

const requireSession = async (
  client: SupabaseClient,
  expectedUserId: string,
): Promise<void> => {
  const response = await client.auth.getSession();
  if (
    response.error ||
    !response.data.session?.access_token ||
    response.data.session.user.id !== expectedUserId
  ) {
    throw new TranscriptionResultClientError(
      "TRANSCRIPTION_RESULT_AUTHENTICATION_REQUIRED",
      "Sign in again before synchronizing transcript results.",
      { retryable: true, cause: response.error },
    );
  }
};

const readSegments = async (
  client: SupabaseClient,
  version: SyncedTranscriptVersion,
): Promise<SyncedTranscriptSegment[]> => {
  const segments: SyncedTranscriptSegment[] = [];
  for (let offset = 0; offset < MAX_SEGMENTS; offset += SEGMENT_PAGE_SIZE) {
    const response = await client
      .from("transcript_segments")
      .select(
        "id,workspace_id,session_id,transcript_version_id,segment_index,start_ms,end_ms,text,language_code,speaker_label,confidence,provider_segment_id,created_at,updated_at",
      )
      .eq("transcript_version_id", version.id)
      .order("segment_index", { ascending: true })
      .range(offset, offset + SEGMENT_PAGE_SIZE - 1);
    if (response.error) throw queryFailed(response.error);
    const page = (response.data ?? []).map(parseSyncedTranscriptSegment);
    for (const segment of page) {
      if (
        segment.workspace_id !== version.workspace_id ||
        segment.session_id !== version.session_id ||
        segment.transcript_version_id !== version.id
      ) {
        throw invalid();
      }
      const previous = segments.at(-1);
      if (previous && segment.segment_index <= previous.segment_index) throw invalid();
      segments.push(segment);
    }
    if (page.length < SEGMENT_PAGE_SIZE) return segments;
  }
  throw invalid(new Error("TRANSCRIPTION_SEGMENT_LIMIT_EXCEEDED"));
};

export const fetchRemoteTranscriptionResult = async (
  input: { serverJobId: string; expectedUserId: string },
  clientOverride?: SupabaseClient,
): Promise<TranscriptionResultSnapshot> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new TranscriptionResultClientError(
      "SUPABASE_NOT_CONFIGURED",
      "Cloud transcription is not configured.",
      { retryable: false },
    );
  }
  await requireSession(client, input.expectedUserId);

  const jobResponse = await client
    .from("processing_jobs")
    .select(
      "id,workspace_id,session_id,recording_id,created_by,job_type,status,idempotency_key,priority,attempt_count,max_attempts,next_attempt_at,lease_owner,lease_expires_at,started_at,completed_at,cancelled_at,last_error_code,last_safe_error,request_payload,created_at,updated_at",
    )
    .eq("id", input.serverJobId)
    .maybeSingle();
  if (jobResponse.error) throw queryFailed(jobResponse.error);
  if (!jobResponse.data) {
    throw new TranscriptionResultClientError(
      "TRANSCRIPTION_RESULT_NOT_FOUND",
      "The transcription result is no longer available to this account.",
      { retryable: false },
    );
  }
  const job = parseSyncedProcessingJob(jobResponse.data);
  if (job.id !== input.serverJobId.toLowerCase()) throw invalid();

  const runResponse = await client
    .from("transcription_runs")
    .select(
      "id,processing_job_id,workspace_id,session_id,recording_id,created_by,run_attempt,provider_key,provider_model,request_mode,requested_languages,status,provider_job_id,detected_languages,primary_detected_language,language_detection_status,provider_cleanup_status,started_at,completed_at,last_error_code,last_safe_error,created_at,updated_at",
    )
    .eq("processing_job_id", job.id)
    .order("run_attempt", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runResponse.error) throw queryFailed(runResponse.error);
  const run = runResponse.data
    ? parseSyncedTranscriptionRun(runResponse.data)
    : null;
  if (
    run &&
    (run.processing_job_id !== job.id ||
      run.workspace_id !== job.workspace_id ||
      run.session_id !== job.session_id ||
      run.recording_id !== job.recording_id)
  ) {
    throw invalid();
  }

  if (["queued", "leased", "processing"].includes(job.status)) {
    return { kind: "pending", reason: "job", job, run };
  }

  const cleanupOutstanding =
    run?.provider_artifact_present === true &&
    run.provider_cleanup_status !== "succeeded";
  if (cleanupOutstanding && run?.provider_cleanup_status === "manual_review") {
    return { kind: "cleanup_required", job, run };
  }
  if (cleanupOutstanding) {
    return { kind: "pending", reason: "cleanup", job, run };
  }

  if (job.status === "failed" || job.status === "cancelled") {
    return { kind: "terminal", status: job.status, job, run };
  }

  if (!run || run.status !== "succeeded" || !run.provider_artifact_present) {
    return { kind: "pending", reason: "result", job, run };
  }

  const versionResponse = await client
    .from("transcript_versions")
    .select(
      "id,workspace_id,session_id,transcription_run_id,created_by,version,version_origin,version_status,parent_version_id,plain_text,language_summary,content_checksum_sha256,is_current,created_at,updated_at",
    )
    .eq("transcription_run_id", run.id)
    .eq("is_current", true)
    .maybeSingle();
  if (versionResponse.error) throw queryFailed(versionResponse.error);
  if (!versionResponse.data) {
    return { kind: "pending", reason: "result", job, run };
  }
  const version = parseSyncedTranscriptVersion(versionResponse.data);
  if (
    version.workspace_id !== job.workspace_id ||
    version.session_id !== job.session_id ||
    version.transcription_run_id !== run.id
  ) {
    throw invalid();
  }

  const segments = await readSegments(client, version);
  return { kind: "succeeded", job, run, version, segments };
};
