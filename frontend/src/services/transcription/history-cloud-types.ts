/**
 * Authenticated cloud READ contracts. A version record is NOT a complete
 * provider bundle, proof of cleanup, cached evidence, or a current-switch command.
 */
export const TRANSCRIPT_HISTORY_CLOUD_SOURCE = "supabase_history_v1";
export const DEFAULT_HISTORY_CLOUD_PAGE_SIZE = 25;
export const MAX_HISTORY_CLOUD_PAGE_SIZE = 100;
export const DEFAULT_HISTORY_CLOUD_TIMEOUT_MS = 20_000;
export const MAX_HISTORY_CLOUD_TIMEOUT_MS = 60_000;
export const MAX_HISTORY_CLOUD_CONCURRENT_READS = 2;
export const MAX_HISTORY_CLOUD_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_HISTORY_CLOUD_METADATA_BYTES = 256 * 1024;
export const MAX_HISTORY_CLOUD_LANGUAGE_BYTES = 64 * 1024;
const MAX_VERSION = 2_147_483_647;

const errors = {
  HISTORY_CLOUD_INPUT_INVALID: ["The cloud history request is invalid.", false],
  HISTORY_CLOUD_NOT_CONFIGURED: ["Cloud history is not configured.", false],
  HISTORY_CLOUD_AUTH_REQUIRED: ["Sign in to the same account to read cloud history.", false],
  HISTORY_CLOUD_CONTEXT_INACTIVE: ["This cloud history request is no longer active.", false],
  HISTORY_CLOUD_DELETION_PENDING: ["Cloud history is paused during account deletion.", false],
  HISTORY_CLOUD_CANCELLED: ["The cloud history request was cancelled.", false],
  HISTORY_CLOUD_TIMEOUT: ["The cloud history request timed out.", true],
  HISTORY_CLOUD_BUSY: ["Other cloud history reads are still in progress.", true],
  HISTORY_CLOUD_NETWORK_UNAVAILABLE: ["Cloud history could not be reached.", true],
  HISTORY_CLOUD_RETRYABLE_QUERY: ["Cloud history is temporarily unavailable.", true],
  HISTORY_CLOUD_FORBIDDEN: ["This account cannot read the requested history.", false],
  HISTORY_CLOUD_QUERY_FAILED: ["The cloud history request could not be completed.", false],
  HISTORY_CLOUD_INVALID_RESPONSE: ["The cloud history response is invalid.", false],
  HISTORY_CLOUD_LIMIT_EXCEEDED: ["The cloud history response exceeds the supported read limits.", false],
} as const;
export type TranscriptHistoryCloudErrorCode = keyof typeof errors;

/** Static messages only: no raw response, token, SQL, text, or error cause. */
export class TranscriptHistoryCloudError extends Error {
  readonly code: TranscriptHistoryCloudErrorCode;
  readonly retryable: boolean;
  constructor(code: TranscriptHistoryCloudErrorCode) {
    super(errors[code][0]);
    this.name = "TranscriptHistoryCloudError";
    this.code = code;
    this.retryable = errors[code][1];
  }
}

export interface TranscriptHistoryCloudScope {
  userId: string;
  workspaceId: string;
  sessionId: string;
}
export interface TranscriptHistoryCloudCursor {
  /** Mandatory discriminator: a local-cache cursor is not a cloud cursor. */
  source: typeof TRANSCRIPT_HISTORY_CLOUD_SOURCE;
  scope: Readonly<TranscriptHistoryCloudScope>;
  upperVersion: number;
  beforeVersion: number;
}
export interface TranscriptHistoryCloudRequest {
  scope: Readonly<TranscriptHistoryCloudScope>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Synchronous view/request-lifetime check; never called from a React render. */
  isContextActive?: () => boolean;
}
export interface TranscriptHistoryCloudPageRequest extends TranscriptHistoryCloudRequest {
  pageSize?: number;
  cursor?: Readonly<TranscriptHistoryCloudCursor> | null;
}
export interface TranscriptHistoryCloudVersionRequest extends TranscriptHistoryCloudRequest {
  versionId: string;
  expectedVersion?: number;
}

