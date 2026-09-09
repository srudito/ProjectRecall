import type { SyncedTranscriptSegment, SyncedTranscriptVersionRecord } from "./result-types";

/**
 * Pure merge planning only. No storage, auth, hashing, or current-switch authority.
 * Inputs are decoded records, NOT raw database rows. Callers must recheck identity,
 * lifetime, deletion and global ID/number collisions in their owning transaction.
 */
export const MAX_CACHE_MERGE_SEGMENTS = 100_000;
export const MAX_CACHE_MERGE_JSON_DEPTH = 64;
export const MAX_CACHE_MERGE_JSON_NODES = 100_000;
export type TranscriptCacheMergeErrorCode =
  | "CACHE_MERGE_INVALID" | "CACHE_MERGE_CONFLICT" | "CACHE_MERGE_INCOMPLETE" | "CACHE_MERGE_LIMIT_EXCEEDED";
const messages: Record<TranscriptCacheMergeErrorCode, string> = {
  CACHE_MERGE_INVALID: "The transcript cache input is invalid.",
  CACHE_MERGE_CONFLICT: "The transcript conflicts with the existing cache.",
  CACHE_MERGE_INCOMPLETE: "The declared transcript segment coverage is incomplete.",
  CACHE_MERGE_LIMIT_EXCEEDED: "The transcript merge exceeds its structural limits.",
};
export class TranscriptCacheMergeError extends Error {
  readonly code: TranscriptCacheMergeErrorCode;
  constructor(code: TranscriptCacheMergeErrorCode) {
    super(messages[code]); this.name = "TranscriptCacheMergeError"; this.code = code;
  }
}
const fail = (code: TranscriptCacheMergeErrorCode = "CACHE_MERGE_INVALID"): never => {
  throw new TranscriptCacheMergeError(code);
};
const safe = <T>(operation: () => T): T => {
  try { return operation(); } catch (error) {
    if (error instanceof TranscriptCacheMergeError) throw error;
    return fail();
  }
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.includes("\0")) return fail();
  // Do not silently replace ill-formed UTF-16 or normalize transcript Unicode.
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return fail();
  }
  return value;
};
export const normalizeTranscriptCacheUuid = (value: unknown): string => {
  if (typeof value !== "string" || value.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return fail();
  return value.toLowerCase();
};

/** UTC, fixed six-digit fractional seconds: lexical comparison retains microseconds. */
export const normalizeTranscriptCacheInstant = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 32) return fail();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || parts[0] !== value) return fail();
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return fail();
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return fail();
  const zone = parts[8];
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3)); const minutes = Number(zone.slice(4));
    // RFC3339 numeric offsets. Reject negative zero (unknown local offset).
    if (hours > 23 || minutes > 59 || zone === "-00:00") return fail();
    date.setTime(date.getTime() - (zone[0] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000);
  }
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return fail();
  return `${date.toISOString().slice(0, 19)}.${(parts[7] ?? "").padEnd(6, "0")}Z`;
};
const record = (value: unknown, keys?: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const own = Reflect.ownKeys(value);
  if (keys && (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)))) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of own) {
    if (typeof key !== "string") return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) return fail();
    result[text(key)] = descriptor.value;
  }
  return result;
};
const array = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value)) return fail();
  if (value.length > maximum) return fail("CACHE_MERGE_LIMIT_EXCEEDED");
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result.push(descriptor.value);
  }
  return result;
};
const jsonCopy = (input: unknown): unknown => {
  let nodes = 0;
  const path = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (depth > MAX_CACHE_MERGE_JSON_DEPTH || nodes > MAX_CACHE_MERGE_JSON_NODES) return fail("CACHE_MERGE_LIMIT_EXCEEDED");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return text(value);
    if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    if (!value || typeof value !== "object" || path.has(value)) return fail();
    path.add(value);
    let output: unknown;
    if (Array.isArray(value)) output = Object.freeze(array(value, MAX_CACHE_MERGE_JSON_NODES).map((entry) => visit(entry, depth + 1)));
    else {
      const raw = record(value); const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(raw).sort()) result[key] = visit(raw[key], depth + 1);
      output = Object.freeze(result);
    }
    path.delete(value);
    return output;
  };
  return visit(input, 0);
};
const integer = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return fail();
  return value as number;
};
const nullableUuid = (value: unknown): string | null => value === null ? null : normalizeTranscriptCacheUuid(value);
const nullableText = (value: unknown): string | null => value === null ? null : text(value);
const checksum = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]+$/i.test(value)) return fail();
  return value.toLowerCase();
};
export interface TranscriptCacheScope { workspaceId: string; sessionId: string }
const captureScope = (input: unknown): TranscriptCacheScope => {
  const row = record(input, ["workspaceId", "sessionId"]);
  return { workspaceId: normalizeTranscriptCacheUuid(row.workspaceId), sessionId: normalizeTranscriptCacheUuid(row.sessionId) };
};
const VERSION_FIELDS = ["id", "workspace_id", "session_id", "transcription_run_id", "created_by", "version",
  "version_origin", "version_status", "parent_version_id", "plain_text", "language_summary",
  "content_checksum_sha256", "is_current", "created_at", "updated_at"] as const;
