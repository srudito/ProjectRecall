import { normalizeTranscriptCacheInstant, normalizeTranscriptCacheUuid } from "./cache-merge";

/**
 * Pure codec/planner for a future local_sync_state receipt. Encoding is NOT a
 * completion proof or permission to write. Only result reconciliation may later
 * persist a receipt atomically with validated evidence and request diagnostics.
 * Receipt validity says nothing about CURRENT cache availability or user access.
 */
export const RESULT_RECEIPT_NAMESPACE = "transcription/result-reconciled/v1/";
export const MAX_RESULT_RECEIPT_BYTES = 4096;
export const MAX_RESULT_RECEIPT_REQUEST_BYTES = 256;
export const MAX_RESULT_RECEIPT_SEGMENTS = 100_000;
export interface ResultReceiptIdentity {
  userId: string;
  workspaceId: string;
  sessionId: string;
  recordingId: string;
  jobId: string;
  /** Opaque local ID: preserve case/content; never generate or substitute an ID. */
  requestId: string;
}
export interface TranscriptionResultReceipt extends ResultReceiptIdentity {
  schemaVersion: 1;
  kind: "result_reconciled";
  resultVersionId: string;
  resultVersion: number;
  contentChecksum: string;
  expectedSegments: number;
  reconciledAt: string;
}
export interface ResultReceiptRow {
  readonly key: string;
  readonly value: string;
  readonly updated_at: string;
}
export type ResultReceiptErrorCode = "RESULT_RECEIPT_INVALID" | "RESULT_RECEIPT_SCOPE_MISMATCH" |
  "RESULT_RECEIPT_CONFLICT" | "RESULT_RECEIPT_LIMIT_EXCEEDED";
const messages: Record<ResultReceiptErrorCode, string> = {
  RESULT_RECEIPT_INVALID: "The result receipt is invalid.",
  RESULT_RECEIPT_SCOPE_MISMATCH: "The result receipt belongs to a different request.",
  RESULT_RECEIPT_CONFLICT: "The result receipt conflicts with prior reconciliation.",
  RESULT_RECEIPT_LIMIT_EXCEEDED: "The result receipt exceeds its size limit.",
};
export class ResultReceiptError extends Error {
  readonly code: ResultReceiptErrorCode;
  constructor(code: ResultReceiptErrorCode) { super(messages[code]); this.name = "ResultReceiptError"; this.code = code; }
}
const fail = (code: ResultReceiptErrorCode = "RESULT_RECEIPT_INVALID"): never => { throw new ResultReceiptError(code); };
const safe = <T>(operation: () => T): T => {
  try { return operation(); } catch (error) {
    if (error instanceof ResultReceiptError) throw error;
    return fail();
  }
};
const ID_FIELDS = ["userId", "workspaceId", "sessionId", "recordingId", "jobId", "requestId"] as const;
const FIELDS = ["schemaVersion", "kind", ...ID_FIELDS, "resultVersionId", "resultVersion",
  "contentChecksum", "expectedSegments", "reconciledAt"] as const;
const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
};
const boundedString = (value: unknown, maximum: number): string => {
  if (typeof value !== "string") return fail();
  if (value.length > maximum) return fail("RESULT_RECEIPT_LIMIT_EXCEEDED");
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail();
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return fail();
    else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    if (bytes > maximum) return fail("RESULT_RECEIPT_LIMIT_EXCEEDED");
  }
  return value;
};
const requestId = (value: unknown): string => {
  const result = boundedString(value, MAX_RESULT_RECEIPT_REQUEST_BYTES);
  if (!result || result.trim() !== result || [...result].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
  return result;
};
const identity = (input: unknown): Readonly<ResultReceiptIdentity> => {
  const row = record(input, ID_FIELDS);
  return Object.freeze({ userId: normalizeTranscriptCacheUuid(row.userId), workspaceId: normalizeTranscriptCacheUuid(row.workspaceId),
    sessionId: normalizeTranscriptCacheUuid(row.sessionId), recordingId: normalizeTranscriptCacheUuid(row.recordingId),
    jobId: normalizeTranscriptCacheUuid(row.jobId), requestId: requestId(row.requestId) });
};
const identityOf = (row: Record<string, unknown> | TranscriptionResultReceipt): Readonly<ResultReceiptIdentity> =>
  identity({ userId: row.userId, workspaceId: row.workspaceId, sessionId: row.sessionId,
    recordingId: row.recordingId, jobId: row.jobId, requestId: row.requestId });
const keyOf = (scope: Readonly<ResultReceiptIdentity>): string =>
  RESULT_RECEIPT_NAMESPACE + ID_FIELDS.map((key) => encodeURIComponent(scope[key])).join("/");

export const resultReceiptKey = (input: ResultReceiptIdentity): string => safe(() => keyOf(identity(input)));

/** Parse only the key: scoped cleanup can identify rows even if value is corrupt. */
export const parseResultReceiptKey = (input: unknown): Readonly<ResultReceiptIdentity> => safe(() => {
  const key = boundedString(input, MAX_RESULT_RECEIPT_BYTES);
  if (!key.startsWith(RESULT_RECEIPT_NAMESPACE)) return fail();
  const parts = key.slice(RESULT_RECEIPT_NAMESPACE.length).split("/");
  if (parts.length !== ID_FIELDS.length) return fail();
  const scope = identity(Object.fromEntries(ID_FIELDS.map((field, i) => [field, decodeURIComponent(parts[i])])));
  if (keyOf(scope) !== key) return fail(); // One canonical, delimiter-safe spelling.
  return scope;
});
const positive = (value: unknown, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) return fail();
  return value as number;
};
const captureReceipt = (input: unknown): Readonly<TranscriptionResultReceipt> => {
  const row = record(input, FIELDS);
  if (row.schemaVersion !== 1 || row.kind !== "result_reconciled" || typeof row.contentChecksum !== "string" ||
      row.contentChecksum.length !== 64 || !/^[0-9a-f]+$/i.test(row.contentChecksum)) return fail();
  return Object.freeze({ schemaVersion: 1, kind: "result_reconciled", ...identityOf(row),
    resultVersionId: normalizeTranscriptCacheUuid(row.resultVersionId), resultVersion: positive(row.resultVersion, 2_147_483_647),
    contentChecksum: row.contentChecksum.toLowerCase(), expectedSegments: positive(row.expectedSegments, MAX_RESULT_RECEIPT_SEGMENTS),
    reconciledAt: normalizeTranscriptCacheInstant(row.reconciledAt) });
};
const encode = (receipt: Readonly<TranscriptionResultReceipt>): Readonly<ResultReceiptRow> => Object.freeze({
  key: keyOf(receipt), value: boundedString(JSON.stringify(receipt), MAX_RESULT_RECEIPT_BYTES), updated_at: receipt.reconciledAt,
});
export const encodeTranscriptionResultReceipt = (input: TranscriptionResultReceipt): Readonly<ResultReceiptRow> =>
  safe(() => encode(captureReceipt(input)));

