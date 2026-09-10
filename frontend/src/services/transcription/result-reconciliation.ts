import * as Crypto from "expo-crypto";

import {
  MAX_CACHE_MERGE_SEGMENTS,
  TranscriptCacheMergeError,
  normalizeTranscriptCacheInstant,
  normalizeTranscriptCacheUuid,
  planTranscriptCacheSegments,
  planTranscriptCacheVersion,
} from "./cache-merge";
import {
  ResultReceiptError,
  decodeTranscriptionResultReceipt,
  encodeTranscriptionResultReceipt,
  type TranscriptionResultReceipt,
} from "./result-receipt";
import type {
  ProcessingJobStatus,
  SyncedProcessingJob,
  SyncedTranscriptSegment,
  SyncedTranscriptVersionRecord,
  SyncedTranscriptionRun,
  TranscriptionRunStatus,
} from "./result-types";

export const MAX_RESULT_RECONCILIATION_SEGMENTS = MAX_CACHE_MERGE_SEGMENTS;
export const MAX_RESULT_RECONCILIATION_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_RESULT_RECONCILIATION_BYTES = 32 * 1024 * 1024;
export const MAX_RESULT_RECONCILIATION_JSON_DEPTH = 64;
export const MAX_RESULT_RECONCILIATION_JSON_NODES = 100_000;

const messages = {
  RESULT_RECONCILIATION_INPUT_INVALID: "The completed transcript result is invalid.",
  RESULT_RECONCILIATION_SCOPE_MISMATCH: "The completed transcript no longer matches its local request.",
  RESULT_RECONCILIATION_LIMIT_EXCEEDED: "The completed transcript exceeds the supported local limits.",
  RESULT_RECONCILIATION_CHECKSUM_MISMATCH: "The completed transcript text does not match its checksum.",
  RESULT_RECONCILIATION_HASH_UNAVAILABLE: "Transcript checksum verification is temporarily unavailable.",
  RESULT_RECONCILIATION_CONFLICT: "The completed transcript conflicts with existing local evidence.",
  RESULT_RECONCILIATION_STORAGE_UNAVAILABLE: "Local transcript storage is temporarily unavailable.",
  RESULT_RECONCILIATION_SESSION_UNAVAILABLE: "The local session is no longer available for this transcript.",
  RESULT_RECONCILIATION_WRITE_RETRYABLE: "Local transcript storage is busy. The result will retry.",
  RESULT_RECONCILIATION_WRITE_FAILED: "The completed transcript could not be stored safely.",
} as const;

export type TranscriptionResultReconciliationErrorCode = keyof typeof messages;

const retryableCodes = new Set<TranscriptionResultReconciliationErrorCode>([
  "RESULT_RECONCILIATION_HASH_UNAVAILABLE",
  "RESULT_RECONCILIATION_STORAGE_UNAVAILABLE",
  "RESULT_RECONCILIATION_WRITE_RETRYABLE",
  "RESULT_RECONCILIATION_WRITE_FAILED",
]);

export class TranscriptionResultReconciliationError extends Error {
  readonly code: TranscriptionResultReconciliationErrorCode;
  readonly retryable: boolean;

  constructor(code: TranscriptionResultReconciliationErrorCode) {
    super(messages[code]);
    this.name = "TranscriptionResultReconciliationError";
    this.code = code;
    this.retryable = retryableCodes.has(code);
  }
}

export const resultReconciliationError = (
  code: TranscriptionResultReconciliationErrorCode,
): TranscriptionResultReconciliationError =>
  new TranscriptionResultReconciliationError(code);

export const normalizeResultReconciliationError = (
  failure: unknown,
): TranscriptionResultReconciliationError =>
  failure instanceof TranscriptionResultReconciliationError
    ? failure
    : resultReconciliationError("RESULT_RECONCILIATION_WRITE_FAILED");

const invalid = (): never => {
  throw resultReconciliationError("RESULT_RECONCILIATION_INPUT_INVALID");
};
const scopeMismatch = (): never => {
  throw resultReconciliationError("RESULT_RECONCILIATION_SCOPE_MISMATCH");
};
const exceeded = (): never => {
  throw resultReconciliationError("RESULT_RECONCILIATION_LIMIT_EXCEEDED");
};