const captureVersion = (value: unknown): Readonly<SyncedTranscriptVersionRecord> => {
  const row = record(value, VERSION_FIELDS);
  if (!["provider", "user_edit", "import"].includes(row.version_origin as string) ||
      !["draft", "final"].includes(row.version_status as string) || typeof row.is_current !== "boolean") return fail();
  const language = record(row.language_summary);
  const result: SyncedTranscriptVersionRecord = {
    id: normalizeTranscriptCacheUuid(row.id), workspace_id: normalizeTranscriptCacheUuid(row.workspace_id),
    session_id: normalizeTranscriptCacheUuid(row.session_id), transcription_run_id: nullableUuid(row.transcription_run_id),
    created_by: nullableUuid(row.created_by), version: integer(row.version, 1, 2_147_483_647),
    version_origin: row.version_origin as SyncedTranscriptVersionRecord["version_origin"],
    version_status: row.version_status as SyncedTranscriptVersionRecord["version_status"],
    parent_version_id: nullableUuid(row.parent_version_id), plain_text: text(row.plain_text),
    language_summary: jsonCopy(language) as Record<string, unknown>, content_checksum_sha256: checksum(row.content_checksum_sha256),
    is_current: row.is_current, created_at: text(row.created_at), updated_at: text(row.updated_at),
  };
  if (result.parent_version_id === result.id || (result.version_origin === "user_edit" &&
      (result.version_status !== "final" || result.parent_version_id === null ||
       result.content_checksum_sha256 === null || !result.plain_text.replace(/^ +| +$/g, "")))) return fail();
  normalizeTranscriptCacheInstant(result.created_at); normalizeTranscriptCacheInstant(result.updated_at);
  return Object.freeze(result);
};
const requireScope = (row: { workspace_id: string; session_id: string }, scope: TranscriptCacheScope): void => {
  if (row.workspace_id !== scope.workspaceId || row.session_id !== scope.sessionId) fail("CACHE_MERGE_CONFLICT");
};
export interface TranscriptCacheVersionPlan {
  readonly kind: "insert" | "unchanged" | "clear_provenance";
  readonly version: Readonly<SyncedTranscriptVersionRecord>;
  readonly cleared: readonly ("created_by" | "transcription_run_id")[];
}

/**
 * Existing current marker ALWAYS wins; inserts are non-current. Timestamp-only
 * observations are replays. On null clearing retain the later observed timestamp.
 * A separate current-switch adapter must authorize any pointer change itself.
 * No checksum is computed here: equality is not independent content verification.
 */
export const planTranscriptCacheVersion = (
  existing: unknown | null, incoming: unknown, inputScope: TranscriptCacheScope,
): TranscriptCacheVersionPlan => safe(() => {
  const scope = captureScope(inputScope); const next = captureVersion(incoming); requireScope(next, scope);
  if (existing === null) return Object.freeze({ kind: "insert", version: Object.freeze({ ...next, is_current: false }), cleared: Object.freeze([]) });
  const local = captureVersion(existing); requireScope(local, scope);
  const immutable = ["id", "version", "version_origin", "version_status", "parent_version_id", "plain_text", "content_checksum_sha256"] as const;
  if (immutable.some((key) => local[key] !== next[key]) ||
      normalizeTranscriptCacheInstant(local.created_at) !== normalizeTranscriptCacheInstant(next.created_at) ||
      JSON.stringify(local.language_summary) !== JSON.stringify(next.language_summary)) return fail("CACHE_MERGE_CONFLICT");
  const cleared: ("created_by" | "transcription_run_id")[] = [];
  const result = { ...local };
  for (const key of ["created_by", "transcription_run_id"] as const) {
    if (local[key] !== null && next[key] !== null && local[key] !== next[key]) return fail("CACHE_MERGE_CONFLICT");
    if (local[key] !== null && next[key] === null) { result[key] = null; cleared.push(key); }
  }
  if (cleared.length > 0 && normalizeTranscriptCacheInstant(next.updated_at) > normalizeTranscriptCacheInstant(local.updated_at)) {
    result.updated_at = next.updated_at;
  }
  return Object.freeze({ kind: cleared.length ? "clear_provenance" : "unchanged", version: Object.freeze(result), cleared: Object.freeze(cleared) });
});

const SEGMENT_FIELDS = ["id", "workspace_id", "session_id", "transcript_version_id", "segment_index", "start_ms", "end_ms",
  "text", "language_code", "speaker_label", "confidence", "provider_segment_id", "created_at", "updated_at"] as const;