/** Cloud observation only. Never feed is_current into a local history upsert. */
export interface TranscriptHistoryCloudSummary {
  id: string;
  workspace_id: string;
  session_id: string;
  version: number;
  version_origin: "provider" | "user_edit" | "import";
  version_status: "final";
  parent_version_id: string | null;
  created_by: string | null;
  transcription_run_id: string | null;
  content_checksum_sha256: string | null;
  created_at: string;
  updated_at: string;
  is_current: boolean;
}
export type HistoryCloudJson = null | boolean | number | string | HistoryCloudJson[] | { [key: string]: HistoryCloudJson };
export interface TranscriptHistoryCloudVersion extends TranscriptHistoryCloudSummary {
  plain_text: string;
  language_summary: { [key: string]: HistoryCloudJson };
}
export interface TranscriptHistoryCloudPage {
  source: typeof TRANSCRIPT_HISTORY_CLOUD_SOURCE;
  scope: Readonly<TranscriptHistoryCloudScope>;
  versions: TranscriptHistoryCloudSummary[];
  windowUpperVersion: number | null;
  nextCursor: TranscriptHistoryCloudCursor | null;
  /** True only on a valid EMPTY response, not a short page or proof of deletion. */
  visibleWindowExhausted: boolean;
}
export type TranscriptHistoryCloudDetail =
  | { kind: "not_visible"; source: typeof TRANSCRIPT_HISTORY_CLOUD_SOURCE;
      scope: Readonly<TranscriptHistoryCloudScope>; versionId: string }
  | { kind: "ready"; source: typeof TRANSCRIPT_HISTORY_CLOUD_SOURCE;
      scope: Readonly<TranscriptHistoryCloudScope>; completeness: "version_record_only";
      version: TranscriptHistoryCloudVersion };

export const HISTORY_CLOUD_SUMMARY_COLUMNS = [
  "id", "workspace_id", "session_id", "version", "version_origin", "version_status",
  "parent_version_id", "created_by", "transcription_run_id", "content_checksum_sha256",
  "created_at", "updated_at", "is_current",
] as const;
export const HISTORY_CLOUD_DETAIL_COLUMNS = [...HISTORY_CLOUD_SUMMARY_COLUMNS, "plain_text", "language_summary"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = (): never => { throw new TranscriptHistoryCloudError("HISTORY_CLOUD_INVALID_RESPONSE"); };
const badInput = (): never => { throw new TranscriptHistoryCloudError("HISTORY_CLOUD_INPUT_INVALID"); };
const limit = (): never => { throw new TranscriptHistoryCloudError("HISTORY_CLOUD_LIMIT_EXCEEDED"); };
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_VERSION;

export const historyCloudUuid = (value: unknown): string =>
  typeof value === "string" && UUID.test(value) ? value.toLowerCase() : badInput();
export const captureHistoryCloudRequest = (input: TranscriptHistoryCloudRequest) => {
  if (!isObject(input) || !isObject(input.scope)) badInput();
  const scope: TranscriptHistoryCloudScope = {
    userId: historyCloudUuid(input.scope.userId),
    workspaceId: historyCloudUuid(input.scope.workspaceId),
    sessionId: historyCloudUuid(input.scope.sessionId),
  };
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_HISTORY_CLOUD_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_HISTORY_CLOUD_TIMEOUT_MS ||
      (input.isContextActive !== undefined && typeof input.isContextActive !== "function")) badInput();
  const signal = input.signal;
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) badInput();
  return { scope, timeoutMs, signal, isContextActive: input.isContextActive };
};
export const captureHistoryCloudPage = (input: TranscriptHistoryCloudPageRequest) => {
  const context = captureHistoryCloudRequest(input);
  const pageSize = input.pageSize === undefined ? DEFAULT_HISTORY_CLOUD_PAGE_SIZE : input.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_CLOUD_PAGE_SIZE) badInput();
  let cursor: TranscriptHistoryCloudCursor | null = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    const candidate = input.cursor;
    if (!isObject(candidate) || candidate.source !== TRANSCRIPT_HISTORY_CLOUD_SOURCE ||
        !isObject(candidate.scope) || !isVersion(candidate.upperVersion) || !isVersion(candidate.beforeVersion) ||
        candidate.beforeVersion > candidate.upperVersion) badInput();
    const scope = captureHistoryCloudRequest({ scope: candidate.scope }).scope;
    if (scope.userId !== context.scope.userId || scope.workspaceId !== context.scope.workspaceId ||
        scope.sessionId !== context.scope.sessionId) badInput();
    cursor = { source: TRANSCRIPT_HISTORY_CLOUD_SOURCE, scope,
      upperVersion: candidate.upperVersion, beforeVersion: candidate.beforeVersion };
  }
  return { ...context, pageSize, cursor };
};
export const captureHistoryCloudVersion = (input: TranscriptHistoryCloudVersionRequest) => {
  const context = captureHistoryCloudRequest(input);
  const versionId = historyCloudUuid(input.versionId);
  if (input.expectedVersion !== undefined && !isVersion(input.expectedVersion)) badInput();
  return { ...context, versionId, expectedVersion: input.expectedVersion };
};