const ownRecord = (
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return invalid();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    return invalid();
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    result[field] = descriptor.value;
  }
  return result;
};

const utf8Bytes = (value: string, maximum: number): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return invalid();
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > maximum) return exceeded();
  }
  return bytes;
};

const boundedText = (value: unknown, maximum: number): string => {
  if (typeof value !== "string" || value.includes("\0")) return invalid();
  utf8Bytes(value, maximum);
  return value;
};

const nullableText = (value: unknown, maximum: number): string | null =>
  value === null ? null : boundedText(value, maximum);

const nullableUuid = (value: unknown): string | null =>
  value === null ? null : normalizeTranscriptCacheUuid(value);

const integer = (
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return invalid();
  }
  return value as number;
};

const optionalInstant = (value: unknown): string | null => {
  if (value === null) return null;
  const original = boundedText(value, 64);
  normalizeTranscriptCacheInstant(original);
  return original;
};

const instant = (value: unknown): string => {
  const original = boundedText(value, 64);
  normalizeTranscriptCacheInstant(original);
  return original;
};

const stringArray = (value: unknown, maximum: number): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return invalid();
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    result.push(boundedText(descriptor.value, 128));
  }
  return Object.freeze(result);
};

const jsonCopy = (input: unknown): Readonly<Record<string, unknown>> => {
  let nodes = 0;
  const path = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (
      depth > MAX_RESULT_RECONCILIATION_JSON_DEPTH ||
      nodes > MAX_RESULT_RECONCILIATION_JSON_NODES
    ) {
      return exceeded();
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return boundedText(value, 1_000_000);
    if (typeof value === "number" && Number.isFinite(value)) {
      return Object.is(value, -0) ? 0 : value;
    }
    if (
      !value ||
      typeof value !== "object" ||
      path.has(value) ||
      (![Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
        !Array.isArray(value))
    ) {
      return invalid();
    }
    path.add(value);
    let output: unknown;
    if (Array.isArray(value)) {
      if (
        value.length > MAX_RESULT_RECONCILIATION_JSON_NODES ||
        Reflect.ownKeys(value).length !== value.length + 1
      ) {
        return invalid();
      }
      const values: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
        values.push(visit(descriptor.value, depth + 1));
      }
      output = Object.freeze(values);
    } else {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string")) return invalid();
      const result: Record<string, unknown> = Object.create(null);
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
        result[boundedText(key, 512)] = visit(descriptor.value, depth + 1);
      }
      output = Object.freeze(result);
    }
    path.delete(value);
    return output;
  };
  const copied = visit(input, 0);
  if (
    !copied ||
    typeof copied !== "object" ||
    Array.isArray(copied)
  ) {
    return invalid();
  }
  return copied as Readonly<Record<string, unknown>>;
};

const PROCESSING_STATUSES: readonly ProcessingJobStatus[] = [
  "queued",
  "leased",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
];
const RUN_STATUSES: readonly TranscriptionRunStatus[] = [
  "queued",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
];
const JOB_FIELDS = [
  "id",
  "workspace_id",
  "session_id",
  "recording_id",
  "created_by",
  "job_type",
  "status",
  "idempotency_key",
  "priority",
  "attempt_count",
  "max_attempts",
  "next_attempt_at",
  "lease_owner",
  "lease_expires_at",
  "started_at",
  "completed_at",
  "cancelled_at",
  "last_error_code",
  "last_safe_error",
  "request_payload",
  "created_at",
  "updated_at",
] as const;
const RUN_FIELDS = [
  "id",
  "processing_job_id",
  "workspace_id",
  "session_id",
  "recording_id",
  "created_by",
  "run_attempt",
  "provider_key",
  "provider_model",
  "request_mode",
  "requested_languages",
  "status",
  "provider_artifact_present",
  "provider_cleanup_status",
  "detected_languages",
  "primary_detected_language",
  "language_detection_status",
  "started_at",
  "completed_at",
  "last_error_code",
  "last_safe_error",
  "created_at",
  "updated_at",
] as const;

