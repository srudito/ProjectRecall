import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { createTranscriptEditorController } from "@/src/services/transcription/editor-controller";
import {
  TranscriptEditorError,
  type TranscriptEditorControllerSnapshot,
  type TranscriptEditorErrorCode,
  type TranscriptEditorScope,
} from "@/src/services/transcription/editor-types";
import { useAuthStore } from "@/src/stores/auth-store";

export type EditorUiAction = "save" | "flush" | "discard" | "reload" | "close";
export type EditorUiResult = { ok: true } | { ok: false; code: TranscriptEditorErrorCode };
type Controller = ReturnType<typeof createTranscriptEditorController>;
type Factory = typeof createTranscriptEditorController;
type Owner = {
  key: string;
  scope: TranscriptEditorScope;
  controller: Controller | null;
  cancelled: boolean;
  unsubscribe: (() => void) | null;
  action: EditorUiAction | null;
  loading: boolean;
  error: TranscriptEditorErrorCode | null;
  publish: () => void;
};
type ViewState = {
  owner: Owner;
  snapshot: TranscriptEditorControllerSnapshot | null;
  action: EditorUiAction | null;
  loading: boolean;
  error: TranscriptEditorErrorCode | null;
};

// Only owners retired by this adapter are awaited. A separate LIVE editor is
// never evicted. This also covers Strict Mode setup/cleanup and fast reopen.
const retiring = new Map<string, Promise<void>>();
const retire = (owner: Owner): void => {
  if (owner.cancelled) return;
  owner.cancelled = true;
  owner.unsubscribe?.();
  const controller = owner.controller;
  if (!controller) return;
  controller.invalidate();
  const drained = Promise.resolve().then(async () => {
    await controller.waitForIdle();
    // The registry releases its retired token after the same drain settles.
    await Promise.resolve();
  });
  retiring.set(owner.key, drained);
  void drained.then(() => {
    if (retiring.get(owner.key) === drained) retiring.delete(owner.key);
  }, () => { /* Fail closed: do not replace an owner whose drain failed. */ });
};
const codeOf = (error: unknown): TranscriptEditorErrorCode =>
  error instanceof TranscriptEditorError ? error.code : "EDITOR_LOCAL_STORAGE_FAILED";
const failed = (code: TranscriptEditorErrorCode): EditorUiResult => ({ ok: false, code });

/** React adapter only. Never creates a controller or reads its impure snapshot
 * during render; timers, durability and network retry remain in the core. */
