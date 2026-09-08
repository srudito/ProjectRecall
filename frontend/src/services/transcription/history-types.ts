/** Local read contracts only. No history ingestion, editor ownership or restore. */
export const DEFAULT_TRANSCRIPT_HISTORY_PAGE_SIZE = 25;
export const MAX_TRANSCRIPT_HISTORY_PAGE_SIZE = 100;
export const MAX_TRANSCRIPT_HISTORY_VERSION = 2_147_483_647;

const historyMessages = {
  HISTORY_INPUT_INVALID: "The local history request is invalid.",
  HISTORY_NATIVE_ONLY: "Local transcript history is available only on mobile.",
  HISTORY_AUTH_REQUIRED: "Sign in to the same account to read this history.",
  HISTORY_CONTEXT_INACTIVE: "This history reader is no longer active.",
  HISTORY_REQUEST_SUPERSEDED: "A newer history request replaced this request.",
  HISTORY_DELETION_PENDING: "History reading is paused during account deletion.",
  HISTORY_SESSION_UNAVAILABLE: "This session is no longer available locally.",
  HISTORY_LOCAL_STORAGE_UNAVAILABLE: "Local history storage is not available.",
  HISTORY_LOCAL_READ_FAILED: "The local transcript history could not be read.",
  HISTORY_CACHE_INVALID: "The local transcript history is invalid.",
} as const;
export type TranscriptHistoryErrorCode = keyof typeof historyMessages;

/** Never retain SQL, transcript text, credentials or a raw exception as cause. */
export class TranscriptHistoryError extends Error {
  readonly code: TranscriptHistoryErrorCode;
  constructor(code: TranscriptHistoryErrorCode) {
    super(historyMessages[code]);
    this.name = "TranscriptHistoryError";
    this.code = code;
  }
}

export const normalizeTranscriptHistoryError = (error: unknown): TranscriptHistoryError =>
  error instanceof TranscriptHistoryError ? error : new TranscriptHistoryError("HISTORY_LOCAL_READ_FAILED");

export interface TranscriptHistoryScope {
  userId: string;
  workspaceId: string;
  sessionId: string;
}
export interface TranscriptHistoryReadContext {
  scope: Readonly<TranscriptHistoryScope>;
  /** Synchronous identity/lifetime guard, also checked inside the read transaction. */
  assertActive: () => void;
}
export interface TranscriptHistoryCursor {
  scope: Readonly<TranscriptHistoryScope>;
  upperVersion: number;
  beforeVersion: number;
}
export interface TranscriptHistoryPageRequest {
  pageSize?: number;
  cursor?: Readonly<TranscriptHistoryCursor> | null;
}
export interface TranscriptHistoryVersionRequest {
  versionId: string;
  /** Optional number observed in the list; an identity mismatch fails closed. */
  expectedVersion?: number;
}

/** Intentionally excludes Full Text; list reads must not load every transcript. */
export interface TranscriptHistoryVersionSummary {
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
  /** A local observation at the time of THIS read, not a cloud freshness claim. */
  is_current: boolean;
}
export interface LocalTranscriptHistoryPage {
  scope: Readonly<TranscriptHistoryScope>;
  availability: "local_cache_only";
  versions: TranscriptHistoryVersionSummary[];
  windowUpperVersion: number | null;
  /** null means exhausted locally, NOT complete cloud history. */
  nextCursor: TranscriptHistoryCursor | null;
}
export type LocalTranscriptHistoryVersion =
  | { kind: "not_cached"; availability: "local_cache_only";
      scope: Readonly<TranscriptHistoryScope>; versionId: string }
  | { kind: "ready"; availability: "local_cache_only";
      scope: Readonly<TranscriptHistoryScope>; version: TranscriptHistoryVersionSummary;
      rawPlainText: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const transcriptHistoryUuid = (value: unknown): string => {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new TranscriptHistoryError("HISTORY_INPUT_INVALID");
  }
  return value.toLowerCase();
};
export const normalizeTranscriptHistoryScope = (scope: Readonly<TranscriptHistoryScope>): TranscriptHistoryScope => {
  if (!scope || typeof scope !== "object") throw new TranscriptHistoryError("HISTORY_INPUT_INVALID");
  return { userId: transcriptHistoryUuid(scope.userId), workspaceId: transcriptHistoryUuid(scope.workspaceId),
    sessionId: transcriptHistoryUuid(scope.sessionId) };
};
export const isTranscriptHistoryVersionNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TRANSCRIPT_HISTORY_VERSION;

