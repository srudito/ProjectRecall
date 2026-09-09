import * as Crypto from "expo-crypto";

import {
  assertHistoryCloudUtf8Budget,
  captureHistoryCloudRequest,
  historyCloudUuid,
  parseHistoryCloudVersion,
  TranscriptHistoryCloudError,
  type TranscriptHistoryCloudScope,
  type TranscriptHistoryCloudVersion,
} from "./history-cloud-types";
import { MAX_TRANSCRIPT_LINEAGE_DEPTH, type SyncedTranscriptSegment } from "./result-types";

/** Read/validation only. No proof here authorizes a later SQLite write by itself. */
export const HISTORY_BUNDLE_SOURCE = "supabase_history_bundle_v1";
export const HISTORY_BUNDLE_TIMEOUT_MS = 60_000;
export const HISTORY_BUNDLE_SEGMENT_PAGE_SIZE = 500;
export const MAX_HISTORY_BUNDLE_SEGMENTS = 100_000; // Explicit mobile cap, not the server's 200,000 cap.
export const MAX_HISTORY_BUNDLE_REQUESTS = 512;
export const MAX_HISTORY_BUNDLE_BYTES = 32 * 1024 * 1024;
export const MAX_HISTORY_BUNDLE_CONCURRENT = 2;

const messages = {
  HISTORY_BUNDLE_INVALID: ["The transcript bundle is inconsistent.", false],
  HISTORY_BUNDLE_PROOF_CHANGED: ["The transcript evidence changed while it was being read.", true],
  HISTORY_BUNDLE_NOT_ELIGIBLE: ["The transcript does not have the required bundle evidence.", false],
  HISTORY_BUNDLE_LIMIT_EXCEEDED: ["The transcript bundle exceeds the supported read limits.", false],
  HISTORY_BUNDLE_CHECKSUM_MISMATCH: ["The transcript text does not match its checksum.", false],
  HISTORY_BUNDLE_HASH_UNAVAILABLE: ["Transcript checksum verification is unavailable.", false],
  HISTORY_BUNDLE_QUERY_FAILED: ["The transcript bundle could not be read.", false],
} as const;
export type TranscriptHistoryBundleErrorCode = keyof typeof messages;
export class TranscriptHistoryBundleError extends Error {
  readonly code: TranscriptHistoryBundleErrorCode;
  readonly retryable: boolean;
  constructor(code: TranscriptHistoryBundleErrorCode) {
    super(messages[code][0]);
    this.name = "TranscriptHistoryBundleError";
    this.code = code;
    this.retryable = messages[code][1];
  }
}
export const normalizeHistoryBundleError = (failure: unknown): TranscriptHistoryBundleError | TranscriptHistoryCloudError =>
  failure instanceof TranscriptHistoryBundleError || failure instanceof TranscriptHistoryCloudError
    ? failure : new TranscriptHistoryBundleError("HISTORY_BUNDLE_QUERY_FAILED");
