import type {
  TranscriptEditDraftRow,
  TranscriptEditQueueRow,
} from "@/src/services/sqlite/repository";
import type { SyncedTranscriptVersionRecord } from "./result-types";

export const MAX_TRANSCRIPT_EDITOR_BYTES = 8 * 1024 * 1024;

const messages = {
  EDITOR_AUTOSAVE_UNAVAILABLE: "Automatic draft saving could not be scheduled. Save the draft again.",
  EDITOR_SCOPE_IN_USE: "This transcript already has an active editor.",
  EDITOR_NOT_READY: "Load the local transcript before editing.",
  EDITOR_BUSY: "Wait for the current editor operation to finish.",
  EDITOR_RECOVERY_REJECTED: "The draft continuation could not be verified.",
  EDITOR_NATIVE_ONLY: "Transcript draft editing is available only on mobile.",
  EDITOR_CONTEXT_INACTIVE: "This transcript editor is no longer active.",
  EDITOR_AUTH_REQUIRED: "Sign in to the same account before editing this transcript.",
  EDITOR_DELETION_PENDING: "Editing is paused while account deletion is pending.",
  EDITOR_INPUT_INVALID: "The transcript edit is not valid.",
  EDITOR_TEXT_TOO_LARGE: "The transcript exceeds the supported text size.",
  EDITOR_TEXT_BLANK: "Transcript edit text must not be blank.",
  EDITOR_UNCHANGED: "The transcript has not changed from its base version.",
  EDITOR_LOCAL_STORAGE_UNAVAILABLE: "Local transcript storage is not available.",
  EDITOR_LOCAL_STORAGE_FAILED: "The local transcript operation could not be completed.",
  EDITOR_SESSION_UNAVAILABLE: "This session is no longer available for editing.",
  EDITOR_CACHE_INVALID: "The local transcript editing state is invalid.",
  EDITOR_CURRENT_UNAVAILABLE: "The current transcript is not available on this device.",
  EDITOR_BASE_UNAVAILABLE: "The draft base is not available on this device.",
  EDITOR_BASE_CHANGED: "The current transcript differs from this draft's base.",
  EDITOR_DRAFT_CHANGED: "The draft changed before this operation could complete.",
  EDITOR_BASE_PINNED: "An existing draft must keep its original base version.",
  EDITOR_OPERATION_PENDING: "A saved edit for this session is still pending.",
  EDITOR_OUTCOME_UNCONFIRMED: "A previous saved edit must be resolved before saving another.",
  EDITOR_REFRESH_REQUIRED: "Refresh the current transcript before starting another saved edit.",
  EDITOR_IDEMPOTENCY_CONFLICT: "This saved edit identifier was used for a different snapshot.",
} as const;

export type TranscriptEditorErrorCode = keyof typeof messages;

/** Never expose SQL, raw transport errors, or transcript content to callers. */
export class TranscriptEditorError extends Error {
  readonly code: TranscriptEditorErrorCode;
  constructor(code: TranscriptEditorErrorCode) {
    super(messages[code]);
    this.name = "TranscriptEditorError";
    this.code = code;
  }
}

export interface TranscriptEditorScope {
  userId: string;
  workspaceId: string;
  sessionId: string;
}

export interface TranscriptEditorContext {
  scope: Readonly<TranscriptEditorScope>;
  /** Synchronous identity/deletion/generation guard; called inside the transaction. */
  assertActive: () => void;
}

export interface TranscriptEditorDraftCommand {
  baseVersionId: string;
  plainText: string;
  /** null means the caller observed no draft, NOT permission to overwrite one. */
  expectedDraft: Readonly<TranscriptEditDraftRow> | null;
}

export interface TranscriptEditorSaveCommand extends TranscriptEditorDraftCommand {
  clientVersionId: string;
  /** Retrying a frozen action must not replace an already-durable newer draft. */
  preserveNewerDraft?: boolean;
}

export interface TranscriptEditorLocalState {
  currentVersion: SyncedTranscriptVersionRecord | null;
  draft: TranscriptEditDraftRow | null;
  /** Missing historical base does not erase a recoverable draft. */
  baseVersion: SyncedTranscriptVersionRecord | null;
  queue: TranscriptEditQueueRow[];
}

export interface TranscriptEditorSaveResult {
  kind: "queued" | "existing";
  operation: TranscriptEditQueueRow;
  draft: TranscriptEditDraftRow | null;
}

