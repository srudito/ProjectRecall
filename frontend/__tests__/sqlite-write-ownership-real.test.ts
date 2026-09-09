import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as Crypto from "expo-crypto";

import { createHistoryCacheWriter, type HistoryCacheDatabase } from "@/src/services/sqlite/history-cache";
import { openLocalDb } from "@/src/services/sqlite/schema";
import { setPreference, updateRecordingUploadStatus } from "@/src/services/sqlite/repository";
import { __resetSerializedLocalTransactionsForTests, runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import { prepareHistoryCacheCommand } from "@/src/services/transcription/history-cache-types";
import { HISTORY_BUNDLE_SOURCE, type TranscriptHistoryBundleResult } from "@/src/services/transcription/history-bundle-types";

jest.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: jest.fn() }));
jest.mock("@/src/services/sqlite/schema", () => ({ openLocalDb: jest.fn(), openLocalHistoryWriteDb: jest.fn() }));
jest.mock("@/src/services/sqlite/read-snapshot", () => ({ pauseSessionReadSnapshots: jest.fn(() => () => {}), withLocalReadSnapshot: jest.fn() }));
jest.mock("@/src/services/transcription/history-cache-service", () => ({
  pauseSessionTranscriptHistoryCache: jest.fn(() => () => {}), waitForTranscriptHistoryCacheIdle: jest.fn(async () => {}),
}));

