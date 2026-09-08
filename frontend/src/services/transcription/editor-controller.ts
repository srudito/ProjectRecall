import * as Crypto from "expo-crypto";

import type { TranscriptEditDraftRow, TranscriptEditQueueRow } from "@/src/services/sqlite/repository";
import { requestTranscriptCurrentVersionSync } from "@/src/services/sync/transcript-current-version-worker";

import { registerTranscriptEditor } from "./editor-lifecycle";
import { createTranscriptEditorService } from "./editor-service";
import {
  normalizeTranscriptEditorScope,
  observeTranscriptEditorBase,
  TranscriptEditorError,
  validateTranscriptEditorText,
  type TranscriptEditorBaseObservation,
  type TranscriptEditorContinuityProof,
  type TranscriptEditorControllerSnapshot,
  type TranscriptEditorErrorCode,
  type TranscriptEditorLocalState,
  type TranscriptEditorRegistration,
  type TranscriptEditorSaveResult,
  type TranscriptEditorScope,
  type TranscriptEditorSyncState,
} from "./editor-types";

export interface TranscriptEditorControllerDependencies {
  createService: (scope: Readonly<TranscriptEditorScope>, isActive: () => boolean) => ReturnType<typeof createTranscriptEditorService>;
  register: typeof registerTranscriptEditor;
  createId: () => string;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
  requestCurrent: (scope: Readonly<TranscriptEditorScope>) => void;
  debounceMs: number;
  maxWaitMs: number;
}

const defaults: TranscriptEditorControllerDependencies = {
  createService: (scope, isActive) => createTranscriptEditorService(scope, { isContextActive: isActive }),
  register: registerTranscriptEditor,
  createId: () => Crypto.randomUUID(),
  now: () => Date.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle),
  requestCurrent: (scope) => requestTranscriptCurrentVersionSync({ workspace_id: scope.workspaceId, session_id: scope.sessionId }),
  debounceMs: 300,
  maxWaitMs: 2_000,
};
const draftEqual = (a: TranscriptEditDraftRow | null, b: TranscriptEditDraftRow | null): boolean =>
  a === null || b === null ? a === b : a.user_id === b.user_id && a.workspace_id === b.workspace_id &&
  a.session_id === b.session_id && a.base_version_id === b.base_version_id && a.plain_text === b.plain_text &&
  a.created_at === b.created_at && a.updated_at === b.updated_at;
const matchesDraft = (row: TranscriptEditQueueRow, draft: TranscriptEditDraftRow): boolean =>
  row.user_id === draft.user_id && row.workspace_id === draft.workspace_id && row.session_id === draft.session_id &&
  row.expected_current_version_id === draft.base_version_id && row.plain_text === draft.plain_text;
const safeError = (error: unknown): TranscriptEditorError => error instanceof TranscriptEditorError
  ? error : new TranscriptEditorError("EDITOR_LOCAL_STORAGE_FAILED");
const terminalContextErrors = new Set<TranscriptEditorErrorCode>([
  "EDITOR_AUTH_REQUIRED", "EDITOR_CONTEXT_INACTIVE", "EDITOR_DELETION_PENDING", "EDITOR_SESSION_UNAVAILABLE",
]);

