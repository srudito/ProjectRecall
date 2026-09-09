import * as Crypto from "expo-crypto";

import {
  assertHistoryBundleParent,
  HISTORY_BUNDLE_SEGMENT_COLUMNS,
  HISTORY_BUNDLE_SOURCE,
  historyBundleByteSize,
  historyBundleInstant,
  type TranscriptHistoryBundleResult,
} from "./history-bundle-types";
import {
  assertHistoryCloudUtf8Budget,
  captureHistoryCloudRequest,
  HISTORY_CLOUD_DETAIL_COLUMNS,
  historyCloudUuid,
  parseHistoryCloudVersion,
  TranscriptHistoryCloudError,
  type TranscriptHistoryCloudScope,
  type TranscriptHistoryCloudVersion,
} from "./history-cloud-types";
import { MAX_TRANSCRIPT_LINEAGE_DEPTH, type SyncedTranscriptSegment } from "./result-types";

// Persistence budgets are deliberately smaller than the collector's read budgets.
export const MAX_HISTORY_CACHE_SEGMENTS = 5_000;
export const MAX_HISTORY_CACHE_BYTES = 8 * 1024 * 1024;
export const HISTORY_CACHE_VERSION_COLUMNS = HISTORY_CLOUD_DETAIL_COLUMNS;
export const HISTORY_CACHE_SEGMENT_COLUMNS = HISTORY_BUNDLE_SEGMENT_COLUMNS;
const messages = {
  HISTORY_CACHE_INPUT_INVALID: "The history cache request is invalid.",
  HISTORY_CACHE_AUTH_REQUIRED: "Sign in to the same account to cache this history.",
  HISTORY_CACHE_CONTEXT_INACTIVE: "This history cache operation is no longer active.",
  HISTORY_CACHE_DELETION_PENDING: "History caching is paused during deletion.",
  HISTORY_CACHE_CANCELLED: "The history cache operation was cancelled before commit.",
  HISTORY_CACHE_TIMEOUT: "The history cache operation expired before commit.",
  HISTORY_CACHE_BUSY: "Local history storage is busy. Retry later.",
  HISTORY_CACHE_STORAGE_UNAVAILABLE: "Local history storage is unavailable.",
  HISTORY_CACHE_SESSION_UNAVAILABLE: "The local session is no longer available.",
  HISTORY_CACHE_BUNDLE_INVALID: "The history bundle is inconsistent.",
  HISTORY_CACHE_BUNDLE_NOT_READY: "The history bundle is not ready to cache.",
  HISTORY_CACHE_BUNDLE_UNAVAILABLE: "The required history evidence is unavailable.",
  HISTORY_CACHE_FETCH_FAILED: "The history bundle could not be collected.",
  HISTORY_CACHE_FETCH_RETRYABLE: "The history bundle is temporarily unavailable.",
  HISTORY_CACHE_LIMIT_EXCEEDED: "The history exceeds the supported local cache limits.",
  HISTORY_CACHE_CHECKSUM_MISMATCH: "The history text does not match its checksum.",
  HISTORY_CACHE_HASH_UNAVAILABLE: "History checksum verification is unavailable.",
  HISTORY_CACHE_CONFLICT: "The history conflicts with the existing local cache.",
  HISTORY_CACHE_RESULT_SYNC_OWNED: "The result worker must finish this local request first.",
  HISTORY_CACHE_WRITE_FAILED: "The history cache operation did not complete.",
  HISTORY_CACHE_COMMIT_UNCONFIRMED: "The history commit outcome needs verification before retry.",
  HISTORY_CACHE_RESOURCES_PENDING: "Local history write resources have not been released.",
} as const;
export type HistoryCacheErrorCode = keyof typeof messages;
export class HistoryCacheError extends Error {
  readonly code: HistoryCacheErrorCode;
  constructor(code: HistoryCacheErrorCode) {
    super(messages[code]);
    this.name = "HistoryCacheError";
    this.code = code;
  }
}
export const historyCacheError = (code: HistoryCacheErrorCode): HistoryCacheError => new HistoryCacheError(code);
export const normalizeHistoryCacheError = (failure: unknown): HistoryCacheError =>
  failure instanceof HistoryCacheError ? failure : historyCacheError("HISTORY_CACHE_WRITE_FAILED");