// Real SQLite connections, synthetic file only. Python's sqlite3 executes SQL;
// this adapter does NOT claim Expo bridge or native prepared-statement coverage.
const WORKER = String.raw`
import json, sqlite3, sys
connections = {}
for line in sys.stdin:
    request = json.loads(line)
    try:
        op = request['op']
        name = request.get('name', 'main')
        if op == 'open':
            db = sqlite3.connect(sys.argv[1], isolation_level=None, timeout=0)
            db.row_factory = sqlite3.Row
            connections[name] = db
            result = sqlite3.sqlite_version
        elif op == 'close':
            connections.pop(name).close()
            result = None
        elif op == 'active':
            result = connections[name].in_transaction
        elif op == 'stop':
            for db in connections.values(): db.close()
            result = None
        else:
            db = connections[name]
            sql = request['sql']
            if op == 'exec':
                # Never executescript: it implicitly commits open transactions.
                for part in sql.split(';'):
                    if part.strip(): db.execute(part)
                result = None
            else:
                cursor = db.execute(sql, request.get('params', []))
                result = [dict(row) for row in cursor.fetchall()] if op == 'query' else {'changes': cursor.rowcount}
        print(json.dumps({'id': request['id'], 'result': result}), flush=True)
        if op == 'stop': break
    except Exception as error:
        print(json.dumps({'id': request['id'], 'error': str(error), 'code': getattr(error, 'sqlite_errorcode', None)}), flush=True)
`;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const JOB = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const VERSION = "11111111-1111-4111-8111-111111111111";
const SEGMENT = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-09T00:00:00.000000Z";
const ready = (): Extract<TranscriptHistoryBundleResult, { kind: "ready" }> => ({
  kind: "ready", source: HISTORY_BUNDLE_SOURCE, selectedVersionId: VERSION,
  scope: { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION },
  bundle: { completeness: "managed_provider_bundle",
    versions: [{ id: VERSION, workspace_id: WORKSPACE, session_id: SESSION, transcription_run_id: RUN,
      created_by: USER, version: 1, version_origin: "provider", version_status: "final", parent_version_id: null,
      plain_text: "sintetis", language_summary: {}, content_checksum_sha256: createHash("sha256").update("sintetis").digest("hex"),
      is_current: true, created_at: NOW, updated_at: NOW }],
    segments: [{ id: SEGMENT, workspace_id: WORKSPACE, session_id: SESSION, transcript_version_id: VERSION,
      segment_index: 0, start_ms: 0, end_ms: 100, text: "sintetis", language_code: "id", speaker_label: null,
      confidence: null, provider_segment_id: `${ID}:word:0`, created_at: NOW, updated_at: NOW }],
    provider: { versionId: VERSION, runId: RUN, jobId: JOB, recordingId: ID, cleanupCompletedAt: NOW, expectedSegmentCount: 1 } },
});
const SEED = `
PRAGMA journal_mode = WAL;
CREATE TABLE local_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, deleted_at TEXT);
CREATE TABLE local_session_deletion_queue (id TEXT PRIMARY KEY, session_id TEXT);
CREATE TABLE local_recordings (id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT, upload_status TEXT, updated_at TEXT);
CREATE TABLE local_processing_jobs (id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT, recording_id TEXT, status TEXT);
CREATE TABLE local_transcription_runs (id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT, recording_id TEXT, processing_job_id TEXT, status TEXT);
CREATE TABLE local_transcription_request_queue (id TEXT PRIMARY KEY, queue_status TEXT, server_job_id TEXT);
CREATE TABLE local_user_preferences (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE local_transcript_versions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, transcription_run_id TEXT, created_by TEXT,
  version INTEGER NOT NULL CHECK(version > 0), version_origin TEXT, version_status TEXT, parent_version_id TEXT,
  plain_text TEXT, language_summary TEXT, content_checksum_sha256 TEXT, is_current INTEGER CHECK(is_current IN (0,1)),
  created_at TEXT, updated_at TEXT, UNIQUE(session_id, version));
CREATE UNIQUE INDEX current_version ON local_transcript_versions(session_id) WHERE is_current = 1;
CREATE TABLE local_transcript_segments (
  id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT, transcript_version_id TEXT, segment_index INTEGER CHECK(segment_index >= 0),
  start_ms INTEGER CHECK(start_ms >= 0), end_ms INTEGER CHECK(end_ms >= start_ms), text TEXT, language_code TEXT, speaker_label TEXT,
  confidence REAL, provider_segment_id TEXT, created_at TEXT, updated_at TEXT, UNIQUE(transcript_version_id, segment_index));
`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const fixture = async () => {
  const directory = mkdtempSync(join(tmpdir(), "recall-c1-sqlite-"));
  const pending = new Map<number, Pending>(); let sequence = 0; let stopped = false;
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-u", "-c", WORKER, join(directory, "synthetic.db")], { stdio: "pipe" });
  // Never log raw process/SQLite errors or database contents.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const fail = () => { for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error("Synthetic SQLite adapter stopped.")); } pending.clear(); };
  child.on("error", fail); child.on("exit", fail);
  lines.on("line", (line) => {
    const row = JSON.parse(line) as { id: number; result?: unknown; error?: string; code?: number };
    const wait = pending.get(row.id); if (!wait) return; pending.delete(row.id); clearTimeout(wait.timer);
    if (row.error) wait.reject(Object.assign(new Error(row.error), { code: row.code })); else wait.resolve(row.result);
  });
  const rpc = (op: string, name = "main", sql?: string, params?: readonly unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Synthetic SQLite adapter timed out.")); }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, op, name, sql, params })}\n`, (error) => {
      if (error) { const wait = pending.get(id); if (wait) { pending.delete(id); clearTimeout(wait.timer); wait.reject(new Error("Synthetic SQLite adapter unavailable.")); } }
    });
  });
  const dispose = async () => {
    if (stopped) return; stopped = true;
    try { await rpc("stop"); } finally {
      child.stdin.end(); lines.close(); child.kill(); fail(); rmSync(directory, { recursive: true, force: true });
    }
  };
  const control = { failWrite: false, failRollback: false, failClose: false, loseBegin: false, loseCommit: false,
    afterWrite: null as (() => Promise<void>) | null, commitCount: 0, mainWrites: 0, mainRollbackFails: false };
  const adapter = (name: string) => ({
    isInTransactionAsync: async (): Promise<boolean> => await rpc("active", name) as boolean,
    execAsync: async (sql: string): Promise<void> => {
      if (sql === "ROLLBACK;" && (name === "main" ? control.mainRollbackFails : control.failRollback)) throw new Error("injected rollback failure");
      await rpc("exec", name, sql);
      if (name !== "main" && sql === "BEGIN IMMEDIATE;" && control.loseBegin) throw new Error("lost begin acknowledgement");
      if (name !== "main" && sql === "COMMIT;") { control.commitCount += 1; if (control.loseCommit) throw new Error("lost commit acknowledgement"); }
    },
    getAllAsync: async <T,>(sql: string, params: readonly unknown[] = []): Promise<T[]> => await rpc("query", name, sql, params) as T[],
    getFirstAsync: async <T,>(sql: string, params: readonly unknown[] = []): Promise<T | null> => (await rpc("query", name, sql, params) as T[])[0] ?? null,
    runAsync: async (sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> => {
      if (name === "main") control.mainWrites += 1;
      return await rpc("write", name, sql, params) as { changes: number };
    },
    prepareAsync: async (sql: string) => ({
      executeAsync: async (params: readonly unknown[]) => {
        if (control.failWrite && sql.includes("local_transcript_segments")) throw new Error("injected last-row failure");
        const result = await rpc("write", name, sql, params) as { changes: number };
        await control.afterWrite?.(); return result;
      },
      finalizeAsync: async () => {},
    }),
    closeAsync: async () => { if (control.failClose) throw new Error("injected close failure"); await rpc("close", name); },
  });
  const main = Object.assign(adapter("main"), { withTransactionAsync: async (task: () => Promise<void>) => {
    await main.execAsync("BEGIN;");
    try { await task(); await main.execAsync("COMMIT;"); }
    catch (failure) { await main.execAsync("ROLLBACK;"); throw failure; }
  } });
  let opened = 0;
  const writer = createHistoryCacheWriter({ open: async (): Promise<HistoryCacheDatabase> => {
    const name = `history-${++opened}`; await rpc("open", name); return adapter(name);
  } });
  try {
    await rpc("open"); await main.execAsync(SEED);
    await main.runAsync("INSERT INTO local_sessions VALUES (?, ?, 'recorded', NULL)", [SESSION, WORKSPACE]);
    await main.runAsync("INSERT INTO local_recordings VALUES (?, ?, ?, 'pending', ?)", [ID, WORKSPACE, SESSION, NOW]);
    control.mainWrites = 0; (openLocalDb as jest.Mock).mockResolvedValue(main);
  } catch (failure) { await dispose(); throw failure; }
  return { main, writer, control, dispose, opened: () => opened,
    persist: async () => writer.persist(await prepareHistoryCacheCommand(ready(), () => {})) };
};

