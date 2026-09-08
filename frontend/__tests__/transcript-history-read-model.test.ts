import { createLocalTranscriptHistoryReader } from "@/src/services/transcription/history-read-model";
import { listLocalTranscriptHistoryPage, loadLocalTranscriptHistoryVersion } from "@/src/services/sqlite/repository";
import {
  normalizeTranscriptHistoryScope, TranscriptHistoryError,
  type LocalTranscriptHistoryPage, type LocalTranscriptHistoryVersion, type TranscriptHistoryCursor,
} from "@/src/services/transcription/history-types";

jest.mock("@/src/services/sqlite/repository", () => ({
  listLocalTranscriptHistoryPage: jest.fn(), loadLocalTranscriptHistoryVersion: jest.fn(),
}));
jest.mock("@/src/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ initialized: false, user: null }), subscribe: jest.fn(() => () => {}) },
}));
jest.mock("@/src/services/account-deletion/state", () => ({ isAccountDeletionLocallyPending: () => false }));
const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const ID = "44444444-4444-4444-8444-444444444444";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const version = {
  id: ID, workspace_id: WORKSPACE, session_id: SESSION, version: 4, version_origin: "provider" as const,
  version_status: "final" as const, parent_version_id: null, created_by: null, transcription_run_id: null,
  content_checksum_sha256: null, created_at: "2026-09-08T00:00:00.000Z", is_current: false,
};
const page = (): LocalTranscriptHistoryPage => ({ scope: { ...scope }, availability: "local_cache_only",
  versions: [{ ...version }], windowUpperVersion: 4,
  nextCursor: { scope: { ...scope }, upperVersion: 4, beforeVersion: 4 } });
const detail = (): LocalTranscriptHistoryVersion => ({ kind: "ready", scope: { ...scope },
  availability: "local_cache_only", version: { ...version }, rawPlainText: "  Bahasa / English\n\u6f22\u5b57 \ud83d\ude00  " });
const listPort = listLocalTranscriptHistoryPage as jest.MockedFunction<typeof listLocalTranscriptHistoryPage>;
const detailPort = loadLocalTranscriptHistoryVersion as jest.MockedFunction<typeof loadLocalTranscriptHistoryVersion>;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const readers: ReturnType<typeof createLocalTranscriptHistoryReader>[] = [];
const setup = () => {
  const state = { userId: USER as string | null, initialized: true, active: true, deleting: false };
  const listeners = new Set<() => void>();
  const unsubscribe = jest.fn();
  const create = (platform = "android") => {
    const reader = createLocalTranscriptHistoryReader(scope, {
      platform, getAuth: () => ({ initialized: state.initialized, userId: state.userId }),
      subscribeAuth: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); unsubscribe(); }; },
      isContextActive: () => state.active, isDeletionPending: () => state.deleting,
    });
    readers.push(reader); return reader;
  };
  return { state, create, listeners, unsubscribe, authChanged: () => { for (const listener of [...listeners]) listener(); } };
};
beforeEach(() => { jest.clearAllMocks(); listPort.mockResolvedValue(page()); detailPort.mockResolvedValue(detail()); });
afterEach(() => { for (const reader of readers.splice(0)) reader.dispose(); });