const captureJob = (value: unknown): Readonly<SyncedProcessingJob> => {
  const row = ownRecord(value, JOB_FIELDS);
  if (
    row.job_type !== "batch_transcription" ||
    typeof row.status !== "string" ||
    !PROCESSING_STATUSES.includes(row.status as ProcessingJobStatus)
  ) {
    return invalid();
  }
  return Object.freeze({
    id: normalizeTranscriptCacheUuid(row.id),
    workspace_id: normalizeTranscriptCacheUuid(row.workspace_id),
    session_id: normalizeTranscriptCacheUuid(row.session_id),
    recording_id: normalizeTranscriptCacheUuid(row.recording_id),
    created_by: nullableUuid(row.created_by),
    job_type: "batch_transcription",
    status: row.status as ProcessingJobStatus,
    idempotency_key: boundedText(row.idempotency_key, 2048),
    priority: integer(row.priority, 0, 2_147_483_647),
    attempt_count: integer(row.attempt_count, 0, 2_147_483_647),
    max_attempts: integer(row.max_attempts, 1, 2_147_483_647),
    next_attempt_at: optionalInstant(row.next_attempt_at),
    lease_owner: nullableText(row.lease_owner, 512),
    lease_expires_at: optionalInstant(row.lease_expires_at),
    started_at: optionalInstant(row.started_at),
    completed_at: optionalInstant(row.completed_at),
    cancelled_at: optionalInstant(row.cancelled_at),
    last_error_code: nullableText(row.last_error_code, 512),
    last_safe_error: nullableText(row.last_safe_error, 4096),
    request_payload: jsonCopy(row.request_payload),
    created_at: instant(row.created_at),
    updated_at: instant(row.updated_at),
  });
};

const captureRun = (value: unknown): Readonly<SyncedTranscriptionRun> => {
  const row = ownRecord(value, RUN_FIELDS);
  if (
    typeof row.status !== "string" ||
    !RUN_STATUSES.includes(row.status as TranscriptionRunStatus) ||
    !["AUTO_DETECT", "SINGLE_LANGUAGE", "MULTILINGUAL"].includes(
      row.request_mode as string,
    ) ||
    typeof row.provider_artifact_present !== "boolean"
  ) {
    return invalid();
  }
  return Object.freeze({
    id: normalizeTranscriptCacheUuid(row.id),
    processing_job_id: normalizeTranscriptCacheUuid(row.processing_job_id),
    workspace_id: normalizeTranscriptCacheUuid(row.workspace_id),
    session_id: normalizeTranscriptCacheUuid(row.session_id),
    recording_id: normalizeTranscriptCacheUuid(row.recording_id),
    created_by: nullableUuid(row.created_by),
    run_attempt: integer(row.run_attempt, 1, 2_147_483_647),
    provider_key: boundedText(row.provider_key, 128),
    provider_model: boundedText(row.provider_model, 256),
    request_mode: row.request_mode as SyncedTranscriptionRun["request_mode"],
    requested_languages: stringArray(row.requested_languages, 32) as string[],
    status: row.status as TranscriptionRunStatus,
    provider_artifact_present: row.provider_artifact_present,
    provider_cleanup_status: nullableText(row.provider_cleanup_status, 128),
    detected_languages: stringArray(row.detected_languages, 32) as string[],
    primary_detected_language: nullableText(row.primary_detected_language, 128),
    language_detection_status: boundedText(row.language_detection_status, 128),
    started_at: optionalInstant(row.started_at),
    completed_at: optionalInstant(row.completed_at),
    last_error_code: nullableText(row.last_error_code, 512),
    last_safe_error: nullableText(row.last_safe_error, 4096),
    created_at: instant(row.created_at),
    updated_at: instant(row.updated_at),
  });
};

const INPUT_FIELDS = [
  "userId",
  "queueId",
  "job",
  "run",
  "version",
  "segments",
  "expectedSegmentCount",
  "reconciledAt",
] as const;

export interface TranscriptionResultReconciliationInput {
  userId: string;
  queueId: string;
  job: SyncedProcessingJob;
  run: SyncedTranscriptionRun;
  version: SyncedTranscriptVersionRecord;
  segments: readonly SyncedTranscriptSegment[];
  expectedSegmentCount: number;
  reconciledAt: string;
}

