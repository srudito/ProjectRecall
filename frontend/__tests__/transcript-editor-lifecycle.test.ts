import {
  bindTranscriptEditorLifecycle,
  createTranscriptEditorRegistry,
} from "@/src/services/transcription/editor-lifecycle";
import type {
  TranscriptEditorLifecycleDependencies,
} from "@/src/services/transcription/editor-lifecycle";
import type { TranscriptEditorParticipant } from "@/src/services/transcription/editor-types";

jest.mock("@/src/services/account-deletion/state", () => ({ isAccountDeletionLocallyPending: () => false }));
jest.mock("@/src/stores/auth-store", () => ({ useAuthStore: { getState: () => ({ initialized: false, user: null }) } }));

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const scope = { userId: USER, workspaceId: OTHER, sessionId: "33333333-3333-4333-8333-333333333333" };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const participant = (): TranscriptEditorParticipant => ({
  scope: { ...scope }, invalidate: jest.fn(), waitForIdle: jest.fn(async () => undefined),
  setForeground: jest.fn(), refresh: jest.fn(async () => undefined),
});

describe("3D.2B2 editor ownership and drain", () => {
  it("admits one writer per scope and separates different sessions", () => {
    const registry = createTranscriptEditorRegistry(); const a = participant(); registry.register(a);
    expect(() => registry.register(participant())).toThrow("already has an active editor");
    expect(() => registry.register({ ...participant(), scope: { ...scope, sessionId: OTHER } })).not.toThrow();
  });
  it("keeps a released owner registered until its actual pending work drains", async () => {
    const registry = createTranscriptEditorRegistry(); const a = participant(); const blocked = deferred();
    a.waitForIdle = jest.fn(() => blocked.promise);
    const lease = registry.register(a); lease.release(); expect(lease.isActive()).toBe(false);
    expect(() => registry.register(participant())).toThrow();
    let idle = false; const drain = registry.waitForIdle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle).toBe(false); blocked.resolve(); await drain;
    await Promise.resolve(); expect(() => registry.register(participant())).not.toThrow();
  });
  it("an old lease release never removes or disables its replacement", async () => {
    const registry = createTranscriptEditorRegistry(); const first = registry.register(participant());
    first.release(); await registry.waitForIdle(); await Promise.resolve();
    const second = registry.register(participant()); first.release(); expect(second.isActive()).toBe(true);
  });
  it("closes admission before invalidation and never revives retired controllers", () => {
    const registry = createTranscriptEditorRegistry(); const p = participant(); const lease = registry.register(p);
    p.invalidate = jest.fn(() => { expect(lease.isActive()).toBe(false); lease.release(); });
    registry.invalidateAll(); expect(p.invalidate).toHaveBeenCalledTimes(1);
    expect(() => registry.register({ ...participant(), scope: { ...scope, sessionId: OTHER } })).toThrow();
    registry.setAdmission(true); expect(lease.isActive()).toBe(false);
  });
  it("keeps an owner fail-closed when its drain rejects", async () => {
    const registry = createTranscriptEditorRegistry(); const p = participant(); p.waitForIdle = jest.fn(async () => { throw new Error("drain"); });
    const lease = registry.register(p); lease.release();
    await expect(registry.waitForIdle()).rejects.toThrow("drain");
    await Promise.resolve(); expect(() => registry.register(participant())).toThrow();
  });
  it("rechecks the current account/deletion guard for an existing lease", () => {
    let allowed = true; const registry = createTranscriptEditorRegistry(() => allowed);
    const lease = registry.register(participant()); expect(lease.isActive()).toBe(true);
    allowed = false; expect(lease.isActive()).toBe(false);
    expect(() => registry.register({ ...participant(), scope: { ...scope, sessionId: OTHER } })).toThrow();
  });
  it("forwards background to local flush without invalidating a live owner", () => {
    const registry = createTranscriptEditorRegistry(); const p = participant(); const lease = registry.register(p);
    registry.setForeground(false); expect(p.setForeground).toHaveBeenCalledWith(false);
    expect(lease.isActive()).toBe(true); expect(p.invalidate).not.toHaveBeenCalled();
  });
});