const invalid = (): never => { throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_INVALID"); };
const exceeded = (): never => { throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_LIMIT_EXCEEDED"); };

export const HISTORY_BUNDLE_RUN_COLUMNS = [
  "id", "processing_job_id", "workspace_id", "session_id", "recording_id", "status",
  "provider_job_id", "provider_cleanup_status",
  "provider_cleanup_completed_at", "completed_at", "word_count:provider_metadata->wordCount",
] as const;
export const HISTORY_BUNDLE_JOB_COLUMNS = [
  "id", "workspace_id", "session_id", "recording_id", "status", "completed_at",
] as const;
export const HISTORY_BUNDLE_SEGMENT_COLUMNS = [
  "id", "workspace_id", "session_id", "transcript_version_id", "segment_index", "start_ms", "end_ms",
  "text", "language_code", "speaker_label", "confidence", "provider_segment_id", "created_at", "updated_at",
] as const;

type JobStatus = "queued" | "leased" | "processing" | "succeeded" | "failed" | "cancelled";
type RunStatus = "queued" | "submitting" | "processing" | "succeeded" | "failed" | "cancelled";
type CleanupStatus = "not_required" | "pending" | "leased" | "succeeded" | "manual_review";
/** Ephemeral validation input. Do not persist the opaque provider identifier. */
export interface HistoryBundleRun {
  id: string; processing_job_id: string; workspace_id: string; session_id: string; recording_id: string;
  status: RunStatus;
  provider_job_id: string | null; provider_cleanup_status: CleanupStatus;
  provider_cleanup_completed_at: string | null; completed_at: string | null; word_count: number | null;
}
export interface HistoryBundleJob {
  id: string; workspace_id: string; session_id: string; recording_id: string;
  status: JobStatus; completed_at: string | null;
}
export type HistoryBundleUnavailableReason =
  | "version_not_visible" | "parent_not_visible" | "run_not_visible" | "job_not_visible"
  | "nullable_run_provenance" | "unsupported_origin" | "unsupported_provider_lineage"
  | "provider_terminal" | "cleanup_manual_review";
export type HistoryBundleEligibility =
  | { kind: "eligible"; expectedSegmentCount: number }
  | { kind: "not_ready"; reason: "processing_incomplete" | "cleanup_pending" }
  | { kind: "unavailable"; reason: HistoryBundleUnavailableReason };
export interface TranscriptHistoryBundle {
  completeness: "managed_provider_bundle";
  /** Selected first, then exact parents, ending at the provider. Flags remain cloud observations. */
  versions: readonly Readonly<TranscriptHistoryCloudVersion>[];
  segments: readonly Readonly<SyncedTranscriptSegment>[];
  provider: Readonly<{
    versionId: string; runId: string; jobId: string; recordingId: string;
    cleanupCompletedAt: string; expectedSegmentCount: number;
  }>;
}
export type TranscriptHistoryBundleResult = {
  source: typeof HISTORY_BUNDLE_SOURCE;
  scope: Readonly<TranscriptHistoryCloudScope>;
  selectedVersionId: string;
} & (
  | { kind: "ready"; bundle: TranscriptHistoryBundle }
  | Exclude<HistoryBundleEligibility, { kind: "eligible" }>
);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, columns: readonly string[]): Record<string, unknown> => {
  if (!object(value)) return invalid();
  const keys = Object.keys(value);
  if (keys.length !== columns.length || keys.some((key) => !columns.includes(key))) return invalid();
  return value;
};
const uuid = (value: unknown): string => {
  try { return historyCloudUuid(value); } catch { return invalid(); }
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value.includes("\0")) return invalid();
  assertHistoryCloudUtf8Budget(value, max);
  return value;
};
const enumValue = <T extends string>(value: unknown, allowed: readonly T[]): T =>
  typeof value === "string" && allowed.includes(value as T) ? value as T : invalid();

/** Normalize instants for equality without losing the server's microseconds. */
export const historyBundleInstant = (value: unknown): bigint => {
  if (typeof value !== "string" || value.length > 40) return invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = match[8];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return invalid();
  const milliseconds = Date.parse(`${value.slice(0, 19)}${zone}`);
  if (!Number.isFinite(milliseconds)) return invalid();
  return BigInt(milliseconds) * 1000n + BigInt((match[7] ?? "").padEnd(6, "0"));
};
const timestamp = (value: unknown): string => { historyBundleInstant(value); return value as string; };
const nullableTime = (value: unknown): string | null => value === null ? null : timestamp(value);

export const parseHistoryBundleRun = (input: unknown): HistoryBundleRun => {
  const row = exact(input, HISTORY_BUNDLE_RUN_COLUMNS.map((column) => column.split(":")[0]));
  if (row.word_count !== null && (!Number.isSafeInteger(row.word_count) || (row.word_count as number) < 1 || (row.word_count as number) > 200_000)) return invalid();
  return {
    id: uuid(row.id), processing_job_id: uuid(row.processing_job_id), workspace_id: uuid(row.workspace_id),
    session_id: uuid(row.session_id), recording_id: uuid(row.recording_id),
    status: enumValue(row.status, ["queued", "submitting", "processing", "succeeded", "failed", "cancelled"]),
    provider_job_id: row.provider_job_id === null ? null : text(row.provider_job_id, 500),
    provider_cleanup_status: enumValue(row.provider_cleanup_status, ["not_required", "pending", "leased", "succeeded", "manual_review"]),
    provider_cleanup_completed_at: nullableTime(row.provider_cleanup_completed_at), completed_at: nullableTime(row.completed_at),
    word_count: row.word_count as number | null,
  };
};
export const parseHistoryBundleJob = (input: unknown): HistoryBundleJob => {
  const row = exact(input, HISTORY_BUNDLE_JOB_COLUMNS);
  return { id: uuid(row.id), workspace_id: uuid(row.workspace_id), session_id: uuid(row.session_id), recording_id: uuid(row.recording_id),
    status: enumValue(row.status, ["queued", "leased", "processing", "succeeded", "failed", "cancelled"]),
    completed_at: nullableTime(row.completed_at) };
};

