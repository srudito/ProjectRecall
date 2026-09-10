import type { TranscriptEditDraftRow } from "@/src/services/sqlite/repository";

import {
  normalizeTranscriptEditorScope,
  transcriptEditorUuid,
  validateTranscriptEditorText,
  TranscriptEditorError,
  type TranscriptEditorScope,
} from "./editor-types";
import { MAX_TRANSCRIPT_HISTORY_VERSION } from "./history-types";

const messages = {
  HISTORY_RESTORE_INPUT_INVALID: "The transcript restore request is invalid.",
  HISTORY_RESTORE_NATIVE_ONLY: "Transcript restore is available only on mobile.",
  HISTORY_RESTORE_AUTH_REQUIRED: "Sign in to the same account before restoring transcript history.",
  HISTORY_RESTORE_CONTEXT_INACTIVE: "This transcript restore request is no longer active.",
  HISTORY_RESTORE_DELETION_PENDING: "Transcript restore is paused during account deletion.",
  HISTORY_RESTORE_STORAGE_UNAVAILABLE: "Local transcript storage is unavailable.",
  HISTORY_RESTORE_SESSION_UNAVAILABLE: "This session is no longer available for transcript restore.",
  HISTORY_RESTORE_CACHE_INVALID: "The local transcript cache is invalid.",
  HISTORY_RESTORE_SOURCE_INVALID: "The selected historical transcript cannot be restored.",
  HISTORY_RESTORE_SOURCE_UNAVAILABLE: "The selected historical transcript is not available on this device.",
  HISTORY_RESTORE_SOURCE_CHANGED: "The selected historical transcript changed before the draft was prepared.",
  HISTORY_RESTORE_CHECKSUM_MISMATCH: "The selected historical transcript failed checksum verification.",
  HISTORY_RESTORE_HASH_UNAVAILABLE: "Transcript checksum verification is unavailable.",
  HISTORY_RESTORE_CURRENT_UNAVAILABLE: "The current transcript is not available on this device.",
  HISTORY_RESTORE_DRAFT_EXISTS: "An existing transcript draft must be reviewed before restoring history.",
  HISTORY_RESTORE_OPERATION_PENDING: "A saved transcript edit is still pending.",
  HISTORY_RESTORE_OUTCOME_UNCONFIRMED: "A previous saved transcript edit has an unconfirmed outcome.",
  HISTORY_RESTORE_REFRESH_REQUIRED: "Refresh the current transcript before restoring history.",
  HISTORY_RESTORE_UNCHANGED: "The selected historical text already matches the current transcript.",
  HISTORY_RESTORE_WRITE_FAILED: "The transcript restore draft could not be prepared.",
} as const;

export type TranscriptHistoryRestoreErrorCode = keyof typeof messages;

/** Static messages only. Never retain SQL, transcript text, or raw causes. */
export class TranscriptHistoryRestoreError extends Error {
  readonly code: TranscriptHistoryRestoreErrorCode;
  constructor(code: TranscriptHistoryRestoreErrorCode) {
    super(messages[code]);
    this.name = "TranscriptHistoryRestoreError";
    this.code = code;
  }
}

export interface TranscriptHistoryRestoreDraftCommand {
  /** Copy source only. It is not promoted and is not the future version parent. */
  sourceVersionId: string;
  sourceVersionNumber: number;
  sourcePlainText: string;
  sourceContentChecksumSha256: string | null;
}

export interface TranscriptHistoryRestoreDraftResult {
  kind: "draft_created";
  /** The copied historical row; the new draft remains based on baseVersionId. */
  sourceVersionId: string;
  baseVersionId: string;
  draft: TranscriptEditDraftRow;
}

export interface TranscriptHistoryRestoreRequest
  extends TranscriptHistoryRestoreDraftCommand {
  scope: Readonly<TranscriptEditorScope>;
  /** Synchronous modal/request-lifetime guard. */
  assertActive: () => void;
}

