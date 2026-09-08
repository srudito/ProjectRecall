import type {
  TranscriptEditorControllerSnapshot,
  TranscriptEditorErrorCode,
  TranscriptEditorSyncState,
} from "./editor-types";

const syncKeys: Record<TranscriptEditorSyncState, string> = {
  none: "editor.sync.none",
  queued: "editor.sync.queued",
  submitting: "editor.sync.submitting",
  retry_wait: "editor.sync.retry_wait",
  auth_required: "editor.sync.auth_required",
  feature_disabled: "editor.sync.feature_disabled",
  conflict: "editor.sync.conflict",
  outcome_unconfirmed: "editor.sync.outcome_unconfirmed",
  cancelled: "editor.sync.cancelled",
  accepted_refresh_pending: "editor.sync.accepted_refresh_pending",
  accepted_current: "editor.sync.accepted_current",
  accepted_other_current: "editor.sync.accepted_other_current",
};
const errorKeys: Record<TranscriptEditorErrorCode, string> = {
  EDITOR_AUTOSAVE_UNAVAILABLE: "editor.errors.autosave",
  EDITOR_SCOPE_IN_USE: "editor.errors.inUse",
  EDITOR_NOT_READY: "editor.errors.notReady",
  EDITOR_BUSY: "editor.errors.busy",
  EDITOR_RECOVERY_REJECTED: "editor.errors.recovery",
  EDITOR_NATIVE_ONLY: "editor.errors.nativeOnly",
  EDITOR_CONTEXT_INACTIVE: "editor.errors.inactive",
  EDITOR_AUTH_REQUIRED: "editor.errors.auth",
  EDITOR_DELETION_PENDING: "editor.errors.deletion",
  EDITOR_INPUT_INVALID: "editor.errors.invalid",
  EDITOR_TEXT_TOO_LARGE: "editor.errors.tooLarge",
  EDITOR_TEXT_BLANK: "editor.errors.blank",
  EDITOR_UNCHANGED: "editor.errors.unchanged",
  EDITOR_LOCAL_STORAGE_UNAVAILABLE: "editor.errors.storage",
  EDITOR_LOCAL_STORAGE_FAILED: "editor.errors.storage",
  EDITOR_SESSION_UNAVAILABLE: "editor.errors.session",
  EDITOR_CACHE_INVALID: "editor.errors.cache",
  EDITOR_CURRENT_UNAVAILABLE: "editor.errors.current",
  EDITOR_BASE_UNAVAILABLE: "editor.errors.base",
  EDITOR_BASE_CHANGED: "editor.errors.baseChanged",
  EDITOR_DRAFT_CHANGED: "editor.errors.draftChanged",
  EDITOR_BASE_PINNED: "editor.errors.baseChanged",
  EDITOR_OPERATION_PENDING: "editor.errors.pending",
  EDITOR_OUTCOME_UNCONFIRMED: "editor.errors.unconfirmed",
  EDITOR_REFRESH_REQUIRED: "editor.errors.refresh",
  EDITOR_IDEMPOTENCY_CONFLICT: "editor.errors.identity",
};
export const transcriptEditorErrorKey = (code: unknown): string =>
  typeof code === "string" && Object.prototype.hasOwnProperty.call(errorKeys, code)
    ? errorKeys[code as TranscriptEditorErrorCode] : "editor.errors.unknown";

/** Presentation only. No queue mutation, UUID generation, or retry scheduler. */
export const presentTranscriptEditor = (
  snapshot: TranscriptEditorControllerSnapshot | null,
  pendingAction: string | null,
  loading: boolean,
) => {
  const ready = snapshot?.phase === "ready" && !loading;
  const busy = pendingAction !== null || snapshot?.busy === true;
  const sync = snapshot?.syncState ?? "none";
  const unresolved = ["queued", "submitting", "retry_wait", "auth_required", "feature_disabled", "outcome_unconfirmed"].includes(sync);
  const exclusive = pendingAction === "discard" || pendingAction === "close";
  return {
    ready,
    canEdit: ready && !exclusive,
    canSave: ready && !busy && snapshot?.canSave === true,
    canRetryFrozen: ready && !busy && snapshot?.hasFrozenSave === true,
    canFlush: ready && !busy && !snapshot?.draftConflict &&
      (snapshot?.localState === "storage_error" || snapshot?.localState === "dirty"),
    canDiscard: ready && !busy && !unresolved && !snapshot?.hasFrozenSave && !snapshot?.draftConflict,
    canClose: pendingAction === null && !snapshot?.busy,
    canReload: !loading && !busy,
    localKey: `editor.local.${snapshot?.localState ?? "clean"}`,
    syncKey: syncKeys[sync],
    conflictKey: snapshot?.draftConflict ? "editor.localConflict"
      : sync === "conflict" ? "editor.serverConflict"
        : snapshot?.staleBase ? "editor.staleBase" : null,
    frozenKey: snapshot?.hasFrozenSave
      ? snapshot.frozenSaveMatchesText ? "editor.frozenSame" : "editor.frozenDifferent" : null,
  };
};