export interface HistoryCacheResult {
  kind: "committed" | "unchanged" | "deferred_to_result_sync" | "not_ready" | "unavailable" |
    "rejected" | "retryable" | "indeterminate";
  code: HistoryCacheErrorCode | null;
  resources: "released" | "pending";
  resourceError: "HISTORY_CACHE_RESOURCES_PENDING" | null;
  insertedVersions: number;
  insertedSegments: number;
  clearedProvenance: number;
}
export const historyCacheResult = (
  kind: HistoryCacheResult["kind"], code: HistoryCacheErrorCode | null = null,
): HistoryCacheResult => ({ kind, code, resources: "released", resourceError: null,
  insertedVersions: 0, insertedSegments: 0, clearedProvenance: 0 });

const invalid = (): never => { throw historyCacheError("HISTORY_CACHE_BUNDLE_INVALID"); };
const conflict = (): never => { throw historyCacheError("HISTORY_CACHE_CONFLICT"); };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: unknown, columns: readonly string[]): Record<string, unknown> => {
  if (!object(value)) return invalid();
  const keys = Object.keys(value);
  if (keys.length !== columns.length || keys.some((key) => !columns.includes(key))) return invalid();
  return value;
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const instant = (value: unknown): string => { historyBundleInstant(value); return value as string; };
const text = (value: unknown, maximum: number): string => {
  if (typeof value !== "string" || value.includes("\0")) return invalid();
  assertHistoryCloudUtf8Budget(value, maximum);
  return value;
};

/** Validate returned segment structure without inventing a run/job from summary proof. */
const captureSegment = (input: unknown): SyncedTranscriptSegment => {
  const row = exact(input, HISTORY_CACHE_SEGMENT_COLUMNS);
  if (!Number.isSafeInteger(row.segment_index) || (row.segment_index as number) < 0 ||
      !Number.isSafeInteger(row.start_ms) || (row.start_ms as number) < 0 ||
      !Number.isSafeInteger(row.end_ms) || (row.end_ms as number) < (row.start_ms as number) ||
      (row.confidence !== null && (typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)) ||
      (row.language_code !== null && row.language_code !== "en" && row.language_code !== "id")) return invalid();
  const value = text(row.text, 10_000);
  const speaker = row.speaker_label === null ? null : text(row.speaker_label, 800);
  if (!value.trim() || (speaker !== null && (!speaker.trim() || speaker.length > 200 || [...speaker].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)))) return invalid();
  const providerId = text(row.provider_segment_id, 100);
  const parts = providerId.split(":");
  if (parts.length !== 3 || parts[1] !== "word" || parts[2] !== String(row.segment_index)) return invalid();
  historyCloudUuid(parts[0]);
  return { id: historyCloudUuid(row.id), workspace_id: historyCloudUuid(row.workspace_id),
    session_id: historyCloudUuid(row.session_id), transcript_version_id: historyCloudUuid(row.transcript_version_id),
    segment_index: row.segment_index as number, start_ms: row.start_ms as number, end_ms: row.end_ms as number,
    text: value, language_code: row.language_code, speaker_label: speaker, confidence: row.confidence as number | null,
    provider_segment_id: providerId, created_at: instant(row.created_at), updated_at: instant(row.updated_at) };
};

export interface PreparedHistoryCacheData {
  readonly scope: Readonly<TranscriptHistoryCloudScope>;
  readonly selectedVersionId: string;
  readonly versions: readonly Readonly<TranscriptHistoryCloudVersion>[];
  readonly segments: readonly Readonly<SyncedTranscriptSegment>[];
  readonly provider: Readonly<{ versionId: string; runId: string; jobId: string; recordingId: string }>;
  readonly assertActive: () => void;
}
declare const commandBrand: unique symbol;
export interface PreparedHistoryCacheCommand { readonly [commandBrand]: true }
const commands = new WeakMap<PreparedHistoryCacheCommand, PreparedHistoryCacheData>();