/** Headless, one-writer controller. No RPC, remote read, rebase or timestamp write. */
export const createTranscriptEditorController = (
  scopeInput: Readonly<TranscriptEditorScope>,
  overrides: Partial<TranscriptEditorControllerDependencies> = {},
) => {
  const scope = Object.freeze(normalizeTranscriptEditorScope(scopeInput));
  const deps = { ...defaults, ...overrides };
  if (!Number.isFinite(deps.debounceMs) || deps.debounceMs <= 0 ||
      !Number.isFinite(deps.maxWaitMs) || deps.maxWaitMs < deps.debounceMs) {
    throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
  }
  let initializedOnce = false;
  let phase: TranscriptEditorControllerSnapshot["phase"] = "uninitialized";
  let alive = true;
  let foreground = true;
  let registration: TranscriptEditorRegistration | null = null;
  let text = "";
  let revision = 0;
  let durableRevision = 0;
  let base: TranscriptEditorBaseObservation | null = null;
  let baseId: string | null = null;
  let draft: TranscriptEditDraftRow | null = null;
  let local: TranscriptEditorLocalState = { currentVersion: null, baseVersion: null, draft: null, queue: [] };
  let proof: TranscriptEditorContinuityProof | null = null;
  const observedOperations = new Map<string, TranscriptEditQueueRow>();
  let lastOperationId: string | null = null;
  let draftConflict = false;
  let errorCode: TranscriptEditorErrorCode | null = null;
  let writing = false;
  let exclusive = false;
  let autoBlocked = false;
  let firstDirtyAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerSerial = 0;
  let autoPending = false;
  let tail: Promise<void> = Promise.resolve();
  let opening: Promise<void> | null = null;
  let refreshing: Promise<void> | null = null;
  let refreshAgain = false;
  type Capture = { text: string; revision: number; baseId: string };
  type SaveIntent = Capture & { id: string };
  let intent: SaveIntent | null = null;
  let saving: Promise<TranscriptEditorSaveResult> | null = null;
  const listeners = new Set<() => void>();

  const isActive = (): boolean => alive && registration?.isActive() === true;
  const assertActive = (): void => {
    if (!isActive()) throw new TranscriptEditorError("EDITOR_CONTEXT_INACTIVE");
  };
  const requireReady = (): void => {
    assertActive();
    if (phase !== "ready" || !baseId) throw new TranscriptEditorError("EDITOR_NOT_READY");
  };
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* A UI observer cannot undo persistence. */ }
    }
  };
  const clearTimer = (): void => {
    timerSerial += 1;
    if (timer !== null) deps.clear(timer);
    timer = null;
  };
  const scrub = (): void => {
    text = ""; draft = null; base = null; baseId = null; proof = null; intent = null;
    local = { currentVersion: null, baseVersion: null, draft: null, queue: [] };
    observedOperations.clear(); lastOperationId = null;
  };
  const invalidate = (): void => {
    if (!alive) return;
    alive = false;
    clearTimer();
    phase = "invalidated";
    scrub();
    registration?.release();
    emit();
    listeners.clear();
  };
  const recordError = (error: unknown): TranscriptEditorError => {
    const normalized = safeError(error);
    if (alive) {
      errorCode = normalized.code;
      if (terminalContextErrors.has(normalized.code)) invalidate();
      else emit();
    }
    return normalized;
  };
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const pending = tail.then(async () => {
      try { assertActive(); return await task(); } catch (error) { throw recordError(error); }
    });
    // Every admitted job stays reachable for drain, including rejected jobs.
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const waitForIdle = async (): Promise<void> => {
    let observed: Promise<void>;
    do { observed = tail; await observed; } while (observed !== tail);
  };
  const rememberOperations = (value: TranscriptEditorLocalState): void => {
    if (!value.draft) return;
    for (const row of value.queue) {
      if (matchesDraft(row, value.draft) && (row.queue_status === "pending" ||
          row.queue_status === "submitting" || row.queue_status === "failed")) {
        observedOperations.set(row.id, { ...row });
      }
    }
  };
  const initialize = (value: TranscriptEditorLocalState): void => {
    local = value;
    draft = value.draft ? { ...value.draft } : null;
    const version = draft ? value.baseVersion : value.currentVersion;
    base = version ? observeTranscriptEditorBase(version) : null;
    baseId = draft?.base_version_id ?? version?.id ?? null;
    text = draft !== null ? draft.plain_text : value.currentVersion?.plain_text ?? "";
    revision = initializedOnce ? revision + 1 : 0;
    durableRevision = revision;
    initializedOnce = true;
    phase = baseId ? "ready" : "unavailable";
    // Only a new live edit that really observed a current version gets this
    // capability. It is revoked on first draft creation, discard or invalidation.
    proof = !draft && value.currentVersion && base &&
      !value.queue.some((row) => row.expected_current_version_id === baseId)
      ? { kind: "observed_base", base } : null;
    draftConflict = false;
    autoBlocked = false;
    errorCode = null;
    firstDirtyAt = null;
    rememberOperations(value);
  };
  const reconcile = (value: TranscriptEditorLocalState): void => {
    const previous = draft;
    local = value;
    if (!base && value.baseVersion?.id === baseId) base = observeTranscriptEditorBase(value.baseVersion);
    if (!draftEqual(previous, value.draft)) {
      const completed = previous && value.draft === null
        ? value.queue.find((row) => row.queue_status === "succeeded" && matchesDraft(row, previous) &&
          observedOperations.has(row.id) && matchesDraft(observedOperations.get(row.id)!, previous)) : undefined;
      if (completed && base) {
        draft = null;
        lastOperationId = completed.id;
        proof = { kind: "completed_save", base, operationId: completed.id, savedPlainText: completed.plain_text };
        autoBlocked = false;
        errorCode = null;
      } else {
        // External/unknown replacement or discard is not permission to overwrite.
        draftConflict = true;
        proof = null;
        autoBlocked = true;
        errorCode = "EDITOR_DRAFT_CHANGED";
      }
    }
    rememberOperations(value);
  };

  const capture = (): Capture => {
    requireReady();
    return { text, revision, baseId: baseId! };
  };
  const writeCapture = async (captured: Capture): Promise<void> => {
    if (captured.revision <= durableRevision) return;
    if (draftConflict) throw new TranscriptEditorError("EDITOR_DRAFT_CHANGED");
    if (draft === null && proof && captured.text === (proof.kind === "completed_save" ? proof.savedPlainText : proof.base.plain_text)) {
      // Undo back to already-durable content requires no recreated draft.
      durableRevision = captured.revision;
      if (revision === captured.revision) firstDirtyAt = null;
      return;
    }
    writing = true; emit();
    try {
      let saved: TranscriptEditDraftRow;
      try {
        saved = await service.saveDraft({ baseVersionId: captured.baseId,
          plainText: captured.text, expectedDraft: draft });
      } catch (error) {
        if (!(error instanceof TranscriptEditorError) ||
            !["EDITOR_DRAFT_CHANGED", "EDITOR_BASE_CHANGED", "EDITOR_REFRESH_REQUIRED", "EDITOR_CURRENT_UNAVAILABLE"].includes(error.code)) throw error;
        const fresh = await service.load();
        assertActive();
        reconcile(fresh);
        if (draftConflict || fresh.draft !== null || !proof || proof.base.id !== captured.baseId) throw error;
        saved = await service.preserveDraft({ plainText: captured.text, proof });
      }
      assertActive();
      draft = { ...saved };
      proof = null;
      durableRevision = captured.revision;
      errorCode = null;
      autoBlocked = false;
      if (revision === captured.revision) firstDirtyAt = null;
    } catch (error) {
      autoBlocked = true;
      throw error;
    } finally { writing = false; emit(); }
  };

  const scheduleAutosave = (): void => {
    if (!isActive() || !foreground || phase !== "ready" || autoBlocked || autoPending || exclusive ||
        draftConflict || revision <= durableRevision) return;
    firstDirtyAt ??= deps.now();
    clearTimer();
    const stamp = timerSerial;
    const delay = Math.max(0, Math.min(deps.debounceMs, deps.maxWaitMs - (deps.now() - firstDirtyAt)));
    try {
      timer = deps.schedule(() => {
      if (stamp !== timerSerial || !isActive() || !foreground) return;
      timer = null;
      autoPending = true;
      void flushDraft().then(() => undefined, () => undefined).then(() => {
        autoPending = false;
        scheduleAutosave();
      });
      }, delay);
    } catch {
      autoBlocked = true;
      errorCode = "EDITOR_AUTOSAVE_UNAVAILABLE";
      emit();
    }
  };
  const refresh = (): Promise<void> => {
    if (refreshing) { refreshAgain = true; return refreshing; }
    const pending = serial(async () => {
      do {
        refreshAgain = false;
        const value = await service.load();
        assertActive();
        if (phase === "uninitialized" || phase === "unavailable") initialize(value);
        else reconcile(value);
        emit();
      } while (refreshAgain && isActive());
    });
    refreshing = pending;
    void pending.then(() => {
      refreshing = null; scheduleAutosave();
    }, () => { refreshing = null; });
    return pending;
  };
  const open = (): Promise<void> => {
    if (opening) return opening;
    const pending = refresh();
    opening = pending;
    void pending.then(() => { opening = null; }, () => { opening = null; });
    return pending;
  };
  const setText = (value: string): void => {
    requireReady();
    if (exclusive) throw new TranscriptEditorError("EDITOR_BUSY");
    if (typeof value !== "string") throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
    if (value === text) return;
    text = value; revision += 1;
    firstDirtyAt ??= deps.now();
    if (!draftConflict) { autoBlocked = false; errorCode = null; }
    emit(); scheduleAutosave();
  };
  const flushDraft = (): Promise<void> => {
    let captured: Capture;
    try {
      if (exclusive) throw new TranscriptEditorError("EDITOR_BUSY");
      captured = capture();
    } catch (error) { return Promise.reject(recordError(error)); }
    clearTimer();
    const pending = serial(async () => { await writeCapture(captured); });
    void pending.then(() => scheduleAutosave(), () => undefined);
    return pending;
  };
  const save = (): Promise<TranscriptEditorSaveResult> => {
    if (saving) return saving;
    try {
      requireReady();
      if (exclusive) throw new TranscriptEditorError("EDITOR_BUSY");
      if (!intent) {
        const captured = capture();
        validateTranscriptEditorText(captured.text, false);
        if (base?.plain_text === captured.text) throw new TranscriptEditorError("EDITOR_UNCHANGED");
        intent = { ...captured, id: deps.createId() };
      }
    } catch (error) { return Promise.reject(recordError(error)); }
    clearTimer();
    const frozen = intent!;
    const pending = serial(async () => {
      try {
        await writeCapture(frozen);
        const result = await service.save({ baseVersionId: frozen.baseId, plainText: frozen.text,
          expectedDraft: draft, clientVersionId: frozen.id,
          ...(draft !== null && durableRevision > frozen.revision ? { preserveNewerDraft: true } : {}) });
        assertActive();
        observedOperations.set(result.operation.id, { ...result.operation });
        lastOperationId = result.operation.id;
        // May be a replay of an already-consumed draft. Reconciliation, not the
        // input UUID or "existing" label, determines what remains locally.
        const merged = { ...local, draft: result.draft,
          queue: [...local.queue.filter((row) => row.id !== result.operation.id), result.operation] };
        if (result.kind === "queued") {
          if (!draftEqual(draft, result.draft)) durableRevision = frozen.revision;
          draft = result.draft ? { ...result.draft } : null;
          local = merged;
        } else {
          reconcile(merged);
        }
        intent = null;
        if (!draftConflict) errorCode = null;
        emit();
        return result;
      } catch (error) {
        // Only uncertain local persistence failures retain the frozen action.
        // Retry never replaces its UUID with the current textbox payload.
        const normalized = safeError(error);
        if (normalized.code !== "EDITOR_LOCAL_STORAGE_FAILED" && normalized.code !== "EDITOR_LOCAL_STORAGE_UNAVAILABLE") intent = null;
        throw normalized;
      }
    });
    saving = pending;
    void pending.then(() => {
      saving = null; scheduleAutosave();
    }, () => { saving = null; });
    return pending;
  };
  const discard = (confirmedRevision: number): Promise<void> => {
    try {
      requireReady();
      if (exclusive || saving || intent) throw new TranscriptEditorError("EDITOR_BUSY");
      if (confirmedRevision !== revision) throw new TranscriptEditorError("EDITOR_DRAFT_CHANGED");
    } catch (error) { return Promise.reject(recordError(error)); }
    exclusive = true;
    clearTimer();
    const pending = serial(async () => {
      // A confirmation cannot silently adopt a different persistent draft.
      await service.discardDraft(draft);
      assertActive();
      proof = null; observedOperations.clear(); lastOperationId = null;
      text = ""; draft = null; base = null; baseId = null;
      durableRevision = revision; firstDirtyAt = null;
      phase = "unavailable";
      // Successful discard is explicit permission to start from current again.
      const fresh = await service.load();
      assertActive(); initialize(fresh); emit();
    });
    void pending.then(() => { exclusive = false; emit(); }, () => { exclusive = false; emit(); });
    return pending;
  };
  const close = (): Promise<void> => {
    try {
      requireReady();
      if (exclusive) throw new TranscriptEditorError("EDITOR_BUSY");
    } catch (error) { return Promise.reject(recordError(error)); }
    exclusive = true;
    const captured = capture();
    clearTimer();
    const pending = serial(async () => {
      await writeCapture(captured);
      assertActive();
      alive = false; phase = "closed"; scrub(); registration?.release(); emit(); listeners.clear();
    });
    void pending.then(() => { exclusive = false; }, () => { exclusive = false; emit(); });
    return pending;
  };
  const setForeground = (value: boolean): void => {
    if (!alive) return;
    foreground = value;
    clearTimer();
    if (!value && phase === "ready" && revision > durableRevision && !exclusive) {
      // Lifetime stays valid in background: unlike the network worker, this is
      // a local flush, not a promise of background execution after suspension.
      void flushDraft().catch(() => { /* Safe state remains observable on resume. */ });
    } else if (value) scheduleAutosave();
  };

  const operation = (): TranscriptEditQueueRow | null => {
    const rows = local.queue;
    return rows.find((row) => row.queue_status === "submitting" || row.queue_status === "pending" || row.queue_status === "failed") ??
      rows.find((row) => row.id === lastOperationId) ??
      [...rows].reverse().find((row) => row.expected_current_version_id === baseId) ?? null;
  };
  const syncState = (row: TranscriptEditQueueRow | null): TranscriptEditorSyncState => {
    if (!row) return "none";
    if (row.queue_status === "succeeded") return local.currentVersion?.id === row.id ? "accepted_current"
      : !local.currentVersion || local.currentVersion.id === row.expected_current_version_id ? "accepted_refresh_pending" : "accepted_other_current";
    if (row.queue_status === "failed") return row.attempt_count < row.max_attempts ? "retry_wait" : "outcome_unconfirmed";
    if (row.queue_status === "pending") return row.last_error_code === "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED" ? "auth_required"
      : row.last_error_code === "TRANSCRIPT_EDIT_FEATURE_DISABLED" ? "feature_disabled" : row.next_retry_at ? "retry_wait" : "queued";
    return row.queue_status;
  };
  const getSnapshot = (): TranscriptEditorControllerSnapshot => {
    if (alive && !isActive()) invalidate();
    const row = operation();
    let validText = true;
    try { validateTranscriptEditorText(text, false); } catch { validText = false; }
    const blockedSave = local.queue.some((q) => ["pending", "submitting", "failed"].includes(q.queue_status) ||
      (q.expected_current_version_id === baseId && (q.queue_status === "succeeded" || q.queue_status === "conflict")));
    return {
      scope: { ...scope }, phase, text, currentText: local.currentVersion?.plain_text ?? null,
      baseVersionId: baseId, currentVersionId: local.currentVersion?.id ?? null, revision, durableRevision,
      localState: autoBlocked ? "storage_error" : writing ? "saving" : revision > durableRevision ? "dirty" : draft ? "saved" : "clean",
      syncState: syncState(row), operationId: row?.id ?? null,
      staleBase: baseId !== null && baseId !== local.currentVersion?.id,
      draftConflict, canSave: isActive() && phase === "ready" && !exclusive && !saving && !intent && !draftConflict &&
        validText && base !== null && text !== base.plain_text && baseId === local.currentVersion?.id && !blockedSave,
      busy: exclusive || saving !== null, hasFrozenSave: intent !== null,
      frozenSaveMatchesText: intent !== null && intent.text === text,
      errorCode,
    };
  };

  registration = deps.register({ scope, invalidate, waitForIdle, setForeground, refresh });
  foreground = registration.foreground;
  let service: ReturnType<typeof createTranscriptEditorService>;
  try { service = deps.createService(scope, isActive); } catch (error) { invalidate(); throw safeError(error); }

  return {
    scope, open, setText, flushDraft, save, refresh, discard, close, invalidate, waitForIdle, setForeground, getSnapshot,
    subscribe: (listener: () => void): (() => void) => {
      if (!alive) return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    requestLatest: (): void => {
      try { assertActive(); deps.requestCurrent(scope); } catch { /* Reconstructible pull, no false save failure. */ }
    },
  };
};