/**
 * Flat-schema JSON scanner. Decode each key BEFORE duplicate checks. A reviver
 * cannot detect duplicate names after JSON.parse has already overwritten them.
 * Nested values, unknown fields and non-decimal integer tokens are not this format.
 */
const parseReceiptJson = (input: unknown): Readonly<TranscriptionResultReceipt> => {
  const source = boundedString(input, MAX_RESULT_RECEIPT_BYTES);
  let offset = 0;
  const skip = (): void => { while (offset < source.length && /[ \t\r\n]/.test(source[offset])) offset += 1; };
  const take = (char: string): void => { skip(); if (source[offset++] !== char) fail(); };
  const string = (): string => {
    skip(); const start = offset;
    if (source[offset++] !== '"') return fail();
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") { offset += 1; continue; }
      if (char === '"') {
        const result: unknown = JSON.parse(source.slice(start, offset));
        if (typeof result !== "string") return fail();
        return result;
      }
    }
    return fail();
  };
  take("{"); skip();
  const row: Record<string, unknown> = Object.create(null);
  const seen = new Set<string>();
  while (source[offset] !== "}") {
    const key = string();
    if (!FIELDS.includes(key as typeof FIELDS[number]) || seen.has(key)) return fail();
    seen.add(key); take(":"); skip();
    if (source[offset] === '"') row[key] = string();
    else {
      const start = offset;
      while (offset < source.length && !/[,}\s]/.test(source[offset])) offset += 1;
      const token = source.slice(start, offset);
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return fail();
      row[key] = Number(token);
    }
    skip();
    if (source[offset] === "}") break;
    take(","); skip();
    if (source[offset] === "}") return fail();
  }
  take("}"); skip(); if (offset !== source.length) return fail();
  return captureReceipt(row);
};
export const decodeTranscriptionResultReceipt = (
  input: unknown, expected: ResultReceiptIdentity,
): Readonly<TranscriptionResultReceipt> => safe(() => {
  const row = record(input, ["key", "value", "updated_at"]); const scope = identity(expected);
  const keyScope = parseResultReceiptKey(row.key);
  if (keyOf(keyScope) !== keyOf(scope)) return fail("RESULT_RECEIPT_SCOPE_MISMATCH");
  const receipt = parseReceiptJson(row.value);
  if (keyOf(receipt) !== keyOf(scope)) return fail("RESULT_RECEIPT_SCOPE_MISMATCH");
  if (normalizeTranscriptCacheInstant(row.updated_at) !== receipt.reconciledAt) return fail();
  return receipt;
});

/** Preserve the FIRST receipt/time on identical replay. No overwrite or backfill inference. */
export const planTranscriptionResultReceipt = (
  existing: unknown | null, incoming: TranscriptionResultReceipt,
): Readonly<{ kind: "insert" | "unchanged"; row: Readonly<ResultReceiptRow> }> => safe(() => {
  const next = captureReceipt(incoming);
  if (existing === null) return Object.freeze({ kind: "insert", row: encode(next) });
  const previous = decodeTranscriptionResultReceipt(existing, identityOf(next));
  if (FIELDS.some((key) => key !== "reconciledAt" && previous[key] !== next[key])) return fail("RESULT_RECEIPT_CONFLICT");
  const raw = record(existing, ["key", "value", "updated_at"]);
  return Object.freeze({ kind: "unchanged", row: Object.freeze({ key: raw.key as string,
    value: raw.value as string, updated_at: raw.updated_at as string }) });
});