export function useTranscriptEditor(
  scope: Readonly<TranscriptEditorScope> | null,
  createController: Factory = createTranscriptEditorController,
) {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const initialized = useAuthStore((state) => state.initialized);
  const scopeUser = scope?.userId.toLowerCase() ?? "";
  const workspaceId = scope?.workspaceId.toLowerCase() ?? "";
  const sessionId = scope?.sessionId.toLowerCase() ?? "";
  const key = `${scopeUser}:${workspaceId}:${sessionId}`;
  const enabled = (Platform.OS === "android" || Platform.OS === "ios") &&
    initialized && userId?.toLowerCase() === scopeUser && Boolean(scopeUser && workspaceId && sessionId);
  const ownerRef = useRef<Owner | null>(null);
  const [view, setView] = useState<ViewState | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) { setView(null); return; }
    const owner: Owner = {
      key, scope: { userId: scopeUser, workspaceId, sessionId }, controller: null,
      cancelled: false, unsubscribe: null, action: null, loading: true, error: null,
      publish: () => {},
    };
    ownerRef.current = owner;
    const current = () => !owner.cancelled && ownerRef.current === owner;
    let publishing = false;
    owner.publish = () => {
      if (!current() || publishing) return;
      publishing = true;
      try {
        const snapshot = owner.controller?.getSnapshot() ?? null;
        if (current()) setView({ owner, snapshot, action: owner.action,
          loading: owner.loading, error: owner.error });
      } finally { publishing = false; }
    };
    owner.publish();
    // Yield once: a discarded Strict Mode setup must not register a writer.
    void Promise.resolve().then(async () => {
      try {
        const previous = retiring.get(key);
        if (previous) await previous;
        if (!current()) return;
        owner.controller = createController(owner.scope);
        owner.unsubscribe = owner.controller.subscribe(owner.publish);
        await owner.controller.open();
      } catch (error) {
        if (current()) owner.error = codeOf(error);
      } finally {
        if (current()) { owner.loading = false; owner.publish(); }
      }
    });
    return () => {
      retire(owner);
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [enabled, key, scopeUser, workspaceId, sessionId, createController, loadAttempt]);

  // Mask old private snapshots synchronously on a scope/auth render, before
  // effect cleanup. Event handlers are bound to this exact owner, not just ID.
  const visible = enabled && view?.owner.key === key && !view.owner.cancelled ? view : null;
  const owner = visible?.owner ?? null;
  const activeOwner = (): Owner | null => {
    const auth = useAuthStore.getState();
    return owner && ownerRef.current === owner && !owner.cancelled && auth.initialized &&
      auth.user?.id.toLowerCase() === owner.scope.userId ? owner : null;
  };
  const run = async (action: EditorUiAction, task: (c: Controller) => Promise<unknown>): Promise<EditorUiResult> => {
    const target = activeOwner();
    if (!target?.controller) return failed("EDITOR_NOT_READY");
    if (target.action || target.loading) return failed("EDITOR_BUSY");
    target.action = action;
    target.error = null;
    target.publish();
    try {
      await task(target.controller);
      return activeOwner() === target ? { ok: true } : failed("EDITOR_CONTEXT_INACTIVE");
    } catch (error) {
      const code = codeOf(error);
      if (activeOwner() === target) target.error = code;
      return failed(code);
    } finally {
      // Controller promise-finalizers may clear busy WITHOUT another event.
      target.action = null;
      target.publish();
    }
  };
  const setText = (text: string): void => {
    const target = activeOwner();
    if (!target?.controller) return;
    try { target.error = null; target.controller.setText(text); }
    catch (error) { target.error = codeOf(error); }
    target.publish();
  };
  const close = async (): Promise<EditorUiResult> => {
    const target = activeOwner();
    if (!target) return owner ? failed("EDITOR_CONTEXT_INACTIVE") : { ok: true };
    if (target.action) return failed("EDITOR_BUSY");
    const phase = target.controller?.getSnapshot().phase;
    if (target.loading || !target.controller || phase !== "ready") {
      // No editing buffer exists in loading/unavailable; abort pending loads.
      retire(target);
      return { ok: true };
    }
    return run("close", (c) => c.close());
  };
  const abandon = async (confirmedRevision: number): Promise<EditorUiResult> => {
    const target = activeOwner();
    if (!target?.controller) return failed("EDITOR_CONTEXT_INACTIVE");
    if (target.action) return failed("EDITOR_BUSY");
    if (target.controller.getSnapshot().revision !== confirmedRevision) {
      target.error = "EDITOR_DRAFT_CHANGED";
      target.publish();
      return failed("EDITOR_DRAFT_CHANGED");
    }
    // Explicitly abandon the open buffer only. Never delete a durable draft,
    // cancel an RPC, or alter the outbox/UUID/attempt budget.
    retire(target);
    return { ok: true };
  };
  return {
    snapshot: visible?.snapshot ?? null,
    loading: visible?.loading ?? enabled,
    action: visible?.action ?? null,
    errorCode: !enabled ? "EDITOR_CONTEXT_INACTIVE" as const : visible?.error ?? visible?.snapshot?.errorCode ?? null,
    setText,
    save: () => run("save", (c) => c.save()),
    flush: () => run("flush", (c) => c.flushDraft()),
    discard: (revision: number) => run("discard", (c) => c.discard(revision)),
    reload: async (): Promise<EditorUiResult> => {
      const target = activeOwner();
      if (!target) return failed("EDITOR_CONTEXT_INACTIVE");
      if (target.action || target.loading) return failed("EDITOR_BUSY");
      if (!target.controller) { setLoadAttempt((value) => value + 1); return { ok: true }; }
      return run("reload", (c) => c.open());
    },
    requestLatest: (): void => {
      const target = activeOwner();
      if (!target?.controller || target.action || target.loading) return;
      target.controller.requestLatest();
      // Pull is a request, not a promise of fresh server data. Re-read the local
      // cache now; the headless lifecycle will deliver future sync changes.
      void run("reload", (c) => c.refresh());
    },
    close, abandon,
  };
}
