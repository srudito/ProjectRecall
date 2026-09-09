import { openLocalReadDb } from "@/src/services/sqlite/schema";
import { __resetSerializedLocalTransactionsForTests, runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import { listLocalTranscriptHistoryPage, loadLocalTranscriptHistoryVersion, withLocalTranscriptReadSnapshot } from "@/src/services/sqlite/repository";
import { TranscriptHistoryError, type TranscriptHistoryCursor } from "@/src/services/transcription/history-types";
import { waitForLocalReadSnapshotsIdle } from "@/src/services/sqlite/read-snapshot";
import { useAuthStore } from "@/src/stores/auth-store";

jest.mock("@/src/services/sqlite/schema", () => ({ openLocalReadDb: jest.fn() }));
const openDb = openLocalReadDb as jest.MockedFunction<typeof openLocalReadDb>;
jest.mock("@/src/services/account-deletion/state", () => ({ isAccountDeletionLocallyPending: () => false }));
const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (version: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(version), workspace_id: WORKSPACE, session_id: SESSION, version,
  version_origin: "provider", version_status: "final", parent_version_id: null,
  created_by: null, transcription_run_id: null, content_checksum_sha256: null,
  created_at: "2026-09-08T00:00:00.000Z", is_current: 0,
  plain_text: `Version ${version}`, ...extra,
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

// SQL-port fixture for admission and validation, not native isolation proof.
const fixture = (initial = [row(3, { is_current: 1 }), row(2), row(1)]) => {
  const state = {
    rows: initial,
    session: { id: SESSION, workspace_id: WORKSPACE, status: "recorded", deleted_at: null as string | null } as
      { id: string; workspace_id: string; status: string; deleted_at: string | null } | null,
    deleting: false, active: true,
  };
  const assertActive = jest.fn(() => { if (!state.active) throw new TranscriptHistoryError("HISTORY_CONTEXT_INACTIVE"); });
  const db = {
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => { await task(); }),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM local_sessions")) return state.session && { ...state.session };
      if (sql.includes("FROM local_session_deletion_queue")) return state.deleting ? { id: "delete" } : null;
      if (sql.includes("FROM local_transcript_versions")) {
        const found = state.rows.find((r) => r.id === params[0] && r.workspace_id === params[1] &&
          r.session_id === params[2] && r.version_status === "final");
        return found ? { ...found } : null;
      }
      throw new Error("Unexpected query");
    }),
    getAllAsync: jest.fn(async (_sql: string, params: unknown[]) => state.rows
      .filter((r) => r.workspace_id === params[0] && r.session_id === params[1] && r.version_status === "final" &&
        (params.length === 3 || (Number(r.version) <= Number(params[2]) && Number(r.version) < Number(params[3]))))
      .sort((a, b) => Number(b.version) - Number(a.version)).slice(0, Number(params.at(-1)))
      .map((value) => { const metadata = { ...value }; delete metadata.plain_text; return metadata; })),
    runAsync: jest.fn(async () => { throw new Error("History must never write"); }),
    execAsync: jest.fn(async (sql: string) => {
      if (!sql.startsWith("PRAGMA query_only") && !["BEGIN DEFERRED TRANSACTION;", "COMMIT;", "ROLLBACK;"].includes(sql)) {
        throw new Error("History must never execute DDL or DML");
      }
    }),
    closeAsync: jest.fn(async () => undefined),
  };
  openDb.mockResolvedValue(db as never);
  const context = { scope, assertActive };
  const list = (input = {}) => listLocalTranscriptHistoryPage({ ...context, ...input });
  const detail = (version = 2) => loadLocalTranscriptHistoryVersion({ ...context, versionId: id(version) });
  return { state, db, context, list, detail };
};
beforeEach(() => {
  jest.clearAllMocks(); __resetSerializedLocalTransactionsForTests();
  useAuthStore.setState({ initialized: true, user: { id: USER } as never });
});
afterEach(async () => { await waitForLocalReadSnapshotsIdle(); });