export const normalizeTranscriptHistoryPageRequest = (
  scope: Readonly<TranscriptHistoryScope>, input: TranscriptHistoryPageRequest = {},
): { pageSize: number; cursor: TranscriptHistoryCursor | null } => {
  if (!input || typeof input !== "object") throw new TranscriptHistoryError("HISTORY_INPUT_INVALID");
  const pageSize = input.pageSize === undefined ? DEFAULT_TRANSCRIPT_HISTORY_PAGE_SIZE : input.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_TRANSCRIPT_HISTORY_PAGE_SIZE) {
    throw new TranscriptHistoryError("HISTORY_INPUT_INVALID");
  }
  if (input.cursor === undefined || input.cursor === null) return { pageSize, cursor: null };
  const cursor = input.cursor;
  const cursorScope = normalizeTranscriptHistoryScope(cursor.scope);
  if (cursorScope.userId !== scope.userId || cursorScope.workspaceId !== scope.workspaceId ||
      cursorScope.sessionId !== scope.sessionId || !isTranscriptHistoryVersionNumber(cursor.upperVersion) ||
      !isTranscriptHistoryVersionNumber(cursor.beforeVersion) || cursor.beforeVersion > cursor.upperVersion) {
    throw new TranscriptHistoryError("HISTORY_INPUT_INVALID");
  }
  return { pageSize, cursor: { scope: cursorScope, upperVersion: cursor.upperVersion, beforeVersion: cursor.beforeVersion } };
};
export const normalizeTranscriptHistoryVersionRequest = (input: TranscriptHistoryVersionRequest): TranscriptHistoryVersionRequest => {
  if (!input || typeof input !== "object" ||
      (input.expectedVersion !== undefined && !isTranscriptHistoryVersionNumber(input.expectedVersion))) {
    throw new TranscriptHistoryError("HISTORY_INPUT_INVALID");
  }
  return { versionId: transcriptHistoryUuid(input.versionId),
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }) };
};

/** Validate selected columns, never repair cache identities or fabricate provenance. */
export const parseLocalTranscriptHistorySummary = (
  input: unknown, scope: Readonly<TranscriptHistoryScope>,
): TranscriptHistoryVersionSummary => {
  const invalid = () => new TranscriptHistoryError("HISTORY_CACHE_INVALID");
  if (!input || typeof input !== "object") throw invalid();
  const row = input as Record<string, unknown>;
  const canonicalUuid = (value: unknown): value is string =>
    typeof value === "string" && uuidPattern.test(value) && value === value.toLowerCase();
  const nullableUuid = (value: unknown): value is string | null => value === null || canonicalUuid(value);
  const origin = row.version_origin;
  if (!canonicalUuid(row.id) || row.workspace_id !== scope.workspaceId || row.session_id !== scope.sessionId ||
      !isTranscriptHistoryVersionNumber(row.version) || row.version_status !== "final" ||
      (origin !== "provider" && origin !== "user_edit" && origin !== "import") ||
      !nullableUuid(row.parent_version_id) || row.parent_version_id === row.id ||
      !nullableUuid(row.created_by) || !nullableUuid(row.transcription_run_id) ||
      (row.content_checksum_sha256 !== null && (typeof row.content_checksum_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(row.content_checksum_sha256))) ||
      typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
      (row.is_current !== 0 && row.is_current !== 1) ||
      (origin === "user_edit" && (row.parent_version_id === null || row.content_checksum_sha256 === null))) {
    throw invalid();
  }
  return {
    id: row.id, workspace_id: scope.workspaceId, session_id: scope.sessionId, version: row.version,
    version_origin: origin, version_status: "final", parent_version_id: row.parent_version_id,
    created_by: row.created_by, transcription_run_id: row.transcription_run_id,
    content_checksum_sha256: row.content_checksum_sha256 as string | null,
    created_at: row.created_at, is_current: row.is_current === 1,
  };
};