export interface PreparedTranscriptionResultReconciliationData {
  readonly userId: string;
  readonly queueId: string;
  readonly job: Readonly<SyncedProcessingJob>;
  readonly run: Readonly<SyncedTranscriptionRun>;
  readonly version: Readonly<SyncedTranscriptVersionRecord>;
  readonly remoteCurrent: boolean;
  readonly segments: readonly Readonly<SyncedTranscriptSegment>[];
  readonly expectedSegmentCount: number;
  readonly reconciledAt: string;
  readonly receipt: Readonly<TranscriptionResultReceipt>;
}

declare const reconciliationCommandBrand: unique symbol;
export interface PreparedTranscriptionResultReconciliationCommand {
  readonly [reconciliationCommandBrand]: true;
}
const commands = new WeakMap<
  PreparedTranscriptionResultReconciliationCommand,
  PreparedTranscriptionResultReconciliationData
>();

const mapPlanningFailure = (failure: unknown): never => {
  if (failure instanceof TranscriptionResultReconciliationError) throw failure;
  if (failure instanceof TranscriptCacheMergeError) {
    if (failure.code === "CACHE_MERGE_LIMIT_EXCEEDED") return exceeded();
    if (failure.code === "CACHE_MERGE_CONFLICT") return scopeMismatch();
    return invalid();
  }
  if (failure instanceof ResultReceiptError) {
    if (failure.code === "RESULT_RECEIPT_LIMIT_EXCEEDED") return exceeded();
    return invalid();
  }
  return invalid();
};

/**
 * Detach and validate the complete server result before taking the SQLite write
 * lane. The command is single-use and only the owning repository may consume it.
 */