export const transcriptEditorUuid = (value: string): string => {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
  }
  return value.toLowerCase();
};

export const normalizeTranscriptEditorScope = (
  scope: Readonly<TranscriptEditorScope>,
): TranscriptEditorScope => {
  if (!scope || typeof scope !== "object") throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
  return {
    userId: transcriptEditorUuid(scope.userId),
    workspaceId: transcriptEditorUuid(scope.workspaceId),
    sessionId: transcriptEditorUuid(scope.sessionId),
  };
};

/** UTF-8 byte count without Node Buffer or a new native dependency. No rewriting. */
export const validateTranscriptEditorText = (
  text: string,
  allowBlank: boolean,
): void => {
  if (typeof text !== "string") throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // PostgreSQL text cannot represent NUL. Reject unpaired UTF-16 surrogates
    // rather than silently replacing characters during JSON/UTF-8 encoding.
    if (code === 0) throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
      }
      index += 1;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
    } else {
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (bytes > MAX_TRANSCRIPT_EDITOR_BYTES) {
      throw new TranscriptEditorError("EDITOR_TEXT_TOO_LARGE");
    }
  }
  if (!allowBlank && text.trim().length === 0) {
    throw new TranscriptEditorError("EDITOR_TEXT_BLANK");
  }
};

/** Immutable fields only: current marker and updated_at may change on demotion. */
export type TranscriptEditorBaseObservation = Pick<SyncedTranscriptVersionRecord,
  "id" | "workspace_id" | "session_id" | "version" | "version_origin" |
  "version_status" | "parent_version_id" | "plain_text" |
  "content_checksum_sha256" | "created_by" | "created_at" | "transcription_run_id">;

export const observeTranscriptEditorBase = (
  version: TranscriptEditorBaseObservation,
): TranscriptEditorBaseObservation => ({
  id: version.id, workspace_id: version.workspace_id, session_id: version.session_id,
  version: version.version, version_origin: version.version_origin,
  version_status: version.version_status, parent_version_id: version.parent_version_id,
  plain_text: version.plain_text, content_checksum_sha256: version.content_checksum_sha256,
  created_by: version.created_by, created_at: version.created_at,
  transcription_run_id: version.transcription_run_id,
});

/** A live controller's observation, never reconstructed from history on startup. */
export type TranscriptEditorContinuityProof =
  | { kind: "observed_base"; base: TranscriptEditorBaseObservation }
  | { kind: "completed_save"; base: TranscriptEditorBaseObservation;
      operationId: string; savedPlainText: string };

export interface TranscriptEditorContinuityCommand {
  plainText: string;
  proof: TranscriptEditorContinuityProof;
}

export interface TranscriptEditorParticipant {
  readonly scope: Readonly<TranscriptEditorScope>;
  invalidate: () => void;
  waitForIdle: () => Promise<void>;
  setForeground: (foreground: boolean) => void;
  refresh: () => Promise<void>;
}

export interface TranscriptEditorRegistration {
  isActive: () => boolean;
  release: () => void;
  foreground: boolean;
}

export type TranscriptEditorSyncState =
  | "none" | "queued" | "submitting" | "retry_wait" | "auth_required"
  | "feature_disabled" | "conflict" | "outcome_unconfirmed" | "cancelled"
  | "accepted_refresh_pending" | "accepted_current" | "accepted_other_current";

/** Detached, UI-ready snapshot. Transport and raw database errors stay private. */
export interface TranscriptEditorControllerSnapshot {
  scope: Readonly<TranscriptEditorScope>;
  phase: "uninitialized" | "ready" | "unavailable" | "closed" | "invalidated";
  text: string;
  currentText: string | null;
  baseVersionId: string | null;
  currentVersionId: string | null;
  revision: number;
  durableRevision: number;
  localState: "clean" | "dirty" | "saving" | "saved" | "storage_error";
  syncState: TranscriptEditorSyncState;
  operationId: string | null;
  staleBase: boolean;
  draftConflict: boolean;
  canSave: boolean;
  busy: boolean;
  /** A local enqueue retry uses this frozen snapshot, not the newer textbox. */
  hasFrozenSave: boolean;
  frozenSaveMatchesText: boolean;
  errorCode: TranscriptEditorErrorCode | null;
}