export const assessHistoryBundleProof = (
  provider: TranscriptHistoryCloudVersion, run: HistoryBundleRun, job: HistoryBundleJob,
): HistoryBundleEligibility => {
  if (provider.version_origin !== "provider" || provider.transcription_run_id !== run.id || run.processing_job_id !== job.id ||
      run.workspace_id !== provider.workspace_id || run.session_id !== provider.session_id ||
      job.workspace_id !== provider.workspace_id || job.session_id !== provider.session_id || run.recording_id !== job.recording_id) return invalid();
  if (provider.parent_version_id !== null) return { kind: "unavailable", reason: "unsupported_provider_lineage" };
  if (["failed", "cancelled"].includes(job.status) || ["failed", "cancelled"].includes(run.status)) {
    return { kind: "unavailable", reason: "provider_terminal" };
  }
  if (job.status !== "succeeded" || run.status !== "succeeded") return { kind: "not_ready", reason: "processing_incomplete" };
  if (run.completed_at === null || job.completed_at === null || run.provider_job_id === null ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run.provider_job_id)) return invalid();
  if (run.provider_cleanup_status === "manual_review") return { kind: "unavailable", reason: "cleanup_manual_review" };
  if (run.provider_cleanup_status === "pending" || run.provider_cleanup_status === "leased") {
    return { kind: "not_ready", reason: "cleanup_pending" };
  }
  if (run.provider_cleanup_status !== "succeeded" || run.provider_cleanup_completed_at === null ||
      run.word_count === null || provider.content_checksum_sha256 === null || provider.plain_text.trim().length === 0) return invalid();
  if (historyBundleInstant(run.provider_cleanup_completed_at) < historyBundleInstant(run.completed_at)) return invalid();
  if (run.word_count > MAX_HISTORY_BUNDLE_SEGMENTS) return exceeded();
  return { kind: "eligible", expectedSegmentCount: run.word_count };
};

export const parseHistoryBundleSegment = (
  input: unknown, provider: TranscriptHistoryCloudVersion, run: HistoryBundleRun,
): SyncedTranscriptSegment => {
  const row = exact(input, HISTORY_BUNDLE_SEGMENT_COLUMNS);
  const index = row.segment_index;
  const start = row.start_ms;
  const end = row.end_ms;
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= 200_000 ||
      !Number.isSafeInteger(start) || (start as number) < 0 || !Number.isSafeInteger(end) || (end as number) < (start as number) ||
      (row.confidence !== null && (typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1))) return invalid();
  const segmentText = text(row.text, 10_000);
  if (segmentText.trim().length === 0 || row.provider_segment_id !== `${run.provider_job_id}:word:${index}`) return invalid();
  const speaker = row.speaker_label === null ? null : text(row.speaker_label, 800);
  if (speaker !== null && (speaker.trim().length === 0 || speaker.length > 200 || [...speaker].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) return invalid();
  const segment = {
    id: uuid(row.id), workspace_id: uuid(row.workspace_id), session_id: uuid(row.session_id), transcript_version_id: uuid(row.transcript_version_id),
    segment_index: index as number, start_ms: start as number, end_ms: end as number, text: segmentText,
    language_code: row.language_code === null ? null : enumValue(row.language_code, ["en", "id"]), speaker_label: speaker,
    confidence: row.confidence as number | null, provider_segment_id: row.provider_segment_id as string,
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
  };
  if (segment.workspace_id !== provider.workspace_id || segment.session_id !== provider.session_id || segment.transcript_version_id !== provider.id) return invalid();
  return segment;
};

