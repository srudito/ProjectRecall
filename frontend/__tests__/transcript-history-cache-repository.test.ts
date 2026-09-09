import { createHash } from "node:crypto";
import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";

import { createHistoryCacheWriter, type HistoryCacheDatabase } from "@/src/services/sqlite/history-cache";
import { openLocalDb, openLocalHistoryWriteDb, __resetOpenLocalDbForTests } from "@/src/services/sqlite/schema";
import { runMigrations } from "@/src/services/sqlite/migrations";
import { __resetSerializedLocalTransactionsForTests } from "@/src/services/sqlite/transaction";
import { prepareHistoryCacheCommand, historyCacheError } from "@/src/services/transcription/history-cache-types";
import { HISTORY_BUNDLE_SOURCE, type TranscriptHistoryBundleResult } from "@/src/services/transcription/history-bundle-types";
import type { TranscriptHistoryCloudVersion } from "@/src/services/transcription/history-cloud-types";
import type { SyncedTranscriptSegment } from "@/src/services/transcription/result-types";

jest.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: jest.fn() }));
jest.mock("@/src/services/sqlite/migrations", () => ({ LATEST_LOCAL_SCHEMA_VERSION: 11, runMigrations: jest.fn(async () => undefined) }));
const digest = Crypto.digestStringAsync as jest.MockedFunction<typeof Crypto.digestStringAsync>;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ARTIFACT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-09-09T10:00:00.123456Z";
const LATER = "2026-09-09T10:00:01.123456Z";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const version = (n: number): TranscriptHistoryCloudVersion => ({
  id: id(n), workspace_id: WORKSPACE, session_id: SESSION, version: n,
  version_origin: n === 1 ? "provider" : "user_edit", version_status: "final",
  parent_version_id: n === 1 ? null : id(n - 1), transcription_run_id: id(500), created_by: USER,
  plain_text: `  Bahasa / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00 ${n}  `,
  content_checksum_sha256: hash(`  Bahasa / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00 ${n}  `),
  language_summary: { primaryLanguage: null, detectedLanguages: ["en", "id"] },
  is_current: n === 2, created_at: NOW, updated_at: NOW,
});
const segment = (n: number): SyncedTranscriptSegment => ({
  id: id(1000 + n), workspace_id: WORKSPACE, session_id: SESSION, transcript_version_id: id(1),
  segment_index: n, start_ms: n * 10, end_ms: n * 10 + 8, text: ` word ${n} `,
  language_code: "en", speaker_label: null, confidence: 0.8,
  provider_segment_id: `${ARTIFACT}:word:${n}`, created_at: NOW, updated_at: NOW,
});
const ready = (): Extract<TranscriptHistoryBundleResult, { kind: "ready" }> => ({
  kind: "ready", source: HISTORY_BUNDLE_SOURCE, scope: { ...scope }, selectedVersionId: id(2),
  bundle: { completeness: "managed_provider_bundle", versions: [version(2), version(1)],
    segments: [segment(0), segment(1)], provider: { versionId: id(1), runId: id(500), jobId: id(501),
      recordingId: id(502), cleanupCompletedAt: LATER, expectedSegmentCount: 2 } },
});
const localVersion = (value = version(1)): Record<string, unknown> => ({ ...value,
  language_summary: JSON.stringify(value.language_summary), is_current: value.is_current ? 1 : 0 });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
