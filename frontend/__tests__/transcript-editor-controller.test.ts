import { createTranscriptEditorController } from "@/src/services/transcription/editor-controller";
import { createTranscriptEditorRegistry } from "@/src/services/transcription/editor-lifecycle";
import type { createTranscriptEditorService } from "@/src/services/transcription/editor-service";
import {
  TranscriptEditorError,
  type TranscriptEditorDraftCommand,
  type TranscriptEditorLocalState,
  type TranscriptEditorSaveResult,
} from "@/src/services/transcription/editor-types";
import type { SyncedTranscriptVersionRecord } from "@/src/services/transcription/result-types";
import type { TranscriptEditDraftRow, TranscriptEditQueueRow } from "@/src/services/sqlite/repository";

jest.mock("@/src/services/sync/transcript-current-version-worker", () => ({ requestTranscriptCurrentVersionSync: jest.fn() }));
jest.mock("@/src/services/sync/transcript-edit-worker", () => ({ requestTranscriptEditSync: jest.fn() }));
jest.mock("@/src/services/account-deletion/state", () => ({ isAccountDeletionLocallyPending: () => false }));
jest.mock("@/src/stores/auth-store", () => ({ useAuthStore: { getState: () => ({ initialized: false, user: null }) } }));

const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const BASE = "44444444-4444-4444-8444-444444444444";
const OP = "55555555-5555-4555-8555-555555555555";
const NEXT = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-09-08T00:00:00.000Z";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const base: SyncedTranscriptVersionRecord = {
  id: BASE, workspace_id: WORKSPACE, session_id: SESSION, version: 1,
  version_origin: "provider", version_status: "final", is_current: true,
  plain_text: "  Original.\n", parent_version_id: null, created_by: USER,
  created_at: NOW, updated_at: NOW, transcription_run_id: null,
  language_summary: {}, content_checksum_sha256: null,
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const controllers: ReturnType<typeof createTranscriptEditorController>[] = [];