/** Decoded payload admission, NOT a streaming/network-download memory limit. */
export const assertHistoryCloudUtf8Budget = (value: string, maximum: number): void => {
  if (value.length > maximum) limit();
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
    else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    if (bytes > maximum) limit();
  }
};
const timestamp = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 40) return invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return invalid();
  return value;
};
const wireUuid = (value: unknown): string =>
  typeof value === "string" && UUID.test(value) ? value.toLowerCase() : invalid();
const nullableUuid = (value: unknown): string | null => value === null ? null : wireUuid(value);
const exactColumns = (input: unknown, columns: readonly string[]): Record<string, unknown> => {
  if (!isObject(input)) return invalid();
  const keys = Object.keys(input);
  if (keys.length !== columns.length || keys.some((key) => !columns.includes(key))) return invalid();
  return input;
};
export const parseHistoryCloudSummary = (
  input: unknown, scope: Readonly<TranscriptHistoryCloudScope>, detail = false,
): TranscriptHistoryCloudSummary => {
  const row = exactColumns(input, detail ? HISTORY_CLOUD_DETAIL_COLUMNS : HISTORY_CLOUD_SUMMARY_COLUMNS);
  const id = wireUuid(row.id);
  const workspaceId = wireUuid(row.workspace_id);
  const sessionId = wireUuid(row.session_id);
  const parent = nullableUuid(row.parent_version_id);
  const checksum = row.content_checksum_sha256;
  const origin = row.version_origin;
  if (workspaceId !== scope.workspaceId || sessionId !== scope.sessionId || !isVersion(row.version) ||
      row.version_status !== "final" || typeof row.is_current !== "boolean" || parent === id ||
      (origin !== "provider" && origin !== "user_edit" && origin !== "import") ||
      (checksum !== null && (typeof checksum !== "string" || !/^[a-f0-9]{64}$/i.test(checksum))) ||
      (origin === "user_edit" && (parent === null || checksum === null))) return invalid();
  return {
    id, workspace_id: workspaceId, session_id: sessionId, version: row.version,
    version_origin: origin, version_status: "final", parent_version_id: parent,
    created_by: nullableUuid(row.created_by), transcription_run_id: nullableUuid(row.transcription_run_id),
    content_checksum_sha256: checksum === null ? null : (checksum as string).toLowerCase(),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at), is_current: row.is_current,
  };
};
const cloneLanguage = (input: unknown): { [key: string]: HistoryCloudJson } => {
  if (!isObject(input)) return invalid();
  let nodes = 0;
  let budget = MAX_HISTORY_CLOUD_LANGUAGE_BYTES;
  const consume = (amount: number): void => { budget -= amount; if (budget < 0) limit(); };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 16) limit();
    if (typeof value === "string") {
      assertHistoryCloudUtf8Budget(value, budget);
      // JSON encoding also accounts for control characters and escapes.
      const encoded = JSON.stringify(value);
      assertHistoryCloudUtf8Budget(encoded, budget);
      consume(encoded.length); // Final UTF-8 check below accounts for non-ASCII.
    } else if (value === null || typeof value === "boolean") consume(5);
    else if (typeof value === "number" && Number.isFinite(value)) consume(String(value).length);
    else if (Array.isArray(value)) { consume(value.length + 2); value.forEach((entry) => visit(entry, depth + 1)); }
    else if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      const entries = Object.entries(value);
      consume(entries.length * 2 + 2);
      for (const [key, entry] of entries) { visit(key, depth + 1); visit(entry, depth + 1); }
    } else invalid();
  };
  visit(input, 0);
  const encoded = JSON.stringify(input);
  assertHistoryCloudUtf8Budget(encoded, MAX_HISTORY_CLOUD_LANGUAGE_BYTES);
  return JSON.parse(encoded) as { [key: string]: HistoryCloudJson };
};
export const parseHistoryCloudVersion = (
  input: unknown, scope: Readonly<TranscriptHistoryCloudScope>,
): TranscriptHistoryCloudVersion => {
  const summary = parseHistoryCloudSummary(input, scope, true);
  const row = input as Record<string, unknown>;
  if (typeof row.plain_text !== "string" || row.plain_text.includes("\0")) return invalid();
  assertHistoryCloudUtf8Budget(row.plain_text, MAX_HISTORY_CLOUD_TEXT_BYTES);
  if (summary.version_origin === "user_edit" && row.plain_text.trim().length === 0) return invalid();
  return { ...summary, plain_text: row.plain_text, language_summary: cloneLanguage(row.language_summary) };
};
