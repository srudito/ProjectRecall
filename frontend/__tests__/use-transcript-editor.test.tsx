import React, { act, StrictMode } from "react";
import { useTranscriptEditor } from "@/src/hooks/use-transcript-editor";
import { createTranscriptEditorController } from "@/src/services/transcription/editor-controller";
import { TranscriptEditorError, type TranscriptEditorControllerSnapshot, type TranscriptEditorScope } from "@/src/services/transcription/editor-types";

// Renderer is supplied by the pinned jest-expo 54 preset. No new dependency.
type Tree = { update: (node: React.ReactNode) => void; unmount: () => void };
const { create } = jest.requireActual<{ create: (node: React.ReactNode) => Tree }>("react-test-renderer");
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("@/src/services/transcription/editor-controller", () => ({ createTranscriptEditorController: jest.fn() }));
const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
let mockAuth = { initialized: true, user: { id: USER } as { id: string } | null };
jest.mock("@/src/stores/auth-store", () => ({ useAuthStore: Object.assign(
  (select: (state: typeof mockAuth) => unknown) => select(mockAuth), { getState: () => mockAuth },
) }));
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
type Controller = ReturnType<typeof createTranscriptEditorController>;
let tree: Tree | null = null;
let latest: ReturnType<typeof useTranscriptEditor>;
let renders = 0;
const releases: (() => void)[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  releases.push(resolve); return { promise, resolve };
};
const makeController = (ownerScope: TranscriptEditorScope = scope) => {
  let state: TranscriptEditorControllerSnapshot = {
    scope: ownerScope, phase: "uninitialized", text: "", currentText: "Original", baseVersionId: "base", currentVersionId: "base",
    revision: 0, durableRevision: 0, localState: "clean", syncState: "none", operationId: null,
    staleBase: false, draftConflict: false, canSave: false, busy: false,
    hasFrozenSave: false, frozenSaveMatchesText: false, errorCode: null,
  };
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const change = (patch: Partial<TranscriptEditorControllerSnapshot>, notify = true) => {
    state = { ...state, ...patch }; if (notify) emit();
  };
  const c: Controller = {
    scope: ownerScope,
    getSnapshot: jest.fn(() => ({ ...state, scope: { ...state.scope } })),
    subscribe: jest.fn((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    open: jest.fn(async () => { change({ phase: "ready", text: "Original" }); }),
    refresh: jest.fn(async () => { emit(); }),
    setText: jest.fn((text: string) => { change({ text, revision: state.revision + 1, localState: "dirty", canSave: true }); }),
    flushDraft: jest.fn(async () => { change({ durableRevision: state.revision, localState: "saved" }); }),
    save: jest.fn(async () => {
      change({ busy: true });
      await Promise.resolve();
      change({ busy: false, canSave: false, syncState: "queued" }, false);
      return { kind: "existing" as const, operation: { id: "persisted-operation" }, draft: null } as Awaited<ReturnType<Controller["save"]>>;
    }),
    discard: jest.fn(async (_revision: number) => { change({ text: "Original" }); }),
    close: jest.fn(async () => { change({ phase: "closed", text: "" }); }),
    invalidate: jest.fn(() => { change({ phase: "invalidated", text: "" }); }),
    waitForIdle: jest.fn(async () => undefined), setForeground: jest.fn(), requestLatest: jest.fn(),
  };
  return { c, change, listeners };
};
function Probe({ value = scope }: { value?: TranscriptEditorScope }) {
  latest = useTranscriptEditor(value); renders += 1; return null;
}
const settle = async () => { await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }); };
const mount = async (node: React.ReactNode = <Probe />) => {
  await act(async () => { tree = create(node); }); await settle();
};
beforeEach(() => {
  jest.clearAllMocks(); renders = 0; mockAuth = { initialized: true, user: { id: USER } };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await act(async () => { tree?.unmount(); tree = null; }); await settle();
});