/**
 * INTERNAL handoff from the trusted collector service, not a public import API.
 * The registry prevents accidental forged/reused commands; it is NOT a security
 * boundary or independent proof of server cleanup. Never synthesize run/job rows.
 * Detached copies and hashes are prepared outside any SQLite transaction.
 */
export const prepareHistoryCacheCommand = async (
  result: Extract<TranscriptHistoryBundleResult, { kind: "ready" }>, assertActive: () => void,
): Promise<PreparedHistoryCacheCommand> => {
  if (typeof assertActive !== "function") throw historyCacheError("HISTORY_CACHE_INPUT_INVALID");
  assertActive();
  let data: PreparedHistoryCacheData;
  try {
    const row = exact(result, ["kind", "source", "scope", "selectedVersionId", "bundle"]);
    if (row.kind !== "ready" || row.source !== HISTORY_BUNDLE_SOURCE) return invalid();
    const scope = captureHistoryCloudRequest({ scope: result.scope }).scope;
    const selectedVersionId = historyCloudUuid(result.selectedVersionId);
    const bundle = exact(row.bundle, ["completeness", "versions", "segments", "provider"]);
    if (bundle.completeness !== "managed_provider_bundle" || !Array.isArray(bundle.versions) ||
        !Array.isArray(bundle.segments) || bundle.versions.length === 0) return invalid();
    if (bundle.versions.length > MAX_TRANSCRIPT_LINEAGE_DEPTH + 1 || bundle.segments.length > MAX_HISTORY_CACHE_SEGMENTS) {
      throw historyCacheError("HISTORY_CACHE_LIMIT_EXCEEDED");
    }
    try { historyBundleByteSize(result, MAX_HISTORY_CACHE_BYTES); }
    catch (failure) {
      if (failure instanceof TranscriptHistoryCloudError && failure.code === "HISTORY_CLOUD_LIMIT_EXCEEDED") {
        throw historyCacheError("HISTORY_CACHE_LIMIT_EXCEEDED");
      }
      return invalid();
    }
    const versions = bundle.versions.map((value) => parseHistoryCloudVersion(value, scope));
    if (versions[0].id !== selectedVersionId || new Set(versions.map((v) => v.id)).size !== versions.length) return invalid();
    for (let i = 0; i < versions.length; i += 1) {
      historyBundleInstant(versions[i].created_at); historyBundleInstant(versions[i].updated_at);
      if (versions[i].content_checksum_sha256 === null) return invalid();
      if (i > 0) assertHistoryBundleParent(versions[i - 1], versions[i]);
    }
    const leaf = versions[versions.length - 1];
    const proof = exact(bundle.provider, ["versionId", "runId", "jobId", "recordingId", "cleanupCompletedAt", "expectedSegmentCount"]);
    const provider = { versionId: historyCloudUuid(proof.versionId), runId: historyCloudUuid(proof.runId),
      jobId: historyCloudUuid(proof.jobId), recordingId: historyCloudUuid(proof.recordingId) };
    historyBundleInstant(proof.cleanupCompletedAt);
    if (leaf.version_origin !== "provider" || leaf.parent_version_id !== null || !leaf.plain_text.trim() ||
        leaf.id !== provider.versionId || leaf.transcription_run_id !== provider.runId ||
        !Number.isSafeInteger(proof.expectedSegmentCount) || (proof.expectedSegmentCount as number) < 1 ||
        bundle.segments.length !== proof.expectedSegmentCount) return invalid();
    const segments = bundle.segments.map(captureSegment);
    const ids = new Set<string>(); let start = -1; let prefix: string | null = null;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]; const artifact = segment.provider_segment_id!.split(":")[0];
      if (segment.workspace_id !== scope.workspaceId || segment.session_id !== scope.sessionId ||
          segment.transcript_version_id !== provider.versionId || segment.segment_index !== i ||
          ids.has(segment.id) || segment.start_ms < start || (prefix !== null && prefix !== artifact)) return invalid();
      ids.add(segment.id); start = segment.start_ms; prefix = artifact;
    }
    data = freeze({ scope, selectedVersionId, versions, segments, provider, assertActive });
  } catch (failure) {
    if (failure instanceof HistoryCacheError) throw failure;
    return invalid();
  }
  for (const version of data.versions) {
    assertActive();
    let digest: string;
    try { digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, version.plain_text); }
    catch { assertActive(); throw historyCacheError("HISTORY_CACHE_HASH_UNAVAILABLE"); }
    assertActive();
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) throw historyCacheError("HISTORY_CACHE_HASH_UNAVAILABLE");
    if (digest.toLowerCase() !== version.content_checksum_sha256) throw historyCacheError("HISTORY_CACHE_CHECKSUM_MISMATCH");
  }
  assertActive();
  const command = Object.freeze({}) as PreparedHistoryCacheCommand;
  commands.set(command, data);
  return command;
};
export const consumeHistoryCacheCommand = (command: PreparedHistoryCacheCommand): PreparedHistoryCacheData => {
  const data = command && typeof command === "object" ? commands.get(command) : undefined;
  if (!data) throw historyCacheError("HISTORY_CACHE_INPUT_INVALID");
  commands.delete(command);
  data.assertActive();
  return data;
};
export const revokeHistoryCacheCommand = (command: PreparedHistoryCacheCommand): void => { commands.delete(command); };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