describe("3E.1 scoped local history reader", () => {
  it("constructs a reader without starting database reads", () => {
    const { create } = setup(); create(); expect(listPort).not.toHaveBeenCalled(); expect(detailPort).not.toHaveBeenCalled();
  });
  it.each(["android", "ios"])("loads local pages and selected versions on %s without a connectivity dependency", async (platform) => {
    const reader = setup().create(platform);
    expect((await reader.listPage()).availability).toBe("local_cache_only");
    expect(listPort).toHaveBeenCalledWith(expect.objectContaining({ scope, pageSize: 25, cursor: null }));
    expect(await reader.loadVersion({ versionId: ID })).toMatchObject({ kind: "ready", version: { is_current: false } });
  });
  it.each(["web", "windows", "macos"])("refuses unsupported platform %s without pretending the cache is empty", (platform) => {
    expect(() => setup().create(platform)).toThrow(expect.objectContaining({ code: "HISTORY_NATIVE_ONLY" }));
    expect(listPort).not.toHaveBeenCalled();
  });
  it("requires restored matching auth before registering the reader", () => {
    const { state, create, listeners } = setup(); state.initialized = false;
    expect(create).toThrow(expect.objectContaining({ code: "HISTORY_AUTH_REQUIRED" })); expect(listeners.size).toBe(0);
    state.initialized = true; state.userId = OTHER;
    expect(create).toThrow(expect.objectContaining({ code: "HISTORY_AUTH_REQUIRED" }));
  });
  it("requires a valid UUID scope and normalizes input UUID case", () => {
    expect(() => normalizeTranscriptHistoryScope({ ...scope, sessionId: "invalid" })).toThrow(TranscriptHistoryError);
    expect(normalizeTranscriptHistoryScope({ ...scope, userId: OTHER.toUpperCase() }).userId).toBe(OTHER);
  });
  it("preserves exact text and distinguishes not-cached from empty text", async () => {
    const reader = setup().create(); const result = await reader.loadVersion({ versionId: ID });
    expect(result).toMatchObject({ rawPlainText: "  Bahasa / English\n\u6f22\u5b57 \ud83d\ude00  " });
    detailPort.mockResolvedValueOnce({ ...detail(), kind: "ready", scope, availability: "local_cache_only", version, rawPlainText: "" });
    expect(await reader.loadVersion({ versionId: ID })).toMatchObject({ kind: "ready", rawPlainText: "" });
    detailPort.mockResolvedValueOnce({ kind: "not_cached", scope, availability: "local_cache_only", versionId: ID });
    expect(await reader.loadVersion({ versionId: ID })).toEqual({ kind: "not_cached", scope, availability: "local_cache_only", versionId: ID });
  });
  it("captures the caller's cursor and detail selection instead of following later mutation", async () => {
    const reader = setup().create(); const gate = deferred<LocalTranscriptHistoryPage>(); listPort.mockReturnValueOnce(gate.promise);
    const cursor: TranscriptHistoryCursor = { scope: { ...scope }, upperVersion: 4, beforeVersion: 3 };
    const pending = reader.listPage({ cursor }); cursor.beforeVersion = 1;
    (cursor.scope as { sessionId: string }).sessionId = OTHER;
    expect(listPort.mock.calls[0][0].cursor).toEqual({ scope, upperVersion: 4, beforeVersion: 3 });
    gate.resolve(page()); await pending;
    const input = { versionId: ID, expectedVersion: 4 }; const selected = reader.loadVersion(input); input.versionId = OTHER;
    expect(detailPort.mock.calls[0][0].versionId).toBe(ID); await selected;
  });
  it("returns detached metadata, scope and cursor objects", async () => {
    const original = page(); listPort.mockResolvedValueOnce(original); const reader = setup().create();
    const got = await reader.listPage(); got.versions[0].created_by = OTHER;
    got.nextCursor!.beforeVersion = 1; (got.scope as { userId: string }).userId = OTHER;
    expect(original.versions[0].created_by).toBeNull(); expect(original.nextCursor!.beforeVersion).toBe(4); expect(original.scope.userId).toBe(USER);
  });
  it("suppresses data returned after the reader is disposed", async () => {
    const reader = setup().create(); const gate = deferred<LocalTranscriptHistoryVersion>(); detailPort.mockReturnValueOnce(gate.promise);
    const pending = expect(reader.loadVersion({ versionId: ID })).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" });
    reader.dispose(); gate.resolve(detail()); await pending;
  });
  it("makes disposal idempotent and removes the auth subscription", async () => {
    const { create, listeners, unsubscribe } = setup(); const reader = create(); expect(listeners.size).toBe(1);
    reader.dispose(); reader.dispose(); expect(unsubscribe).toHaveBeenCalledTimes(1); expect(listeners.size).toBe(0);
    await expect(reader.listPage()).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" }); expect(listPort).not.toHaveBeenCalled();
  });
  it("does not revive old requests after account A -> B -> A", async () => {
    const { create, state, authChanged } = setup(); const reader = create();
    const gate = deferred<LocalTranscriptHistoryPage>(); listPort.mockReturnValueOnce(gate.promise);
    const pending = expect(reader.listPage()).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" });
    state.userId = OTHER; authChanged(); state.userId = USER; authChanged(); gate.resolve(page()); await pending;
    await expect(reader.listPage()).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" });
    expect((await create().listPage()).versions).toHaveLength(1);
  });
  it("keeps the same reader alive on same-user token refresh", async () => {
    const { create, authChanged, unsubscribe } = setup(); const reader = create(); authChanged();
    await reader.listPage(); expect(unsubscribe).not.toHaveBeenCalled();
  });
  it("rejects sign-out even if no auth event was delivered yet", async () => {
    const { create, state } = setup(); const reader = create(); state.userId = null;
    await expect(reader.listPage()).rejects.toMatchObject({ code: "HISTORY_AUTH_REQUIRED" }); expect(listPort).not.toHaveBeenCalled();
  });
  it("rechecks deletion after an in-flight read and never returns the late data", async () => {
    const { create, state } = setup(); const reader = create(); const gate = deferred<LocalTranscriptHistoryVersion>();
    detailPort.mockReturnValueOnce(gate.promise);
    const pending = expect(reader.loadVersion({ versionId: ID })).rejects.toMatchObject({ code: "HISTORY_DELETION_PENDING" });
    state.deleting = true; gate.resolve(detail()); await pending;
  });
  it("supersedes only the old page request, not independent detail reads", async () => {
    const reader = setup().create(); const gate = deferred<LocalTranscriptHistoryPage>(); listPort.mockReturnValueOnce(gate.promise);
    const pending = expect(reader.listPage()).rejects.toMatchObject({ code: "HISTORY_REQUEST_SUPERSEDED" });
    const later = await reader.listPage(); const selected = await reader.loadVersion({ versionId: ID });
    gate.resolve(page()); await pending; expect(later.versions).toHaveLength(1); expect(selected.kind).toBe("ready");
  });
  it("rejects a late version selection and invalidates its SQL guard immediately", async () => {
    const reader = setup().create(); const gate = deferred<LocalTranscriptHistoryVersion>(); detailPort.mockReturnValueOnce(gate.promise);
    const pending = expect(reader.loadVersion({ versionId: ID })).rejects.toMatchObject({ code: "HISTORY_REQUEST_SUPERSEDED" });
    const oldGuard = detailPort.mock.calls[0][0].assertActive;
    await reader.loadVersion({ versionId: OTHER }); expect(oldGuard).toThrow(expect.objectContaining({ code: "HISTORY_REQUEST_SUPERSEDED" }));
    gate.resolve(detail()); await pending;
  });
  it("checks the view context inside the repository callback and at delivery", async () => {
    const { create, state } = setup(); const reader = create(); const gate = deferred<LocalTranscriptHistoryPage>();
    listPort.mockReturnValueOnce(gate.promise);
    const pending = expect(reader.listPage()).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" });
    state.active = false; expect(listPort.mock.calls[0][0].assertActive).toThrow(TranscriptHistoryError);
    gate.resolve(page()); await pending;
  });
  it("validates input before admitting a request and retains stable error codes", async () => {
    const reader = setup().create(); await expect(reader.listPage({ pageSize: -1 })).rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" });
    await expect(reader.loadVersion({ versionId: "bad" })).rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" });
    expect(listPort).not.toHaveBeenCalled(); expect(detailPort).not.toHaveBeenCalled();
    listPort.mockRejectedValueOnce(new TranscriptHistoryError("HISTORY_SESSION_UNAVAILABLE"));
    await expect(reader.listPage()).rejects.toMatchObject({ code: "HISTORY_SESSION_UNAVAILABLE" });
  });
  it("does not expose private raw errors or transcript payloads in failures", async () => {
    const reader = setup().create(); listPort.mockRejectedValue(new Error("PRIVATE SQL AND TRANSCRIPT"));
    try { await reader.listPage(); throw new Error("Expected read failure"); } catch (error) {
      expect(error).toMatchObject({ code: "HISTORY_LOCAL_READ_FAILED" }); expect(String(error)).not.toContain("PRIVATE");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