describe("3D.3 rendered React editor adapter", () => {
  it("opens from an effect and stores snapshots without a getSnapshot render loop", async () => {
    const { c } = makeController(); (createTranscriptEditorController as jest.Mock).mockReturnValue(c);
    await mount(); expect(c.open).toHaveBeenCalledTimes(1); expect(latest.snapshot?.text).toBe("Original");
    const reads = (c.getSnapshot as jest.Mock).mock.calls.length;
    await act(async () => { tree!.update(<Probe value={{ ...scope }} />); });
    expect(c.getSnapshot).toHaveBeenCalledTimes(reads); expect(createTranscriptEditorController).toHaveBeenCalledTimes(1);
    expect(renders).toBeLessThan(10);
  });
  it("resamples after Save settles even if core clears busy without emitting", async () => {
    const { c } = makeController(); (createTranscriptEditorController as jest.Mock).mockReturnValue(c);
    await mount(); await act(async () => { latest.setText("New"); });
    await act(async () => { await expect(latest.save()).resolves.toEqual({ ok: true }); });
    expect(latest.action).toBeNull(); expect(latest.snapshot).toMatchObject({ busy: false, syncState: "queued" });
    expect(c.close).not.toHaveBeenCalled();
  });
  it("blocks concurrent button actions but permits newer typing during Save", async () => {
    const { c } = makeController(); const blocked = deferred();
    c.save = jest.fn(async () => { await blocked.promise; return { kind: "existing", draft: null, operation: { id: "operation" } } as Awaited<ReturnType<Controller["save"]>>; });
    (createTranscriptEditorController as jest.Mock).mockReturnValue(c); await mount();
    let pending!: ReturnType<typeof latest.save>;
    await act(async () => { pending = latest.save(); latest.setText("Later"); });
    await act(async () => { await expect(latest.save()).resolves.toMatchObject({ ok: false, code: "EDITOR_BUSY" }); });
    blocked.resolve(); await act(async () => { await pending; });
    expect(c.save).toHaveBeenCalledTimes(1); expect(latest.snapshot?.text).toBe("Later");
  });
  it("keeps the modal owner alive and returns a safe error when close cannot flush", async () => {
    const { c } = makeController(); c.close = jest.fn(async () => { throw new TranscriptEditorError("EDITOR_LOCAL_STORAGE_FAILED"); });
    (createTranscriptEditorController as jest.Mock).mockReturnValue(c); await mount();
    await act(async () => { await expect(latest.close()).resolves.toMatchObject({ ok: false }); });
    expect(latest.errorCode).toBe("EDITOR_LOCAL_STORAGE_FAILED"); expect(c.invalidate).not.toHaveBeenCalled();
  });
  it("allows closing an unresolved initial load and ignores its late result", async () => {
    const { c } = makeController(); const blocked = deferred(); c.open = jest.fn(() => blocked.promise);
    (createTranscriptEditorController as jest.Mock).mockReturnValue(c); await mount();
    expect(latest.loading).toBe(true);
    await act(async () => { await expect(latest.close()).resolves.toEqual({ ok: true }); });
    expect(c.invalidate).toHaveBeenCalledTimes(1); expect(c.close).not.toHaveBeenCalled();
    blocked.resolve(); await settle();
  });
  it("rejects stale discard/abandon callbacks instead of dropping newer typing", async () => {
    const { c } = makeController(); (createTranscriptEditorController as jest.Mock).mockReturnValue(c); await mount();
    const revision = latest.snapshot!.revision;
    await act(async () => { latest.setText("Newer"); });
    await act(async () => { await expect(latest.abandon(revision)).resolves.toMatchObject({ ok: false, code: "EDITOR_DRAFT_CHANGED" }); });
    expect(c.invalidate).not.toHaveBeenCalled();
    await act(async () => { await latest.discard(revision); });
    expect(c.discard).toHaveBeenCalledWith(revision); // Core, not the adapter, validates discard CAS.
  });
  it("awaits this adapter's retiring owner before a fast same-scope reopen", async () => {
    const first = makeController(); const second = makeController(); const drain = deferred();
    first.c.waitForIdle = jest.fn(() => drain.promise);
    (createTranscriptEditorController as jest.Mock).mockReturnValueOnce(first.c).mockReturnValueOnce(second.c);
    await mount(); await act(async () => { tree!.unmount(); tree = null; });
    await mount(); expect(createTranscriptEditorController).toHaveBeenCalledTimes(1);
    drain.resolve(); await settle(); expect(createTranscriptEditorController).toHaveBeenCalledTimes(2);
    expect(second.c.open).toHaveBeenCalledTimes(1);
  });
  it("does not evict another live registry owner when opening fails", async () => {
    (createTranscriptEditorController as jest.Mock).mockImplementation(() => { throw new TranscriptEditorError("EDITOR_SCOPE_IN_USE"); });
    await mount(); expect(latest.errorCode).toBe("EDITOR_SCOPE_IN_USE"); expect(latest.loading).toBe(false);
    await act(async () => { await latest.close(); });
  });
  it("handles Strict Mode setup/cleanup without making a writer during render", async () => {
    const { c } = makeController(); (createTranscriptEditorController as jest.Mock).mockReturnValue(c);
    await mount(<StrictMode><Probe /></StrictMode>);
    expect(createTranscriptEditorController).toHaveBeenCalledTimes(1); expect(c.open).toHaveBeenCalledTimes(1);
  });
  it("does not recreate ownership for same-user auth refresh or new scope objects", async () => {
    const { c } = makeController(); (createTranscriptEditorController as jest.Mock).mockReturnValue(c); await mount();
    await act(async () => { latest.setText("Keep"); mockAuth = { ...mockAuth }; tree!.update(<Probe value={{ ...scope }} />); });
    expect(createTranscriptEditorController).toHaveBeenCalledTimes(1); expect(latest.snapshot?.text).toBe("Keep");
  });
  it("masks the old snapshot and refuses old handlers after A -> B -> A", async () => {
    (createTranscriptEditorController as jest.Mock).mockImplementation((s: TranscriptEditorScope) => makeController(s).c);
    await mount(); const oldSetText = latest.setText; const oldReload = latest.reload;
    const other = { ...scope, userId: WORKSPACE };
    await act(async () => { mockAuth = { ...mockAuth, user: { id: WORKSPACE } }; tree!.update(<Probe value={other} />); }); await settle();
    expect(latest.snapshot?.scope.userId).toBe(WORKSPACE);
    await act(async () => { mockAuth = { ...mockAuth, user: { id: USER } }; tree!.update(<Probe />); }); await settle();
    await act(async () => { oldSetText("Should not arrive"); });
    expect(latest.snapshot?.text).toBe("Original");
    const count = (createTranscriptEditorController as jest.Mock).mock.calls.length;
    await act(async () => { await expect(oldReload()).resolves.toMatchObject({ ok: false, code: "EDITOR_CONTEXT_INACTIVE" }); });
    expect(createTranscriptEditorController).toHaveBeenCalledTimes(count);
  });
  it("does not expose arbitrary exception text and recovers button pending state", async () => {
    const { c } = makeController(); c.flushDraft = jest.fn(async () => { throw new Error("private SQL draft content"); });
    (createTranscriptEditorController as jest.Mock).mockReturnValue(c); await mount();
    await act(async () => { await latest.flush(); });
    expect(latest.errorCode).toBe("EDITOR_LOCAL_STORAGE_FAILED"); expect(latest.action).toBeNull();
  });
  it("requests latest through the controller, never as a new Save", async () => {
    const { c } = makeController(); (createTranscriptEditorController as jest.Mock).mockReturnValue(c); await mount();
    await act(async () => { latest.requestLatest(); });
    expect(c.requestLatest).toHaveBeenCalledTimes(1); expect(c.refresh).toHaveBeenCalledTimes(1); expect(c.save).not.toHaveBeenCalled();
  });
  it("unsubscribes and invalidates on unmount without sending Save", async () => {
    const { c, listeners } = makeController(); (createTranscriptEditorController as jest.Mock).mockReturnValue(c); await mount();
    await act(async () => { tree!.unmount(); tree = null; }); await settle();
    expect(listeners.size).toBe(0); expect(c.invalidate).toHaveBeenCalledTimes(1); expect(c.save).not.toHaveBeenCalled();
  });
});