/** Budget for decoded JSON, including escaping; not a streaming HTTP memory cap. */
export const historyBundleByteSize = (value: unknown, maximum = MAX_HISTORY_BUNDLE_BYTES): number => {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return invalid(); }
  if (typeof encoded !== "string") return invalid();
  assertHistoryCloudUtf8Budget(encoded, maximum);
  let bytes = 0;
  for (const codePoint of encoded) { const code = codePoint.codePointAt(0)!; bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; }
  return bytes;
};
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
/** Content immutable; reference clearing and current-marker changes are observations, not commands. */
export const reconcileHistoryBundleVersion = (
  previous: TranscriptHistoryCloudVersion, latest: TranscriptHistoryCloudVersion,
): TranscriptHistoryCloudVersion => {
  const immutable = ["id", "workspace_id", "session_id", "version", "version_origin", "version_status", "parent_version_id", "plain_text", "content_checksum_sha256"] as const;
  if (immutable.some((field) => previous[field] !== latest[field]) ||
      historyBundleInstant(previous.created_at) !== historyBundleInstant(latest.created_at) ||
      canonicalJson(previous.language_summary) !== canonicalJson(latest.language_summary) ||
      (["created_by", "transcription_run_id"] as const).some((field) => previous[field] !== latest[field] && !(previous[field] !== null && latest[field] === null))) {
    throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_PROOF_CHANGED");
  }
  return latest;
};

export const assertHistoryBundleParent = (child: TranscriptHistoryCloudVersion, parent: TranscriptHistoryCloudVersion): void => {
  // Historical selection is not a current-version snapshot. Do not rewrite flags to reuse its guard.
  if (child.version_origin !== "user_edit" || child.parent_version_id !== parent.id || parent.version >= child.version ||
      child.workspace_id !== parent.workspace_id || child.session_id !== parent.session_id || child.id === parent.id) return invalid();
};
const freezeTree = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Validate supplied authenticated observations, not an independent signature or an atomic server snapshot.
 * Caller must still check identity/session/deletion at any FUTURE persistence boundary.
 * No raw provider metadata or run.provider_job_id survives in the returned proof.
 */
export const validateTranscriptHistoryBundle = async (input: {
  scope: Readonly<TranscriptHistoryCloudScope>; selectedVersionId: string;
  versions: readonly unknown[]; run: unknown; job: unknown; segments: readonly unknown[];
}, assertActive: () => void = () => {}): Promise<TranscriptHistoryBundle> => {
  assertActive();
  const scope = captureHistoryCloudRequest({ scope: input.scope }).scope;
  const selectedVersionId = historyCloudUuid(input.selectedVersionId);
  if (!Array.isArray(input.versions) || !Array.isArray(input.segments) || input.versions.length < 1) return invalid();
  if (input.versions.length > MAX_TRANSCRIPT_LINEAGE_DEPTH + 1 || input.segments.length > MAX_HISTORY_BUNDLE_SEGMENTS) return exceeded();
  historyBundleByteSize(input);
  const versions = input.versions.map((version) => parseHistoryCloudVersion(version, scope));
  if (versions[0].id !== selectedVersionId) return invalid();
  const ids = new Set<string>();
  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index];
    if (ids.has(version.id)) return invalid();
    ids.add(version.id);
    if (index > 0) assertHistoryBundleParent(versions[index - 1], version);
  }
  const provider = versions[versions.length - 1];
  const run = parseHistoryBundleRun(input.run);
  const job = parseHistoryBundleJob(input.job);
  const eligibility = assessHistoryBundleProof(provider, run, job);
  if (eligibility.kind !== "eligible") throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_NOT_ELIGIBLE");
  if (input.segments.length !== eligibility.expectedSegmentCount) return invalid();
  const segments = input.segments.map((segment) => parseHistoryBundleSegment(segment, provider, run));
  const segmentIds = new Set<string>();
  let previousStart = -1;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.segment_index !== index || segmentIds.has(segment.id) || segment.start_ms < previousStart) return invalid();
    segmentIds.add(segment.id); previousStart = segment.start_ms;
  }
  // Own detached copies before the first asynchronous digest.
  for (const version of versions) {
    assertActive();
    if (version.content_checksum_sha256 === null) return invalid();
    let digest: string;
    try { digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, version.plain_text); }
    catch { assertActive(); throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_HASH_UNAVAILABLE"); }
    assertActive();
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest)) throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_HASH_UNAVAILABLE");
    if (digest.toLowerCase() !== version.content_checksum_sha256) throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_CHECKSUM_MISMATCH");
  }
  assertActive();
  return freezeTree({ completeness: "managed_provider_bundle", versions, segments, provider: {
    versionId: provider.id, runId: run.id, jobId: job.id, recordingId: run.recording_id,
    cleanupCompletedAt: run.provider_cleanup_completed_at!, expectedSegmentCount: eligibility.expectedSegmentCount,
  } });
};