/** Existing immutable content must match. Only monotonic null clearing may merge. */
export const reconcileCachedHistoryVersion = (
  row: unknown, incoming: Readonly<TranscriptHistoryCloudVersion>, scope: Readonly<TranscriptHistoryCloudScope>,
): { createdBy: string | null; runId: string | null; updatedAt: string; changed: boolean } => {
  try {
    const raw = exact(row, HISTORY_CACHE_VERSION_COLUMNS);
    if ((raw.is_current !== 0 && raw.is_current !== 1) || typeof raw.language_summary !== "string") return conflict();
    const local = parseHistoryCloudVersion({ ...raw, is_current: raw.is_current === 1,
      language_summary: JSON.parse(raw.language_summary) }, scope);
    const immutable = ["id", "workspace_id", "session_id", "version", "version_origin", "version_status",
      "parent_version_id", "plain_text", "content_checksum_sha256"] as const;
    if (immutable.some((key) => local[key] !== incoming[key]) ||
        historyBundleInstant(local.created_at) !== historyBundleInstant(incoming.created_at) ||
        canonical(local.language_summary) !== canonical(incoming.language_summary)) return conflict();
    for (const key of ["created_by", "transcription_run_id"] as const) {
      if (local[key] !== null && incoming[key] !== null && local[key] !== incoming[key]) return conflict();
    }
    const createdBy = local.created_by === null ? null : incoming.created_by;
    const runId = local.transcription_run_id === null ? null : incoming.transcription_run_id;
    const changed = createdBy !== local.created_by || runId !== local.transcription_run_id;
    const updatedAt = historyBundleInstant(incoming.updated_at) > historyBundleInstant(local.updated_at)
      ? incoming.updated_at : local.updated_at;
    return { createdBy, runId, updatedAt: changed ? updatedAt : local.updated_at, changed };
  } catch { return conflict(); }
};
export const assertCachedHistorySegment = (row: unknown, incoming: Readonly<SyncedTranscriptSegment>): void => {
  try {
    const local = captureSegment(row);
    for (const key of HISTORY_CACHE_SEGMENT_COLUMNS) {
      if (key === "created_at" || key === "updated_at") {
        if (historyBundleInstant(local[key]) !== historyBundleInstant(incoming[key])) return conflict();
      } else if (local[key] !== incoming[key]) return conflict();
    }
  } catch { return conflict(); }
};