// SQL-port fixture for the production planner/transaction/outcome code, not native SQLite proof.
const fixture = () => {
  let stored = { versions: [] as Record<string, unknown>[], segments: [] as Record<string, unknown>[],
    session: { id: SESSION, workspace_id: WORKSPACE, status: "recorded", deleted_at: null as string | null } as Record<string, unknown> | null,
    deleting: false, outstanding: false };
  let transaction: typeof stored | null = null;
  const state = () => transaction ?? stored;
  const control = { insertCount: 0, failInsertAt: -1, failClose: false, failFinalize: false, failRollback: false,
    commitError: null as "before" | "after" | null, onCommit: null as (() => Promise<void>) | null,
    onWrite: null as (() => Promise<void>) | null, onClose: null as (() => Promise<void>) | null };
  const statements: { finalizeAsync: jest.Mock }[] = [];
  const db = {
    execAsync: jest.fn(async (sql: string): Promise<void> => {
      if (sql.startsWith("PRAGMA")) return;
      if (sql === "BEGIN IMMEDIATE;") { if (transaction) throw new Error("database is locked"); transaction = clone(stored); return; }
      if (sql === "ROLLBACK;") {
        if (control.failRollback) throw new Error("PRIVATE ROLLBACK"); transaction = null; return;
      }
      if (sql === "COMMIT;") {
        await control.onCommit?.();
        if (control.commitError === "before") throw new Error("PRIVATE COMMIT");
        stored = transaction!; transaction = null;
        if (control.commitError === "after") throw new Error("PRIVATE COMMIT ACK");
        return;
      }
      throw new Error("Unexpected transaction SQL");
    }),
    getFirstAsync: jest.fn(async (sql: string, _params: SQLite.SQLiteBindValue[]): Promise<unknown> => {
      if (sql.startsWith("SELECT request_row.id")) return state().outstanding ? { id: "request" } : null;
      if (sql.includes("FROM local_sessions")) return clone(state().session);
      if (sql.includes("FROM local_session_deletion_queue")) return state().deleting ? { id: "delete" } : null;
      if (/FROM local_(recordings|processing_jobs|transcription_runs)/.test(sql)) return null;
      throw new Error("Unexpected first SQL");
    }),
    getAllAsync: jest.fn(async (sql: string, params: SQLite.SQLiteBindValue[]): Promise<unknown[]> => {
      if (sql.includes("FROM local_transcript_versions")) return clone(state().versions.filter((v) =>
        v.id === params[0] || (v.session_id === params[1] && v.version === params[2])));
      if (sql.includes("WHERE id IN")) return clone(state().segments.filter((s) => params.includes(s.id as string)).map((s) => ({ id: s.id })));
      if (sql.includes("FROM local_transcript_segments")) return clone(state().segments.filter((s) => s.transcript_version_id === params[0]));
      throw new Error("Unexpected all SQL");
    }),
    prepareAsync: jest.fn(async (sql: string) => {
      const statement = {
        executeAsync: jest.fn(async (params: SQLite.SQLiteBindValue[]) => {
          await control.onWrite?.(); control.insertCount += 1;
          if (control.insertCount === control.failInsertAt) throw new Error("PRIVATE INSERT FAILURE");
          if (sql.startsWith("INSERT INTO")) {
            const columns = sql.slice(sql.indexOf("(") + 1, sql.indexOf(") VALUES")).split(",").map((c) => c.trim());
            const row = Object.fromEntries(columns.map((key, i) => [key, params[i]]));
            const target = sql.includes("local_transcript_versions") ? state().versions : state().segments;
            if (target.some((r) => r.id === row.id)) throw new Error("UNIQUE constraint failed");
            target.push(row);
          } else if (sql.startsWith("UPDATE local_transcript_versions")) {
            const row = state().versions.find((r) => r.id === params[3] && r.workspace_id === params[4] && r.session_id === params[5]);
            if (!row) return { changes: 0 };
            row.created_by = params[0]; row.transcription_run_id = params[1]; row.updated_at = params[2];
          } else throw new Error("Forbidden write");
          return { changes: 1 };
        }),
        finalizeAsync: jest.fn(async () => { if (control.failFinalize) throw new Error("PRIVATE FINALIZE FAILURE"); }),
      };
      statements.push(statement); return statement;
    }),
    closeAsync: jest.fn(async () => {
      await control.onClose?.(); if (control.failClose) throw new Error("PRIVATE CLOSE FAILURE"); transaction = null;
    }),
  };
  const open = jest.fn(async (): Promise<HistoryCacheDatabase | null> => db as unknown as HistoryCacheDatabase);
  const writer = createHistoryCacheWriter({ open });
  const persist = async (input = ready(), guard: () => void = () => {}) => writer.persist(await prepareHistoryCacheCommand(input, guard));
  return { db, open, writer, persist, state: () => stored, control, statements };
};
beforeEach(() => {
  jest.clearAllMocks(); __resetSerializedLocalTransactionsForTests(); __resetOpenLocalDbForTests();
  digest.mockReset(); digest.mockImplementation(async (_algorithm, value) => hash(value));
});