// Controlled service fixture for controller ordering, not native SQLite proof.
const setup = () => {
  const state = {
    draft: null as TranscriptEditDraftRow | null,
    current: { ...base } as SyncedTranscriptVersionRecord | null,
    queue: [] as TranscriptEditQueueRow[], missingBase: false,
    failDraft: false, failSave: false, failLoad: false, deleting: false,
  };
  let active = () => true;
  let clock = 0;
  const guard = () => {
    if (!active()) throw new TranscriptEditorError("EDITOR_CONTEXT_INACTIVE");
    if (state.deleting) throw new TranscriptEditorError("EDITOR_SESSION_UNAVAILABLE");
  };
  const makeDraft = (input: TranscriptEditorDraftCommand): TranscriptEditDraftRow => ({
    user_id: USER, workspace_id: WORKSPACE, session_id: SESSION,
    base_version_id: input.baseVersionId, plain_text: input.plainText,
    created_at: state.draft?.created_at ?? NOW,
    updated_at: new Date(Date.parse(NOW) + ++clock).toISOString(),
  });
  const port: ReturnType<typeof createTranscriptEditorService> = {
    load: jest.fn(async (): Promise<TranscriptEditorLocalState> => {
      guard();
      if (state.failLoad) throw new TranscriptEditorError("EDITOR_LOCAL_STORAGE_FAILED");
      return { currentVersion: state.current && { ...state.current },
        draft: state.draft && { ...state.draft }, queue: state.queue.map((row) => ({ ...row })),
        baseVersion: !state.draft || state.missingBase ? null : { ...base, is_current: state.current?.id === BASE } };
    }),
    saveDraft: jest.fn(async (input) => {
      guard();
      if (state.failDraft) throw new TranscriptEditorError("EDITOR_LOCAL_STORAGE_FAILED");
      if (JSON.stringify(input.expectedDraft) !== JSON.stringify(state.draft)) throw new TranscriptEditorError("EDITOR_DRAFT_CHANGED");
      if (!state.draft && state.current?.id !== input.baseVersionId) throw new TranscriptEditorError("EDITOR_BASE_CHANGED");
      if (!state.draft && state.queue.some((row) => row.expected_current_version_id === input.baseVersionId && row.queue_status === "succeeded")) {
        throw new TranscriptEditorError("EDITOR_REFRESH_REQUIRED");
      }
      state.draft = makeDraft(input);
      return { ...state.draft };
    }),
    preserveDraft: jest.fn(async (input) => {
      guard();
      if (state.draft || state.missingBase) throw new TranscriptEditorError("EDITOR_RECOVERY_REJECTED");
      const proof = input.proof;
      if (proof.kind === "completed_save" && !state.queue.some((q) => q.id === proof.operationId && q.queue_status === "succeeded")) {
        throw new TranscriptEditorError("EDITOR_RECOVERY_REJECTED");
      }
      state.draft = makeDraft({ plainText: input.plainText, baseVersionId: input.proof.base.id, expectedDraft: null });
      return { ...state.draft };
    }),
    save: jest.fn(async (input): Promise<TranscriptEditorSaveResult> => {
      guard();
      if (state.failSave) throw new TranscriptEditorError("EDITOR_LOCAL_STORAGE_FAILED");
      const existing = state.queue.find((q) => q.id === input.clientVersionId);
      if (existing) return { kind: "existing", operation: { ...existing }, draft: state.draft && { ...state.draft } };
      if (state.current?.id !== input.baseVersionId) throw new TranscriptEditorError("EDITOR_BASE_CHANGED");
      if (!input.preserveNewerDraft) state.draft = makeDraft(input);
      const operation: TranscriptEditQueueRow = {
        id: input.clientVersionId!, user_id: USER, workspace_id: WORKSPACE, session_id: SESSION,
        expected_current_version_id: input.baseVersionId, plain_text: input.plainText,
        queue_status: "pending", attempt_count: 0, max_attempts: 5, next_retry_at: null,
        last_error_code: null, last_safe_error: null, created_at: NOW, updated_at: NOW,
      };
      state.queue.push(operation);
      return { kind: "queued", operation, draft: state.draft && { ...state.draft } };
    }),
    discardDraft: jest.fn(async (expected) => {
      guard();
      if (state.queue.some((row) => ["pending", "submitting", "failed"].includes(row.queue_status))) throw new TranscriptEditorError("EDITOR_OPERATION_PENDING");
      if (JSON.stringify(expected) !== JSON.stringify(state.draft)) throw new TranscriptEditorError("EDITOR_DRAFT_CHANGED");
      state.draft = null;
    }),
  };
  const registry = createTranscriptEditorRegistry();
  const requestCurrent = jest.fn();
  const createId = jest.fn(() => OP);
  const c = createTranscriptEditorController(scope, {
    createService: (_scope, isActive) => { active = isActive; return port; },
    register: registry.register, createId, requestCurrent,
  });
  controllers.push(c);
  return { c, state, port, registry, createId, requestCurrent,
    nextCurrent: () => { state.current = { ...base, id: NEXT, version: 2, plain_text: "Remote.", version_origin: "user_edit", parent_version_id: BASE }; },
    complete: () => {
      const row = state.queue[0]; row.queue_status = "succeeded";
      if (state.draft?.base_version_id === row.expected_current_version_id && state.draft.plain_text === row.plain_text) state.draft = null;
    },
  };
};

beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(async () => {
  for (const c of controllers.splice(0)) { c.invalidate(); await c.waitForIdle(); }
  jest.useRealTimers();
});