describe("3E.1 read-only local transcript history repository", () => {
  it("pages metadata by descending version and never calls it complete cloud history", async () => {
    const { list, db } = fixture();
    const first = await list({ pageSize: 2 });
    expect(first.versions.map((v) => v.version)).toEqual([3, 2]);
    expect(first).toMatchObject({ availability: "local_cache_only", windowUpperVersion: 3,
      nextCursor: { scope, upperVersion: 3, beforeVersion: 2 } });
    expect(first.versions[0]).not.toHaveProperty("plain_text");
    expect(db.getAllAsync.mock.calls[0][0]).not.toContain("plain_text");
    expect(db.getAllAsync.mock.calls[0][0]).toContain("ORDER BY version DESC LIMIT ?");
    expect(db.getAllAsync.mock.calls[0][1]).toEqual([WORKSPACE, SESSION, 3]);
    const last = await list({ pageSize: 2, cursor: first.nextCursor });
    expect(last.versions.map((v) => v.version)).toEqual([1]);
    expect(last.nextCursor).toBeNull(); expect(last.availability).toBe("local_cache_only");
  });
  it("does not pull new versions into an already-started page window", async () => {
    const { list, state } = fixture(); const first = await list({ pageSize: 1 });
    state.rows.push(row(4)); const second = await list({ pageSize: 1, cursor: first.nextCursor });
    expect(second.versions.map((v) => v.version)).toEqual([2]);
    expect(second.windowUpperVersion).toBe(3);
    expect((await list({ pageSize: 1 })).versions[0].version).toBe(4);
  });
  it("supports gaps, nullable provenance and all final origins without guessing ancestry", async () => {
    const { list } = fixture([row(10, { version_origin: "user_edit", parent_version_id: id(9),
      content_checksum_sha256: "a".repeat(64) }), row(7, { version_origin: "import" }), row(1)]);
    const result = await list(); expect(result.versions.map((v) => v.version)).toEqual([10, 7, 1]);
    expect(result.versions[0]).toMatchObject({ created_by: null, transcription_run_id: null, parent_version_id: id(9) });
  });
  it("filters other sessions/workspaces and draft-status versions before pagination", async () => {
    const { list } = fixture([row(8, { workspace_id: OTHER }), row(7, { session_id: OTHER }),
      row(6, { version_status: "draft" }), row(2)]);
    expect((await list()).versions.map((v) => v.version)).toEqual([2]);
  });
  it("returns an explicitly local empty page rather than synthesizing a transcript", async () => {
    const { list, detail } = fixture([]); expect(await list()).toEqual({ scope,
      availability: "local_cache_only", versions: [], windowUpperVersion: null, nextCursor: null });
    expect(await detail()).toEqual({ kind: "not_cached", availability: "local_cache_only", scope, versionId: id(2) });
  });
  it("preserves a cursor window when a later page is empty after local cleanup", async () => {
    const { list, state } = fixture(); const first = await list({ pageSize: 1 }); state.rows = [];
    expect(await list({ cursor: first.nextCursor })).toMatchObject({ windowUpperVersion: 3, versions: [], nextCursor: null });
  });
  it.each([0, -1, 1.5, 101, NaN, Infinity, "2", null])("rejects invalid page size %s before opening storage", async (pageSize) => {
    const { list } = fixture(); await expect(list({ pageSize })).rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" });
    expect(openDb).not.toHaveBeenCalled();
  });
  it.each(["userId", "workspaceId", "sessionId"] as const)("rejects a cursor from another %s", async (field) => {
    const { list } = fixture(); const cursor = { scope: { ...scope, [field]: OTHER }, upperVersion: 3, beforeVersion: 2 };
    await expect(list({ cursor })).rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" }); expect(openDb).not.toHaveBeenCalled();
  });
  it.each([[0, 1], [2, 3], [3.5, 2], [3, 0], [2_147_483_648, 2]])("rejects an invalid cursor window %s/%s", async (upperVersion, beforeVersion) => {
    const { list } = fixture(); await expect(list({ cursor: { scope, upperVersion, beforeVersion } }))
      .rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" }); expect(openDb).not.toHaveBeenCalled();
  });
  it("captures cursor and scope values before awaiting the database", async () => {
    const { context, db } = fixture(); const gate = deferred(); openDb.mockImplementation(async () => { await gate.promise; return db as never; });
    const cursor: TranscriptHistoryCursor = { scope: { ...scope }, upperVersion: 3, beforeVersion: 2 };
    const pending = listLocalTranscriptHistoryPage({ ...context, cursor }); cursor.beforeVersion = 3;
    (cursor.scope as { userId: string }).userId = OTHER; gate.resolve();
    expect((await pending).versions.map((v) => v.version)).toEqual([1]);
  });
  it("reads exact historical text without promoting current or touching drafts/queues/segments", async () => {
    const text = "  Bahasa Indonesia / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00  ";
    const { state, db, detail } = fixture([row(3, { is_current: 1 }), row(2, { plain_text: text })]);
    const before = JSON.stringify(state.rows); const result = await detail();
    expect(result).toMatchObject({ kind: "ready", rawPlainText: text, version: { id: id(2), is_current: false } });
    expect(JSON.stringify(state.rows)).toBe(before); expect(db.runAsync).not.toHaveBeenCalled(); expect(db.execAsync.mock.calls.flat().join(" ")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/);
  });
  it("does not replace an empty historical provider text with timestamp or current text", async () => {
    const { detail } = fixture([row(2, { plain_text: "" })]);
    expect(await detail()).toMatchObject({ kind: "ready", rawPlainText: "" });
  });
  it("checks the observed version number as well as the selected ID", async () => {
    const { context } = fixture(); await expect(loadLocalTranscriptHistoryVersion({ ...context, versionId: id(2), expectedVersion: 7 }))
      .rejects.toMatchObject({ code: "HISTORY_CACHE_INVALID" });
  });
  it.each([0, -2, 1.2, "2", null])("rejects invalid expected version %s before SQL", async (expectedVersion) => {
    const { context } = fixture(); await expect(loadLocalTranscriptHistoryVersion({ ...context, versionId: id(2), expectedVersion } as never))
      .rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" }); expect(openDb).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs and never interpolates them into SQL", async () => {
    const { context } = fixture(); await expect(loadLocalTranscriptHistoryVersion({ ...context, versionId: "' OR 1=1 --" }))
      .rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" }); expect(openDb).not.toHaveBeenCalled();
  });
  it.each(["workspace_id", "session_id", "id", "version_status", "version_origin", "parent_version_id",
    "created_by", "transcription_run_id", "content_checksum_sha256", "created_at", "is_current", "version"])(
    "fails closed on malformed or mismatched metadata %s", async (field) => {
      const { db, list } = fixture(); db.getAllAsync.mockResolvedValueOnce([row(2, { [field]: "invalid" })]);
      await expect(list()).rejects.toMatchObject({ code: "HISTORY_CACHE_INVALID" });
    });
  it("rejects self-parent and an invalid user-edit shape", async () => {
    const { db, list } = fixture(); db.getAllAsync.mockResolvedValueOnce([row(2, { parent_version_id: id(2) })]);
    await expect(list()).rejects.toMatchObject({ code: "HISTORY_CACHE_INVALID" });
    db.getAllAsync.mockResolvedValueOnce([row(2, { version_origin: "user_edit" })]);
    await expect(list()).rejects.toMatchObject({ code: "HISTORY_CACHE_INVALID" });
  });
  it.each(["order", "duplicate_id", "duplicate_version", "current", "lookahead", "over_limit"])("rejects invalid page %s", async (kind) => {
    const { db, list } = fixture();
    const pages: Record<string, Record<string, unknown>[]> = {
      order: [row(1), row(2)], duplicate_id: [row(3), row(2, { id: id(3) })],
      duplicate_version: [row(2), row(2, { id: id(9) })], current: [row(3, { is_current: 1 }), row(2, { is_current: 1 })],
      lookahead: [row(3), row(2), row(1, { created_at: "invalid" })], over_limit: [row(4), row(3), row(2), row(1)],
    };
    db.getAllAsync.mockResolvedValueOnce(pages[kind]);
    await expect(list({ pageSize: 2 })).rejects.toMatchObject({ code: "HISTORY_CACHE_INVALID" });
  });
  it("rejects out-of-window rows even if a database adapter ignores the cursor", async () => {
    const { db, list } = fixture(); db.getAllAsync.mockResolvedValueOnce([row(3)]);
    await expect(list({ cursor: { scope, upperVersion: 3, beforeVersion: 2 } })).rejects.toMatchObject({ code: "HISTORY_CACHE_INVALID" });
  });
  it("rejects a detail response for a different ID and malformed text", async () => {
    const { db, detail } = fixture(); const original = db.getFirstAsync;
    const replacement = jest.fn(async (sql: string, params: unknown[]) => sql.includes("FROM local_transcript_versions")
      ? row(9) : original(sql, params));
    db.getFirstAsync = replacement; await expect(detail()).rejects.toMatchObject({ code: "HISTORY_CACHE_INVALID" });
    db.getFirstAsync = jest.fn(async (sql: string, params: unknown[]) => sql.includes("FROM local_transcript_versions")
      ? row(2, { plain_text: null }) : original(sql, params));
    await expect(detail()).rejects.toMatchObject({ code: "HISTORY_CACHE_INVALID" });
  });
  it.each(["missing", "deleted_at", "deleting", "deleted", "queue", "wrong_scope"])("rejects unavailable session: %s", async (kind) => {
    const { state, list, db } = fixture();
    if (kind === "missing") state.session = null;
    else if (kind === "deleted_at") state.session!.deleted_at = "2026-09-08T00:00:00Z";
    else if (kind === "queue") state.deleting = true;
    else if (kind === "wrong_scope") state.session!.workspace_id = OTHER;
    else state.session!.status = kind;
    await expect(list()).rejects.toMatchObject({ code: "HISTORY_SESSION_UNAVAILABLE" }); expect(db.getAllAsync).not.toHaveBeenCalled();
  });
  it("fails explicitly when SQLite is unavailable, rather than returning an empty list", async () => {
    const { list } = fixture(); openDb.mockResolvedValue(null);
    await expect(list()).rejects.toMatchObject({ code: "HISTORY_LOCAL_STORAGE_UNAVAILABLE" });
  });
  it("sanitizes storage failures without attaching text or raw cause", async () => {
    const { db, list } = fixture(); db.getAllAsync.mockRejectedValue(new Error("PRIVATE SQL/TEXT"));
    await expect(list()).rejects.toMatchObject({ code: "HISTORY_LOCAL_READ_FAILED" });
    try { await list(); } catch (error) {
      expect(String(error)).not.toContain("PRIVATE"); expect(error).not.toHaveProperty("cause");
    }
  });
  it("checks context after a delayed open and before executing any queries", async () => {
    const { db, state, list } = fixture(); const gate = deferred(); openDb.mockImplementation(async () => { await gate.promise; return db as never; });
    const pending = expect(list()).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" });
    state.active = false; gate.resolve(); await pending; expect(db.getFirstAsync).not.toHaveBeenCalled();
  });
  it("does not wait behind a shared writer transaction or join its connection", async () => {
    const { list, db } = fixture(); const entered = deferred(); const gate = deferred();
    const writer = { withTransactionAsync: jest.fn(async (task: () => Promise<void>) => { await task(); }) };
    const prior = runSerializedLocalTransaction(writer, async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    try { expect((await list()).versions).toHaveLength(3); expect(db.withTransactionAsync).not.toHaveBeenCalled(); }
    finally { gate.resolve(); await prior; }
  });
  it("checks context after the SQL read and after transaction completion", async () => {
    const { db, state, list } = fixture();
    db.execAsync.mockImplementation(async (sql) => { if (sql === "COMMIT;") state.active = false; });
    await expect(list()).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" }); expect(db.getAllAsync).toHaveBeenCalledTimes(1);
  });
  it("does not change any version or issue a write during page reads", async () => {
    const { db, state, list } = fixture(); const before = JSON.stringify(state.rows); await list();
    expect(JSON.stringify(state.rows)).toBe(before); expect(db.runAsync).not.toHaveBeenCalled(); expect(db.execAsync.mock.calls.flat().join(" ")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/);
  });
});

describe("3E.2B2A snapshot-bound transcript getters", () => {
  it("uses one owned handle for current, exact parent and segments", async () => {
    const f = fixture();
    const original = f.db.getFirstAsync;
    f.db.getFirstAsync = jest.fn(async (sql: string, params: unknown[]) => {
      if (!sql.includes("FROM local_transcript_versions")) return original(sql, params);
      return row(params.length === 2 ? 3 : 2, { is_current: params.length === 2 ? 1 : 0, language_summary: "{}" });
    });
    f.db.getAllAsync.mockResolvedValueOnce([]);
    await withLocalTranscriptReadSnapshot(SESSION, async (reads) => {
      expect((await reads.getCurrentVersion(SESSION))?.is_current).toBe(true);
      expect((await reads.getVersionById({ versionId: id(2), sessionId: SESSION, workspaceId: WORKSPACE }))?.is_current).toBe(false);
      expect(await reads.listSegments(id(2))).toEqual([]);
    });
    expect(openDb).toHaveBeenCalledTimes(1); expect(f.db.closeAsync).toHaveBeenCalledTimes(1);
    expect(f.db.execAsync.mock.calls.filter(([sql]) => sql.startsWith("BEGIN"))).toHaveLength(1);
    expect(f.db.getAllAsync).toHaveBeenCalledWith(expect.stringContaining("workspace_id = ? AND session_id = ?"), [id(2), WORKSPACE, SESSION]);
  });
  it("rejects another session/workspace at the snapshot-bound getter boundary", async () => {
    fixture();
    await expect(withLocalTranscriptReadSnapshot(SESSION, async (reads) => reads.getCurrentVersion(OTHER)))
      .rejects.toMatchObject({ code: "LOCAL_READ_INPUT_INVALID" });
    await expect(withLocalTranscriptReadSnapshot(SESSION, async (reads) => reads.getVersionById({ versionId: id(2), sessionId: OTHER, workspaceId: WORKSPACE })))
      .rejects.toMatchObject({ code: "LOCAL_READ_INPUT_INVALID" });
  });
  it("does not expose a deleted session through the current/evidence entrypoint", async () => {
    const f = fixture(); f.state.deleting = true;
    await expect(withLocalTranscriptReadSnapshot(SESSION, async () => "private"))
      .rejects.toMatchObject({ code: "LOCAL_READ_CONTEXT_INACTIVE" });
  });
  it("does not issue DML, shared-db transactions or retain the handle after success", async () => {
    const f = fixture(); await f.list();
    expect(f.db.withTransactionAsync).not.toHaveBeenCalled(); expect(f.db.runAsync).not.toHaveBeenCalled();
    expect(f.db.closeAsync).toHaveBeenCalledTimes(1);
  });
});