export const normalizeTranscriptHistoryRestoreFailure = (
  failure: unknown,
): TranscriptHistoryRestoreError => {
  if (failure instanceof TranscriptHistoryRestoreError) return failure;
  if (failure instanceof TranscriptEditorError) {
    switch (failure.code) {
      case "EDITOR_NATIVE_ONLY":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_NATIVE_ONLY");
      case "EDITOR_AUTH_REQUIRED":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_AUTH_REQUIRED");
      case "EDITOR_CONTEXT_INACTIVE":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_CONTEXT_INACTIVE");
      case "EDITOR_DELETION_PENDING":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_DELETION_PENDING");
      case "EDITOR_LOCAL_STORAGE_UNAVAILABLE":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_STORAGE_UNAVAILABLE");
      case "EDITOR_SESSION_UNAVAILABLE":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_SESSION_UNAVAILABLE");
      case "EDITOR_CACHE_INVALID":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_CACHE_INVALID");
      case "EDITOR_CURRENT_UNAVAILABLE":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_CURRENT_UNAVAILABLE");
      case "EDITOR_OPERATION_PENDING":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_OPERATION_PENDING");
      case "EDITOR_OUTCOME_UNCONFIRMED":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_OUTCOME_UNCONFIRMED");
      case "EDITOR_REFRESH_REQUIRED":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_REFRESH_REQUIRED");
      case "EDITOR_UNCHANGED":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_UNCHANGED");
      case "EDITOR_INPUT_INVALID":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_INPUT_INVALID");
      case "EDITOR_TEXT_TOO_LARGE":
      case "EDITOR_TEXT_BLANK":
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_SOURCE_INVALID");
      default:
        return new TranscriptHistoryRestoreError("HISTORY_RESTORE_WRITE_FAILED");
    }
  }
  return new TranscriptHistoryRestoreError("HISTORY_RESTORE_WRITE_FAILED");
};

export const captureTranscriptHistoryRestoreDraftCommand = (
  input: TranscriptHistoryRestoreDraftCommand,
): TranscriptHistoryRestoreDraftCommand => {
  if (!input || typeof input !== "object") {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_INPUT_INVALID");
  }
  let sourceVersionId: string;
  try {
    sourceVersionId = transcriptEditorUuid(input.sourceVersionId);
  } catch {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_INPUT_INVALID");
  }
  if (
    !Number.isSafeInteger(input.sourceVersionNumber) ||
    input.sourceVersionNumber < 1 ||
    input.sourceVersionNumber > MAX_TRANSCRIPT_HISTORY_VERSION
  ) {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_INPUT_INVALID");
  }
  const checksum = input.sourceContentChecksumSha256;
  if (
    checksum !== null &&
    (typeof checksum !== "string" || !/^[0-9a-f]{64}$/i.test(checksum))
  ) {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_INPUT_INVALID");
  }
  try {
    validateTranscriptEditorText(input.sourcePlainText, false);
  } catch {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_SOURCE_INVALID");
  }
  return {
    sourceVersionId,
    sourceVersionNumber: input.sourceVersionNumber,
    sourcePlainText: input.sourcePlainText,
    sourceContentChecksumSha256: checksum === null ? null : checksum.toLowerCase(),
  };
};

export const captureTranscriptHistoryRestoreRequest = (
  input: TranscriptHistoryRestoreRequest,
): {
  scope: Readonly<TranscriptEditorScope>;
  command: Readonly<TranscriptHistoryRestoreDraftCommand>;
  assertCaller: () => void;
} => {
  if (!input || typeof input !== "object" || typeof input.assertActive !== "function") {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_INPUT_INVALID");
  }
  let scope: TranscriptEditorScope;
  try {
    scope = normalizeTranscriptEditorScope(input.scope);
  } catch {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_INPUT_INVALID");
  }
  return {
    scope: Object.freeze(scope),
    command: Object.freeze(captureTranscriptHistoryRestoreDraftCommand(input)),
    assertCaller: input.assertActive,
  };
};