describe("3D.2B2 headless editor controller", () => {
  it("loads exact text without creating a draft or Save", async () => {
    const { c, port } = setup(); await c.open();
    expect(c.getSnapshot()).toMatchObject({ text: "  Original.\n", localState: "clean", canSave: false });
    expect(port.saveDraft).not.toHaveBeenCalled(); expect(port.save).not.toHaveBeenCalled();
  });
  it("restores an intentionally empty draft instead of falling back to current text", async () => {
    const { c, state } = setup(); state.draft = { user_id: USER, workspace_id: WORKSPACE, session_id: SESSION,
      base_version_id: BASE, plain_text: "", created_at: NOW, updated_at: NOW };
    await c.open(); expect(c.getSnapshot().text).toBe(""); expect(c.getSnapshot().localState).toBe("saved");
  });
  it("retains draft text with a missing historical base, without allowing Save", async () => {
    const { c, state } = setup(); state.missingBase = true; state.current = null;
    state.draft = { user_id: USER, workspace_id: WORKSPACE, session_id: SESSION,
      base_version_id: BASE, plain_text: "Recovered", created_at: NOW, updated_at: NOW };
    await c.open(); expect(c.getSnapshot()).toMatchObject({ text: "Recovered", canSave: false, phase: "ready" });
  });
  it("does not allow editing before load or without any local current/draft", async () => {
    const { c, state } = setup(); expect(() => c.setText("x")).toThrow(TranscriptEditorError);
    state.current = null; await c.open(); expect(c.getSnapshot().phase).toBe("unavailable");
    expect(() => c.setText("x")).toThrow(TranscriptEditorError);
  });
  it("debounces local autosave and never creates an outbox from typing", async () => {
    const { c, port } = setup(); await c.open(); c.setText("A");
    await jest.advanceTimersByTimeAsync(200); c.setText("B");
    await jest.advanceTimersByTimeAsync(299); expect(port.saveDraft).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); await c.waitForIdle();
    expect(port.saveDraft).toHaveBeenCalledTimes(1); expect(c.getSnapshot().localState).toBe("saved");
    expect(port.save).not.toHaveBeenCalled();
  });
  it("bounds continuous typing by maxWait instead of delaying autosave forever", async () => {
    const { c, port } = setup(); await c.open();
    for (let i = 0; i < 10; i += 1) { c.setText(`Text ${i}`); await jest.advanceTimersByTimeAsync(200); }
    await c.waitForIdle(); expect(port.saveDraft).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().text).toBe("Text 9");
  });
  it("uses committed expectations in order and never rewinds newer buffer text", async () => {
    const { c, port, state } = setup(); await c.open();
    const entered = deferred(); const released = deferred();
    const original = port.saveDraft;
    port.saveDraft = jest.fn(async (input) => { entered.resolve(); await released.promise; return original(input); });
    c.setText("A"); const a = c.flushDraft(); await entered.promise;
    c.setText("B"); const b = c.flushDraft(); released.resolve(); await a;
    expect(c.getSnapshot().text).toBe("B"); await b;
    expect(state.draft?.plain_text).toBe("B"); expect(c.getSnapshot().durableRevision).toBe(2);
  });
  it("stops timer retry on storage failure and keeps the dirty buffer", async () => {
    const { c, state, port } = setup(); await c.open(); state.failDraft = true; c.setText("Keep");
    await jest.advanceTimersByTimeAsync(300); await c.waitForIdle();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(port.saveDraft).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({ text: "Keep", localState: "storage_error" });
    state.failDraft = false; await c.flushDraft(); expect(state.draft?.plain_text).toBe("Keep");
  });
  it("coalesces double-tap Save with one frozen UUID and exact text", async () => {
    const { c, createId, state } = setup(); await c.open(); c.setText("  A\n");
    const first = c.save(); const second = c.save(); expect(second).toBe(first);
    await first; expect(createId).toHaveBeenCalledTimes(1); expect(state.queue).toHaveLength(1);
    expect(state.queue[0].plain_text).toBe("  A\n");
  });
  it("preserves later typing while the prior Save is awaiting persistence", async () => {
    const { c, state, port } = setup(); await c.open();
    const entered = deferred(); const released = deferred(); const original = port.save;
    port.save = jest.fn(async (input) => { entered.resolve(); await released.promise; return original(input); });
    c.setText("A"); const saved = c.save(); await entered.promise; c.setText("B");
    released.resolve(); await saved;
    expect(c.getSnapshot().text).toBe("B"); expect(state.queue[0].plain_text).toBe("A");
    await c.flushDraft(); expect(state.draft?.plain_text).toBe("B");
  });
  it("keeps A frozen after a local enqueue failure even when B autosaves before Retry", async () => {
    const { c, state, port, createId } = setup(); await c.open(); state.failSave = true;
    c.setText("A"); await expect(c.save()).rejects.toMatchObject({ code: "EDITOR_LOCAL_STORAGE_FAILED" });
    c.setText("B"); await c.flushDraft(); state.failSave = false; await c.save();
    expect(createId).toHaveBeenCalledTimes(1); expect(state.queue[0].plain_text).toBe("A");
    expect(state.draft?.plain_text).toBe("B");
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ clientVersionId: OP, plainText: "A", preserveNewerDraft: true }));
  });
  it("keeps typed text as a stale draft if current advanced before the first autosave", async () => {
    const { c, state, port, nextCurrent } = setup(); await c.open(); c.setText("Local"); nextCurrent();
    await c.flushDraft();
    expect(port.preserveDraft).toHaveBeenCalledWith(expect.objectContaining({ proof: expect.objectContaining({ kind: "observed_base" }) }));
    expect(state.draft).toMatchObject({ plain_text: "Local", base_version_id: BASE });
    expect(c.getSnapshot()).toMatchObject({ staleBase: true, canSave: false });
  });
  it("recovers B when completion of A consumed its expected draft", async () => {
    const { c, state, port, complete, nextCurrent } = setup(); await c.open(); c.setText("A"); await c.save();
    c.setText("B"); complete(); nextCurrent(); await c.flushDraft();
    expect(state.draft).toMatchObject({ plain_text: "B", base_version_id: BASE });
    expect(port.preserveDraft).toHaveBeenCalledWith(expect.objectContaining({ proof: expect.objectContaining({ kind: "completed_save", operationId: OP }) }));
  });
  it("allows later typing after a clean Save success without silently rebasing", async () => {
    const { c, state, complete, nextCurrent } = setup(); await c.open(); c.setText("A"); await c.save();
    complete(); nextCurrent(); await c.refresh(); c.setText("B"); await c.flushDraft();
    expect(state.draft?.base_version_id).toBe(BASE); expect(c.getSnapshot().canSave).toBe(false);
  });
  it("does not resurrect a draft from a succeeded outbox on cold open", async () => {
    const { c, state, complete } = setup(); await c.open(); c.setText("A"); await c.save(); complete();
    c.invalidate(); await c.waitForIdle(); await Promise.resolve();
    const second = setup(); second.state.queue = state.queue.map((r) => ({ ...r }));
    await second.c.open(); expect(second.state.draft).toBeNull(); expect(second.port.preserveDraft).not.toHaveBeenCalled();
  });
  it("blocks unknown draft deletion rather than guessing it was completion", async () => {
    const { c, state, port } = setup(); await c.open(); c.setText("A"); await c.flushDraft();
    state.draft = null; c.setText("B"); await expect(c.flushDraft()).rejects.toMatchObject({ code: "EDITOR_DRAFT_CHANGED" });
    expect(state.draft).toBeNull(); expect(port.preserveDraft).not.toHaveBeenCalled(); expect(c.getSnapshot().text).toBe("B");
  });
  it("does not overwrite a replacement draft after a refresh", async () => {
    const { c, state } = setup(); await c.open(); c.setText("A"); await c.flushDraft();
    state.draft = { ...state.draft!, plain_text: "Other" }; c.setText("B"); await c.refresh();
    await expect(c.flushDraft()).rejects.toMatchObject({ code: "EDITOR_DRAFT_CHANGED" });
    expect(state.draft.plain_text).toBe("Other"); expect(c.getSnapshot().text).toBe("B");
  });
  it("does not replace dirty text or base during remote-current refresh", async () => {
    const { c, nextCurrent } = setup(); await c.open(); c.setText("Mine"); nextCurrent(); await c.refresh();
    expect(c.getSnapshot()).toMatchObject({ text: "Mine", currentText: "Remote.", baseVersionId: BASE, staleBase: true });
  });
  it("coalesces overlapping refreshes without turning reads into autosaves", async () => {
    const { c, port } = setup(); await c.open();
    const entered = deferred(); const release = deferred(); const original = port.load;
    let once = true; port.load = jest.fn(async () => { if (once) { once = false; entered.resolve(); await release.promise; } return original(); });
    const first = c.refresh(); await entered.promise; const second = c.refresh(); expect(second).toBe(first);
    release.resolve(); await first;
    expect(port.load).toHaveBeenCalledTimes(2); expect(port.saveDraft).not.toHaveBeenCalled();
  });
  it("invalidates pending SQL callbacks and scrubs private text", async () => {
    const { c, state } = setup(); await c.open(); c.setText("Private");
    const pending = c.flushDraft(); c.invalidate(); await expect(pending).rejects.toMatchObject({ code: "EDITOR_CONTEXT_INACTIVE" });
    expect(state.draft).toBeNull(); expect(c.getSnapshot()).toMatchObject({ text: "", phase: "invalidated" });
  });
  it("closes only after the latest local buffer is durably flushed", async () => {
    const { c, state } = setup(); await c.open(); c.setText("Close me"); await c.close();
    expect(state.draft?.plain_text).toBe("Close me"); expect(c.getSnapshot()).toMatchObject({ phase: "closed", text: "" });
  });
  it("keeps the controller open when close cannot flush", async () => {
    const { c, state } = setup(); await c.open(); c.setText("Keep"); state.failDraft = true;
    await expect(c.close()).rejects.toMatchObject({ code: "EDITOR_LOCAL_STORAGE_FAILED" });
    expect(c.getSnapshot()).toMatchObject({ phase: "ready", text: "Keep", busy: false });
  });
  it("background flush does not invalidate the local context or need a network", async () => {
    const { c, state } = setup(); await c.open(); c.setText("Offline local"); c.setForeground(false);
    await c.waitForIdle(); expect(state.draft?.plain_text).toBe("Offline local");
    expect(c.getSnapshot().phase).toBe("ready");
  });
  it("rejects stale discard confirmation and does not erase newer typing", async () => {
    const { c, state } = setup(); await c.open(); c.setText("A"); await c.flushDraft();
    const confirmed = c.getSnapshot().revision; c.setText("B");
    await expect(c.discard(confirmed)).rejects.toMatchObject({ code: "EDITOR_DRAFT_CHANGED" });
    expect(state.draft?.plain_text).toBe("A"); expect(c.getSnapshot().text).toBe("B");
  });
  it("discards explicitly and loads current without reviving old timer callbacks", async () => {
    const { c, state, nextCurrent } = setup(); await c.open(); c.setText("Old"); await c.flushDraft();
    nextCurrent(); await c.discard(c.getSnapshot().revision); await jest.advanceTimersByTimeAsync(5000);
    expect(state.draft).toBeNull(); expect(c.getSnapshot()).toMatchObject({ text: "Remote.", baseVersionId: NEXT });
  });
  it("blocks discard while Save is unresolved", async () => {
    const { c, state } = setup(); await c.open(); c.setText("A"); await c.save();
    await expect(c.discard(c.getSnapshot().revision)).rejects.toMatchObject({ code: "EDITOR_OPERATION_PENDING" });
    expect(state.queue).toHaveLength(1); expect(state.draft).not.toBeNull();
  });
  it("invalidates on session deletion rather than recreating local content", async () => {
    const { c, state } = setup(); await c.open(); c.setText("A"); state.deleting = true;
    await expect(c.flushDraft()).rejects.toMatchObject({ code: "EDITOR_SESSION_UNAVAILABLE" });
    expect(c.getSnapshot().phase).toBe("invalidated"); expect(state.draft).toBeNull();
  });
  it("keeps accepted status distinct from current cache and later versions", async () => {
    const { c, state, complete, nextCurrent } = setup(); await c.open(); c.setText("A"); await c.save(); complete(); await c.refresh();
    expect(c.getSnapshot().syncState).toBe("accepted_refresh_pending");
    state.current = { ...base, id: OP, version: 2 }; await c.refresh(); expect(c.getSnapshot().syncState).toBe("accepted_current");
    nextCurrent(); await c.refresh(); expect(c.getSnapshot().syncState).toBe("accepted_other_current");
  });
  it.each(["conflict", "cancelled", "failed"] as const)("does not label an existing %s row as a new success", async (status) => {
    const { c, state } = setup(); await c.open(); c.setText("A"); await c.save();
    state.queue[0].queue_status = status; state.queue[0].attempt_count = 5; await c.refresh();
    expect(c.getSnapshot().syncState).toBe(status === "failed" ? "outcome_unconfirmed" : status);
  });
  it("rejects blank or unchanged Save without generating an operation", async () => {
    const { c, createId } = setup(); await c.open();
    await expect(c.save()).rejects.toMatchObject({ code: "EDITOR_UNCHANGED" }); c.setText("");
    await expect(c.save()).rejects.toMatchObject({ code: "EDITOR_TEXT_BLANK" }); expect(createId).not.toHaveBeenCalled();
  });
  it("returns detached snapshots and isolates observer failures", async () => {
    const { c, state } = setup(); await c.open(); c.subscribe(() => { throw new Error("observer"); });
    const snapshot = c.getSnapshot(); snapshot.text = "mutated";
    c.setText("Actual"); await c.flushDraft(); expect(state.draft?.plain_text).toBe("Actual");
    expect(c.getSnapshot().text).toBe("Actual");
  });
  it("does not let an old discard confirmation become valid after a reset", async () => {
    const { c } = setup(); await c.open(); c.setText("A"); await c.flushDraft();
    const old = c.getSnapshot().revision; await c.discard(old); c.setText("B");
    await expect(c.discard(old)).rejects.toMatchObject({ code: "EDITOR_DRAFT_CHANGED" });
    expect(c.getSnapshot().text).toBe("B");
  });
  it("rejects a flush queued behind discard so discarded text cannot return", async () => {
    const { c, state } = setup(); await c.open(); c.setText("A"); await c.flushDraft();
    const discarded = c.discard(c.getSnapshot().revision);
    await expect(c.flushDraft()).rejects.toMatchObject({ code: "EDITOR_BUSY" });
    await discarded; await jest.advanceTimersByTimeAsync(3_000);
    expect(state.draft).toBeNull();
  });
  it("requests latest through the existing worker without sending a Save", async () => {
    const { c, requestCurrent, port } = setup(); await c.open(); c.requestLatest();
    expect(requestCurrent).toHaveBeenCalledWith(scope); expect(port.save).not.toHaveBeenCalled();
  });
});