const setup = () => {
  let auth = { initialized: true, userId: USER as string | null };
  let deletion = false;
  const authCallbacks: (() => void)[] = [];
  const appCallbacks: ((active: boolean) => void)[] = [];
  const transcriptCallbacks: (() => void)[] = [];
  const metadataCallbacks: (() => void)[] = [];
  const registry = createTranscriptEditorRegistry();
  const remove = [jest.fn(), jest.fn(), jest.fn(), jest.fn()];
  const deps: TranscriptEditorLifecycleDependencies = {
    platform: "android", getAuth: () => auth, isDeletionPending: () => deletion, isForeground: () => true, registry,
    subscribeAuth: jest.fn((callback) => { authCallbacks.push(callback); return remove[0]; }),
    subscribeForeground: jest.fn((callback) => { appCallbacks.push(callback); return remove[1]; }),
    subscribeTranscript: jest.fn((callback) => { transcriptCallbacks.push(callback); return remove[2]; }),
    subscribeMetadata: jest.fn((callback) => { metadataCallbacks.push(callback); return remove[3]; }),
  };
  return { deps, registry, remove,
    auth: (userId: string | null, initialized = true) => { auth = { userId, initialized }; authCallbacks.forEach((callback) => callback()); },
    deletion: () => { deletion = true; },
    app: (active: boolean) => appCallbacks.forEach((callback) => callback(active)),
    transcript: () => transcriptCallbacks.forEach((callback) => callback()),
    metadata: () => metadataCallbacks.forEach((callback) => callback()),
  };
};

describe("3D.2B2 headless lifecycle binding", () => {
  it("has no connectivity prerequisite for local editing", () => {
    const s = setup(); const stop = bindTranscriptEditorLifecycle(s.deps);
    const p = participant(); const lease = s.registry.register(p); expect(lease.isActive()).toBe(true);
    expect(s.deps).not.toHaveProperty("subscribeConnection"); stop();
  });
  it("does not attach subscriptions on unsupported platforms", () => {
    const s = setup(); const stop = bindTranscriptEditorLifecycle({ ...s.deps, platform: "web" }); stop();
    expect(s.deps.subscribeAuth).not.toHaveBeenCalled(); expect(s.deps.subscribeForeground).not.toHaveBeenCalled();
  });
  it("invalidates synchronously for A -> B -> A without resurrecting A", () => {
    const s = setup(); const stop = bindTranscriptEditorLifecycle(s.deps);
    const p = participant(); const lease = s.registry.register(p);
    s.auth(OTHER); s.auth(USER); expect(lease.isActive()).toBe(false); expect(p.invalidate).toHaveBeenCalled(); stop();
  });
  it("same-user token refresh preserves controller lifetime and draft", () => {
    const s = setup(); const stop = bindTranscriptEditorLifecycle(s.deps);
    const p = participant(); const lease = s.registry.register(p); s.auth(USER);
    expect(lease.isActive()).toBe(true); expect(p.invalidate).not.toHaveBeenCalled(); stop();
  });
  it.each(["signed_out", "uninitialized", "deletion"])("closes local admission for %s", (condition) => {
    const s = setup(); const stop = bindTranscriptEditorLifecycle(s.deps);
    const p = participant(); const lease = s.registry.register(p);
    if (condition === "deletion") { s.deletion(); s.metadata(); }
    else s.auth(condition === "signed_out" ? null : USER, condition !== "uninitialized");
    expect(lease.isActive()).toBe(false); expect(p.invalidate).toHaveBeenCalled(); stop();
  });
  it("observes both metadata and transcript events without writing drafts", async () => {
    const s = setup(); const stop = bindTranscriptEditorLifecycle(s.deps); const p = participant(); s.registry.register(p);
    s.metadata(); s.transcript(); expect(p.refresh).toHaveBeenCalledTimes(2);
    expect(p.invalidate).not.toHaveBeenCalled(); stop(); await s.registry.waitForIdle();
  });
  it("background keeps context alive; foreground requests a local refresh", () => {
    const s = setup(); const stop = bindTranscriptEditorLifecycle(s.deps); const p = participant(); const lease = s.registry.register(p);
    s.app(false); expect(lease.isActive()).toBe(true); expect(p.setForeground).toHaveBeenLastCalledWith(false);
    s.app(true); expect(p.refresh).toHaveBeenCalledTimes(1); stop();
  });
  it("ignores queued subscription callbacks after stop and detaches only once", () => {
    const s = setup(); const stop = bindTranscriptEditorLifecycle(s.deps); const p = participant(); s.registry.register(p);
    stop(); const calls = (p.invalidate as jest.Mock).mock.calls.length;
    stop(); s.auth(USER); s.app(true); s.metadata(); s.transcript();
    expect((p.invalidate as jest.Mock).mock.calls).toHaveLength(calls); expect(p.refresh).not.toHaveBeenCalled();
    s.remove.forEach((remove) => expect(remove).toHaveBeenCalledTimes(1));
  });
});