export const prepareTranscriptionResultReconciliationCommand = async (
  input: TranscriptionResultReconciliationInput,
): Promise<PreparedTranscriptionResultReconciliationCommand> => {
  let data: PreparedTranscriptionResultReconciliationData;
  try {
    const row = ownRecord(input, INPUT_FIELDS);
    const userId = normalizeTranscriptCacheUuid(row.userId);
    const queueId = boundedText(row.queueId, 256);
    if (!queueId || queueId.trim() !== queueId) return invalid();
    const job = captureJob(row.job);
    const run = captureRun(row.run);
    const expectedSegmentCount = integer(row.expectedSegmentCount, 1);
    if (expectedSegmentCount > MAX_RESULT_RECONCILIATION_SEGMENTS) {
      return exceeded();
    }
    const reconciledAt = normalizeTranscriptCacheInstant(row.reconciledAt);
    const currentDescriptor =
      row.version && typeof row.version === "object"
        ? Object.getOwnPropertyDescriptor(row.version, "is_current")
        : undefined;
    if (
      !currentDescriptor?.enumerable ||
      !("value" in currentDescriptor) ||
      typeof currentDescriptor.value !== "boolean"
    ) {
      return invalid();
    }
    const remoteCurrent = currentDescriptor.value;
    const scope = {
      workspaceId: job.workspace_id,
      sessionId: job.session_id,
    };
    const versionPlan = planTranscriptCacheVersion(null, row.version, scope);
    const version = versionPlan.version;
    const segmentPlan = planTranscriptCacheSegments(
      version,
      [],
      row.segments as readonly unknown[],
      { kind: "complete", expectedSegmentCount },
      scope,
    );
    const segments = segmentPlan.segmentsToInsert;

    if (
      job.status !== "succeeded" ||
      job.completed_at === null ||
      !job.idempotency_key ||
      job.attempt_count > job.max_attempts ||
      run.status !== "succeeded" ||
      run.completed_at === null ||
      !run.provider_key ||
      !run.provider_model ||
      !run.language_detection_status ||
      run.detected_languages.length === 0 ||
      !run.provider_artifact_present ||
      run.provider_cleanup_status !== "succeeded" ||
      version.version_origin !== "provider" ||
      version.version_status !== "final" ||
      version.parent_version_id !== null ||
      version.content_checksum_sha256 === null ||
      !version.plain_text.trim() ||
      segments.length !== expectedSegmentCount
    ) {
      return invalid();
    }
    if (
      run.processing_job_id !== job.id ||
      run.workspace_id !== job.workspace_id ||
      run.session_id !== job.session_id ||
      run.recording_id !== job.recording_id ||
      version.transcription_run_id !== run.id ||
      version.workspace_id !== job.workspace_id ||
      version.session_id !== job.session_id ||
      (job.created_by !== null && job.created_by !== userId) ||
      (run.created_by !== null && run.created_by !== userId) ||
      (version.created_by !== null && version.created_by !== userId)
    ) {
      return scopeMismatch();
    }
    let totalBytes = utf8Bytes(
      JSON.stringify(job.request_payload),
      MAX_RESULT_RECONCILIATION_BYTES,
    );
    totalBytes += utf8Bytes(
      version.plain_text,
      MAX_RESULT_RECONCILIATION_TEXT_BYTES,
    );
    totalBytes += utf8Bytes(
      JSON.stringify(version.language_summary),
      1024 * 1024,
    );
    if (totalBytes > MAX_RESULT_RECONCILIATION_BYTES) return exceeded();
    let previousStart = -1;
    for (const segment of segments) {
      if (segment.start_ms < previousStart) return invalid();
      previousStart = segment.start_ms;
      totalBytes += utf8Bytes(segment.text, 10_000);
      if (segment.language_code !== null) {
        totalBytes += utf8Bytes(segment.language_code, 128);
      }
      if (segment.speaker_label !== null) {
        totalBytes += utf8Bytes(segment.speaker_label, 800);
      }
      if (segment.provider_segment_id !== null) {
        totalBytes += utf8Bytes(segment.provider_segment_id, 2_048);
      }
      if (totalBytes > MAX_RESULT_RECONCILIATION_BYTES) return exceeded();
    }

    const receiptIdentity = {
      userId,
      workspaceId: job.workspace_id,
      sessionId: job.session_id,
      recordingId: job.recording_id,
      jobId: job.id,
      requestId: queueId,
    };
    const receiptInput: TranscriptionResultReceipt = {
      schemaVersion: 1,
      kind: "result_reconciled",
      ...receiptIdentity,
      resultVersionId: version.id,
      resultVersion: version.version,
      contentChecksum: version.content_checksum_sha256,
      expectedSegments: expectedSegmentCount,
      reconciledAt,
    };
    const encodedReceipt = encodeTranscriptionResultReceipt(receiptInput);
    const receipt = decodeTranscriptionResultReceipt(
      encodedReceipt,
      receiptIdentity,
    );
    data = Object.freeze({
      userId,
      queueId,
      job,
      run,
      version,
      remoteCurrent,
      segments,
      expectedSegmentCount,
      reconciledAt,
      receipt,
    });
  } catch (failure) {
    return mapPlanningFailure(failure);
  }

  let digest: string;
  try {
    digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      data.version.plain_text,
    );
  } catch {
    throw resultReconciliationError("RESULT_RECONCILIATION_HASH_UNAVAILABLE");
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
    throw resultReconciliationError("RESULT_RECONCILIATION_HASH_UNAVAILABLE");
  }
  if (digest.toLowerCase() !== data.version.content_checksum_sha256) {
    throw resultReconciliationError("RESULT_RECONCILIATION_CHECKSUM_MISMATCH");
  }

  const command = Object.freeze(
    {},
  ) as PreparedTranscriptionResultReconciliationCommand;
  commands.set(command, data);
  return command;
};

export const consumeTranscriptionResultReconciliationCommand = (
  command: PreparedTranscriptionResultReconciliationCommand,
): PreparedTranscriptionResultReconciliationData => {
  const data =
    command && typeof command === "object" ? commands.get(command) : undefined;
  if (!data) {
    throw resultReconciliationError("RESULT_RECONCILIATION_INPUT_INVALID");
  }
  commands.delete(command);
  return data;
};

export const revokeTranscriptionResultReconciliationCommand = (
  command: PreparedTranscriptionResultReconciliationCommand,
): void => {
  commands.delete(command);
};