const captureSegment = (value: unknown): Readonly<SyncedTranscriptSegment> => {
  const row = record(value, SEGMENT_FIELDS);
  const start = integer(row.start_ms, 0); const end = integer(row.end_ms, start); const segmentText = text(row.text);
  if (!segmentText.trim() || (row.confidence !== null &&
      (typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1))) return fail();
  const result: SyncedTranscriptSegment = {
    id: normalizeTranscriptCacheUuid(row.id), workspace_id: normalizeTranscriptCacheUuid(row.workspace_id),
    session_id: normalizeTranscriptCacheUuid(row.session_id), transcript_version_id: normalizeTranscriptCacheUuid(row.transcript_version_id),
    segment_index: integer(row.segment_index, 0), start_ms: start, end_ms: end, text: segmentText,
    language_code: nullableText(row.language_code), speaker_label: nullableText(row.speaker_label),
    confidence: row.confidence as number | null, provider_segment_id: nullableText(row.provider_segment_id),
    created_at: text(row.created_at), updated_at: text(row.updated_at),
  };
  normalizeTranscriptCacheInstant(result.created_at); normalizeTranscriptCacheInstant(result.updated_at);
  return Object.freeze(result);
};
export type TranscriptSegmentCoverage = { kind: "partial" } | { kind: "complete"; expectedSegmentCount: number };
export interface TranscriptCacheSegmentPlan {
  readonly kind: "unchanged" | "append";
  readonly segmentsToInsert: readonly Readonly<SyncedTranscriptSegment>[];
  readonly coverage: "not_proven" | "declared_complete";
}

/**
 * Append-only plan, never delete or update segments. Completeness is a CALLER
 * assertion checked for internal consistency, not provider/cleanup proof. General
 * imports, nullable segment identifiers and non-en/id languages remain supported.
 */
export const planTranscriptCacheSegments = (
  version: unknown, existing: readonly unknown[], incoming: readonly unknown[],
  coverage: TranscriptSegmentCoverage, inputScope: TranscriptCacheScope,
): TranscriptCacheSegmentPlan => safe(() => {
  const scope = captureScope(inputScope); const owner = captureVersion(version); requireScope(owner, scope);
  const cover = record(coverage);
  if (cover.kind === "partial") record(cover, ["kind"]);
  else if (cover.kind === "complete") {
    record(cover, ["kind", "expectedSegmentCount"]); integer(cover.expectedSegmentCount, 0, MAX_CACHE_MERGE_SEGMENTS);
  } else return fail();
  const capture = (items: unknown): Readonly<SyncedTranscriptSegment>[] => {
    const rows = array(items, MAX_CACHE_MERGE_SEGMENTS).map(captureSegment);
    const ids = new Set<string>(); const indices = new Set<number>();
    for (const row of rows) {
      requireScope(row, scope);
      if (row.transcript_version_id !== owner.id || ids.has(row.id) || indices.has(row.segment_index)) return fail("CACHE_MERGE_CONFLICT");
      ids.add(row.id); indices.add(row.segment_index);
    }
    return rows.sort((a, b) => a.segment_index - b.segment_index);
  };
  const local = capture(existing); const next = capture(incoming);
  if (owner.version_origin === "user_edit" && (local.length || next.length)) return fail("CACHE_MERGE_CONFLICT");
  if (cover.kind === "complete" && (next.length !== cover.expectedSegmentCount ||
      next.some((segment, index) => segment.segment_index !== index))) return fail("CACHE_MERGE_INCOMPLETE");
  const byId = new Map(local.map((row) => [row.id, row]));
  const byIndex = new Map(local.map((row) => [row.segment_index, row]));
  const additions: Readonly<SyncedTranscriptSegment>[] = [];
  for (const row of next) {
    const match = byIndex.get(row.segment_index); const sameId = byId.get(row.id);
    if ((sameId && sameId.segment_index !== row.segment_index) || (match && match.id !== row.id)) return fail("CACHE_MERGE_CONFLICT");
    if (!match) additions.push(row);
    else for (const key of SEGMENT_FIELDS) {
      const equal = key === "created_at" || key === "updated_at"
        ? normalizeTranscriptCacheInstant(match[key]) === normalizeTranscriptCacheInstant(row[key]) : match[key] === row[key];
      if (!equal) return fail("CACHE_MERGE_CONFLICT");
    }
  }
  if (cover.kind === "complete" && local.some((row) => row.segment_index >= next.length)) return fail("CACHE_MERGE_CONFLICT");
  if (local.length + additions.length > MAX_CACHE_MERGE_SEGMENTS) return fail("CACHE_MERGE_LIMIT_EXCEEDED");
  return Object.freeze({ kind: additions.length ? "append" : "unchanged", segmentsToInsert: Object.freeze(additions),
    coverage: cover.kind === "complete" ? "declared_complete" : "not_proven" });
});