beforeEach(() => {
  __resetSerializedLocalTransactionsForTests();
  (Crypto.digestStringAsync as jest.Mock).mockImplementation(async (_algorithm: string, value: string) => createHash("sha256").update(value).digest("hex"));
});

describe("3E.2B2C1 real synthetic SQLite ownership (not Expo native)", () => {
  it("keeps standalone recording writes outside an uncommitted history transaction", async () => {
    const f = await fixture(); const entered = deferred(); const finish = deferred();
    try {
      f.control.afterWrite = async () => { entered.resolve(); await finish.promise; };
      const history = f.persist(); await entered.promise;
      const save = updateRecordingUploadStatus(ID, { upload_status: "uploaded" });
      expect(await f.main.getAllAsync("SELECT * FROM local_transcript_versions")).toEqual([]);
      expect(f.control.mainWrites).toBe(0); finish.resolve();
      expect((await history).kind).toBe("committed"); await save;
      expect(await f.main.getFirstAsync("SELECT upload_status FROM local_recordings WHERE id = ?", [ID])).toEqual({ upload_status: "uploaded" });
      expect(f.control.mainWrites).toBe(1); expect(f.control.commitCount).toBe(1);
    } finally { finish.resolve(); await f.dispose(); }
  }, 20000);
  it("queues history behind a main transaction rather than receiving a native busy error", async () => {
    const f = await fixture(); const entered = deferred(); const finish = deferred();
    try {
      const main = runSerializedLocalTransaction(f.main, async () => { await f.main.runAsync("UPDATE local_recordings SET upload_status='uploading'"); entered.resolve(); await finish.promise; });
      await entered.promise; const command = await prepareHistoryCacheCommand(ready(), () => {});
      const history = f.writer.persist(command); await Promise.resolve(); expect(f.opened()).toBe(0);
      finish.resolve(); await main; expect((await history).kind).toBe("committed");
    } finally { finish.resolve(); await f.dispose(); }
  }, 20000);
  it("rolls back partial history without rolling back the next standalone mutation", async () => {
    const f = await fixture();
    try {
      f.control.failWrite = true; expect((await f.persist()).kind).toBe("rejected");
      await setPreference("theme", "dark");
      expect(await f.main.getAllAsync("SELECT * FROM local_transcript_versions")).toEqual([]);
      expect(await f.main.getAllAsync("SELECT * FROM local_transcript_segments")).toEqual([]);
      expect(await f.main.getFirstAsync("SELECT value FROM local_user_preferences WHERE key='theme'")).toEqual({ value: '"dark"' });
    } finally { await f.dispose(); }
  }, 20000);
  it("does not run main SQL while a retained history connection still holds a write lock", async () => {
    const f = await fixture();
    try {
      f.control.failWrite = true; f.control.failRollback = true; f.control.failClose = true;
      expect(await f.persist()).toMatchObject({ kind: "rejected", resources: "pending" });
      await expect(setPreference("theme", "dark")).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING" });
      expect(f.control.mainWrites).toBe(0);
      f.control.failRollback = false; f.control.failClose = false;
      await setPreference("theme", "system"); await f.writer.waitForIdle();
      expect(f.control.mainWrites).toBe(1); expect(await f.main.getAllAsync("SELECT * FROM local_transcript_versions")).toEqual([]);
    } finally { await f.dispose(); }
  }, 20000);
  it("allows other writes after confirmed COMMIT when only connection close failed", async () => {
    const f = await fixture();
    try {
      f.control.failClose = true; expect(await f.persist()).toMatchObject({ kind: "committed", resources: "pending" });
      await setPreference("theme", "dark"); expect(f.control.mainWrites).toBe(1);
      await expect(f.writer.waitForIdle()).rejects.toMatchObject({ code: "HISTORY_CACHE_RESOURCES_PENDING" });
      f.control.failClose = false; await f.writer.waitForIdle(); expect(f.control.commitCount).toBe(1);
    } finally { await f.dispose(); }
  }, 20000);
  it("preserves an ambiguous COMMIT result, using inspection only to establish lock release", async () => {
    const f = await fixture();
    try {
      f.control.loseCommit = true; f.control.failRollback = true; f.control.failClose = true;
      expect(await f.persist()).toMatchObject({ kind: "indeterminate", resources: "pending" });
      await setPreference("theme", "dark"); expect(f.control.mainWrites).toBe(1);
      expect(await f.main.getAllAsync("SELECT id FROM local_transcript_versions")).toEqual([{ id: VERSION }]);
      f.control.failClose = false; await f.writer.waitForIdle(); expect(f.control.commitCount).toBe(1);
    } finally { await f.dispose(); }
  }, 20000);
  it("recovers a failed main rollback before allowing the next standalone write", async () => {
    const f = await fixture();
    try {
      f.control.mainRollbackFails = true;
      await expect(runSerializedLocalTransaction(f.main, async () => {
        await f.main.runAsync("UPDATE local_recordings SET upload_status='not-committed'"); throw new Error("injected task failure");
      })).rejects.toThrow();
      await expect(setPreference("theme", "dark")).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING" });
      expect(f.control.mainWrites).toBe(1); f.control.mainRollbackFails = false;
      await setPreference("theme", "dark");
      expect(await f.main.getFirstAsync("SELECT upload_status FROM local_recordings WHERE id = ?", [ID])).toEqual({ upload_status: "pending" });
      expect(f.control.mainWrites).toBe(2);
    } finally { await f.dispose(); }
  }, 20000);
  it("treats a lost BEGIN acknowledgment as possible native ownership until cleanup confirms release", async () => {
    const f = await fixture();
    try {
      f.control.loseBegin = true; f.control.failRollback = true; f.control.failClose = true;
      expect(await f.persist()).toMatchObject({ kind: "rejected", resources: "pending" });
      await expect(setPreference("theme", "dark")).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING" });
      expect(f.control.mainWrites).toBe(0); f.control.failRollback = false; f.control.failClose = false;
      await setPreference("theme", "dark"); expect(f.control.mainWrites).toBe(1); expect(f.control.commitCount).toBe(0);
    } finally { await f.dispose(); }
  }, 20000);
});