describe("guarded history persistence repository", () => {
  it("inserts one complete bundle atomically, as non-current, then finalizes before commit and closes", async () => {
    const f = fixture(); const outcome = await f.persist();
    expect(outcome).toMatchObject({ kind: "committed", resources: "released", insertedVersions: 2, insertedSegments: 2 });
    expect(f.state().versions.map((v) => [v.id, v.is_current])).toEqual([[id(1), 0], [id(2), 0]]);
    expect(f.state().segments.map((s) => s.text)).toEqual([segment(0).text, segment(1).text]);
    expect(f.db.execAsync.mock.calls.map(([sql]) => sql).slice(1)).toEqual(["BEGIN IMMEDIATE;", "COMMIT;"]);
    const commitOrder = f.db.execAsync.mock.invocationCallOrder[2];
    for (const statement of f.statements) expect(statement.finalizeAsync.mock.invocationCallOrder[0]).toBeLessThan(commitOrder);
    expect(f.db.closeAsync).toHaveBeenCalledTimes(1);
  });
  it("replays without any prepared write, preserving local current and timestamps", async () => {
    const f = fixture(); await f.persist(); f.state().versions[0].is_current = 1;
    const before = clone(f.state()); f.db.prepareAsync.mockClear();
    expect(await f.persist()).toMatchObject({ kind: "unchanged", insertedVersions: 0, insertedSegments: 0 });
    expect(f.state()).toEqual(before); expect(f.db.prepareAsync).not.toHaveBeenCalled();
  });
  it("fills missing segments only after exact overlap checks, without deleting existing evidence", async () => {
    const f = fixture(); f.state().versions.push(localVersion()); f.state().segments.push({ ...segment(0) });
    expect(await f.persist()).toMatchObject({ kind: "committed", insertedVersions: 1, insertedSegments: 1 });
    expect(f.state().segments).toEqual([segment(0), segment(1)]);
    expect(f.db.prepareAsync.mock.calls.every(([sql]) => !sql.includes("DELETE"))).toBe(true);
  });
  it("does not promote a historical selection over a newer local current version", async () => {
    const f = fixture(); f.state().versions.push(localVersion({ ...version(3), is_current: true }));
    await f.persist(); expect(f.state().versions.filter((v) => v.is_current === 1).map((v) => v.id)).toEqual([id(3)]);
  });
  it("clears nullable provenance monotonically without copying a cloud current marker", async () => {
    const f = fixture(); await f.persist(); f.state().versions[1].is_current = 1;
    const input = ready(); (input.bundle.versions[0] as TranscriptHistoryCloudVersion).created_by = null;
    (input.bundle.versions[0] as TranscriptHistoryCloudVersion).updated_at = LATER;
    expect(await f.persist(input)).toMatchObject({ kind: "committed", clearedProvenance: 1 });
    const row = f.state().versions.find((v) => v.id === id(2))!;
    expect(row).toMatchObject({ created_by: null, updated_at: LATER, is_current: 1 });
    expect(await f.persist()).toMatchObject({ kind: "unchanged" }); expect(row.created_by).toBeNull();
  });
  it.each(["id-content", "number", "scope", "segment", "extra-segment", "edit-segment", "global-id"])(
    "rejects conflicts before preparing a write: %s", async (kind) => {
      const f = fixture();
      if (kind === "id-content") f.state().versions.push({ ...localVersion(), plain_text: "different" });
      if (kind === "number") f.state().versions.push({ ...localVersion(), id: OTHER });
      if (kind === "scope") f.state().versions.push({ ...localVersion(), workspace_id: OTHER });
      if (kind === "segment") f.state().segments.push({ ...segment(0), text: "different" });
      if (kind === "extra-segment") f.state().segments.push({ ...segment(2) });
      if (kind === "edit-segment") f.state().segments.push({ ...segment(0), transcript_version_id: id(2) });
      if (kind === "global-id") f.state().segments.push({ ...segment(0), transcript_version_id: OTHER });
      const before = clone(f.state()); expect(await f.persist()).toMatchObject({ kind: "rejected", code: "HISTORY_CACHE_CONFLICT" });
      expect(f.state()).toEqual(before); expect(f.db.prepareAsync).not.toHaveBeenCalled();
    });
  it("defers the entire new provider bundle to unfinished result synchronization without touching diagnostics", async () => {
    const f = fixture(); f.state().outstanding = true;
    const before = clone(f.state());
    expect(await f.persist()).toMatchObject({ kind: "deferred_to_result_sync", code: "HISTORY_CACHE_RESULT_SYNC_OWNED" });
    expect(f.state()).toEqual(before); expect(f.db.prepareAsync).not.toHaveBeenCalled();
    const ownership = f.db.getFirstAsync.mock.calls.find(([sql]) => sql.startsWith("SELECT request_row.id"))!;
    expect(ownership[0]).toContain("NOT EXISTS"); expect(ownership[1]).toEqual([id(501)]);
  });
  it("does not reject every submitted request or a replay that cannot change result ownership", async () => {
    const f = fixture(); await f.persist(); f.state().outstanding = true;
    expect(await f.persist()).toMatchObject({ kind: "unchanged" });
    f.state().versions.splice(1); expect(await f.persist()).toMatchObject({ kind: "committed", insertedVersions: 1 });
  });
  it.each(["missing", "deleting", "deleted_at", "queue", "workspace"])("refuses unavailable session %s", async (reason) => {
    const f = fixture();
    if (reason === "missing") f.state().session = null;
    if (reason === "deleting") f.state().session!.status = "deleting";
    if (reason === "deleted_at") f.state().session!.deleted_at = NOW;
    if (reason === "queue") f.state().deleting = true;
    if (reason === "workspace") f.state().session!.workspace_id = OTHER;
    expect(await f.persist()).toMatchObject({ kind: "rejected", code: "HISTORY_CACHE_SESSION_UNAVAILABLE" });
    expect(f.db.prepareAsync).not.toHaveBeenCalled();
  });
  it("rolls back all version and segment inserts when the last row fails", async () => {
    const f = fixture(); f.control.failInsertAt = 4;
    expect(await f.persist()).toMatchObject({ kind: "rejected", insertedVersions: 0, insertedSegments: 0 });
    expect(f.state().versions).toEqual([]); expect(f.state().segments).toEqual([]);
    expect(f.db.execAsync).toHaveBeenCalledWith("ROLLBACK;"); expect(f.db.closeAsync).toHaveBeenCalledTimes(1);
  });
  it("rolls back a cancellation during writes instead of committing a partial bundle", async () => {
    const f = fixture(); let active = true; f.control.onWrite = async () => { active = false; };
    expect(await f.persist(ready(), () => { if (!active) throw historyCacheError("HISTORY_CACHE_CANCELLED"); }))
      .toMatchObject({ kind: "rejected", code: "HISTORY_CACHE_CANCELLED" });
    expect(f.state().versions).toEqual([]); expect(f.db.execAsync).not.toHaveBeenCalledWith("COMMIT;");
  });
  it("does not commit if statement finalization fails", async () => {
    const f = fixture(); f.control.failFinalize = true;
    expect(await f.persist()).toMatchObject({ kind: "rejected" });
    expect(f.db.execAsync).not.toHaveBeenCalledWith("COMMIT;"); expect(f.state().versions).toEqual([]);
  });
  it.each(["before", "after"] as const)("reports an uncertain COMMIT acknowledgement (%s), never an invented rollback", async (when) => {
    const f = fixture(); f.control.commitError = when;
    expect(await f.persist()).toMatchObject({ kind: "indeterminate", code: "HISTORY_CACHE_COMMIT_UNCONFIRMED", resources: "released" });
    expect(f.state().versions.length).toBe(when === "after" ? 2 : 0);
    f.control.commitError = null;
    expect((await f.persist()).kind).toBe(when === "after" ? "unchanged" : "committed");
  });
  it("preserves committed state on close failure, retains the resource, and retries only cleanup on drain", async () => {
    const f = fixture(); f.control.failClose = true;
    expect(await f.persist()).toMatchObject({ kind: "committed", resources: "pending", resourceError: "HISTORY_CACHE_RESOURCES_PENDING" });
    expect(await f.persist()).toMatchObject({ kind: "retryable", resources: "pending" }); expect(f.open).toHaveBeenCalledTimes(1);
    await expect(f.writer.waitForIdle()).rejects.toMatchObject({ code: "HISTORY_CACHE_RESOURCES_PENDING" });
    f.control.failClose = false; await f.writer.waitForIdle();
    expect(f.db.execAsync.mock.calls.filter(([sql]) => sql === "COMMIT;")).toHaveLength(1);
    expect((await f.persist()).kind).toBe("unchanged");
  });
  it("does not claim idle while native COMMIT or close is outstanding", async () => {
    const f = fixture(); const commit = deferred(); const close = deferred(); const entered = deferred();
    f.control.onCommit = async () => { entered.resolve(); await commit.promise; }; f.control.onClose = () => close.promise;
    const pending = f.persist(); await entered.promise;
    let idle = false; const wait = f.writer.waitForIdle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle).toBe(false); commit.resolve(); await Promise.resolve(); expect(idle).toBe(false);
    close.resolve(); expect((await pending).kind).toBe("committed"); await wait; expect(idle).toBe(true);
  });
  it("sanitizes busy failures without automatically retrying writes", async () => {
    const f = fixture(); f.db.execAsync.mockImplementation(async (sql) => {
      if (sql === "BEGIN IMMEDIATE;") throw new Error("database is locked PRIVATE PATH");
    });
    const result = await f.persist(); expect(result).toMatchObject({ kind: "retryable", code: "HISTORY_CACHE_BUSY" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(f.open).toHaveBeenCalledTimes(1);
  });
});

describe("owned history writer connection factory", () => {
  const open = SQLite.openDatabaseAsync as jest.MockedFunction<typeof SQLite.openDatabaseAsync>;
  it("opens the initialized file with useNewConnection without rerunning migrations", async () => {
    const main = fixture().db; const writer = fixture().db;
    open.mockReset(); open.mockResolvedValueOnce(main as never).mockResolvedValueOnce(writer as never);
    expect(await openLocalHistoryWriteDb()).toBe(writer); expect(await openLocalDb()).toBe(main);
    expect(open.mock.calls).toEqual([["project_recall.db"], ["project_recall.db", { useNewConnection: true }]]);
    expect(runMigrations).toHaveBeenCalledTimes(1); expect(main.closeAsync).not.toHaveBeenCalled();
  });
  it("refuses an aliased main handle without closing it", async () => {
    const main = fixture().db; open.mockReset(); open.mockResolvedValue(main as never);
    await expect(openLocalHistoryWriteDb()).rejects.toThrow("A separate local history write connection is required.");
    expect(main.closeAsync).not.toHaveBeenCalled();
  });
  it("retains the no-local-storage web behavior", async () => {
    const previous = Object.getOwnPropertyDescriptor(Platform, "OS")!;
    Object.defineProperty(Platform, "OS", { configurable: true, value: "web" });
    try { expect(await openLocalHistoryWriteDb()).toBeNull(); expect(open).not.toHaveBeenCalled(); }
    finally { Object.defineProperty(Platform, "OS", previous); }
  });
});
