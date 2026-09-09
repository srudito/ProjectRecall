import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";

import { createLocalReadSnapshotManager, type LocalSnapshotQueries } from "@/src/services/sqlite/read-snapshot";
import { __resetOpenLocalDbForTests, openLocalDb, openLocalReadDb } from "@/src/services/sqlite/schema";
import { runMigrations } from "@/src/services/sqlite/migrations";

jest.mock("@/src/services/sqlite/migrations", () => ({ LATEST_LOCAL_SCHEMA_VERSION: 11, runMigrations: jest.fn(async () => undefined) }));
const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const input = { sessionId: SESSION };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const database = () => ({
  execAsync: jest.fn(async (_sql: string): Promise<void> => undefined),
  getFirstAsync: jest.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => ({ value: 1 })),
  getAllAsync: jest.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => [{ value: 1 }]),
  closeAsync: jest.fn(async (): Promise<void> => undefined),
});
const fixture = () => {
  const state = { userId: USER as string | null, initialized: true, deleting: false };
  const listeners = new Set<() => void>();
  const db = database();
  const open = jest.fn(async (): Promise<SQLite.SQLiteDatabase | null> => db as unknown as SQLite.SQLiteDatabase);
  const manager = createLocalReadSnapshotManager({ open, identity: () => state,
    deletionPending: () => state.deleting,
    subscribeIdentity: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  const emit = (userId: string | null) => { state.userId = userId; for (const listener of [...listeners]) listener(); };
  const read = () => manager.withSnapshot(input, (reader) => reader.getFirstAsync<{ value: number }>("SELECT value FROM fixture"));
  return { state, listeners, db, open, manager, emit, read };
};
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe("3E.2B2A owned read snapshots", () => {
  it("sets read-only isolation on the owned connection and releases it before delivery", async () => {
    const f = fixture(); expect(await f.read()).toEqual({ value: 1 });
    expect(f.db.execAsync.mock.calls.map(([sql]) => sql)).toEqual([
      "PRAGMA query_only = ON; PRAGMA read_uncommitted = OFF; PRAGMA busy_timeout = 1000;", "BEGIN DEFERRED TRANSACTION;", "COMMIT;",
    ]);
    expect(f.db.closeAsync).toHaveBeenCalledTimes(1); expect(f.listeners.size).toBe(0);
    await f.manager.waitForIdle();
  });
  it("shares one handle and one transaction across all callback reads", async () => {
    const f = fixture(); await f.manager.withSnapshot(input, async (db) => {
      expect(Object.keys(db).sort()).toEqual(["getAllAsync", "getFirstAsync"]);
      await db.getFirstAsync("SELECT version FROM fixture"); await db.getAllAsync("SELECT segments FROM fixture");
    });
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.db.getFirstAsync).toHaveBeenCalledTimes(1); expect(f.db.getAllAsync).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { sessionId: "bad" }, { sessionId: 17 }, { ...input, workspaceId: "bad" },
    { ...input, userId: "bad" }, { ...input, timeoutMs: null }, { ...input, timeoutMs: 0 },
    { ...input, timeoutMs: 60_001 }, { ...input, assertActive: false }, { ...input, signal: {} }])(
    "rejects malformed input before opening a connection: %j", async (request) => {
      const f = fixture(); await expect(f.manager.withSnapshot(request as never, async () => undefined))
        .rejects.toMatchObject({ code: "LOCAL_READ_INPUT_INVALID" }); expect(f.open).not.toHaveBeenCalled();
    });
  it.each(["anonymous", "uninitialized", "wrong-user"])("fails closed for auth state %s", async (kind) => {
    const f = fixture(); if (kind === "anonymous") f.state.userId = null;
    if (kind === "uninitialized") f.state.initialized = false;
    await expect(f.manager.withSnapshot({ ...input, userId: kind === "wrong-user" ? OTHER : USER }, async () => undefined))
      .rejects.toMatchObject({ code: "LOCAL_READ_AUTH_REQUIRED" }); expect(f.open).not.toHaveBeenCalled();
  });
  it("does not admit reads during account deletion", async () => {
    const f = fixture(); f.state.deleting = true;
    await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_DELETION_PENDING" }); expect(f.open).not.toHaveBeenCalled();
  });
  it("distinguishes unavailable storage from an empty SELECT and redacts native failures", async () => {
    const f = fixture(); f.open.mockResolvedValueOnce(null);
    await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_STORAGE_UNAVAILABLE" });
    f.db.getFirstAsync.mockRejectedValueOnce(new Error("PRIVATE SQL/TEXT"));
    await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_QUERY_FAILED", message: "The local transcript could not be read." });
    expect(f.db.closeAsync).toHaveBeenCalledTimes(1); expect(f.db.execAsync).toHaveBeenCalledWith("ROLLBACK;");
  });
  it.each(["setup", "begin", "commit"])("closes the owned handle after native %s failure", async (stage) => {
    const f = fixture(); f.db.execAsync.mockImplementation(async (sql) => {
      if ((stage === "setup" && sql.startsWith("PRAGMA")) || (stage === "begin" && sql.startsWith("BEGIN")) ||
          (stage === "commit" && sql === "COMMIT;")) throw new Error("PRIVATE NATIVE FAILURE");
    });
    await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_QUERY_FAILED" }); expect(f.db.closeAsync).toHaveBeenCalledTimes(1);
    await f.manager.waitForIdle();
  });
  it("never exposes writer methods and refuses a mutation passed to a read method", async () => {
    const f = fixture(); await expect(f.manager.withSnapshot(input, (db) => db.getFirstAsync("DELETE FROM fixture")))
      .rejects.toMatchObject({ code: "LOCAL_READ_INPUT_INVALID" }); expect(f.db.getFirstAsync).not.toHaveBeenCalled();
  });
  it("copies parameters and request scope before asynchronous work", async () => {
    const f = fixture(); const request = { ...input, userId: USER.toUpperCase() };
    const values = ["original"];
    await f.manager.withSnapshot(request, async (db, scope) => {
      request.sessionId = OTHER; expect(scope.sessionId).toBe(SESSION);
      const pending = db.getFirstAsync("SELECT value FROM fixture WHERE id = ?", values); values[0] = "changed";
      await pending;
    });
    expect(f.db.getFirstAsync).toHaveBeenCalledWith("SELECT value FROM fixture WHERE id = ?", ["original"]);
  });
  it("closes a late open after cancellation without beginning a transaction", async () => {
    const f = fixture(); const gate = deferred<SQLite.SQLiteDatabase>(); f.open.mockReturnValueOnce(gate.promise);
    const abort = new AbortController(); const rejected = expect(f.manager.withSnapshot({ ...input, signal: abort.signal }, async () => "secret"))
      .rejects.toMatchObject({ code: "LOCAL_READ_CANCELLED" }); await tick(); abort.abort(); await rejected;
    let idle = false; const drain = f.manager.waitForIdle().then(() => { idle = true; }); await tick(); expect(idle).toBe(false);
    gate.resolve(f.db as unknown as SQLite.SQLiteDatabase); await drain;
    expect(f.db.execAsync).not.toHaveBeenCalled(); expect(f.db.closeAsync).toHaveBeenCalledTimes(1);
  });
  it("never revives an old read after A -> B -> A", async () => {
    const f = fixture(); const gate = deferred<unknown>(); f.db.getFirstAsync.mockReturnValueOnce(gate.promise);
    const rejected = expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_CONTEXT_INACTIVE" });
    await tick(); f.emit(OTHER); f.emit(USER); await rejected;
    gate.resolve({ value: 2 }); await f.manager.waitForIdle(); expect(f.listeners.size).toBe(0);
    expect(await f.read()).toEqual({ value: 1 });
  });
  it("rejects delivery when deletion starts during a native query", async () => {
    const f = fixture(); const gate = deferred<unknown>(); f.db.getFirstAsync.mockReturnValueOnce(gate.promise);
    const rejected = expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_DELETION_PENDING" });
    await tick(); f.state.deleting = true; gate.resolve({ value: 1 }); await rejected; await f.manager.waitForIdle();
    expect(f.db.execAsync).toHaveBeenCalledWith("ROLLBACK;");
  });
  it("keeps timeout delivery separate from query and handle drain", async () => {
    jest.useFakeTimers(); const f = fixture(); const gate = deferred<unknown>(); f.db.getFirstAsync.mockReturnValueOnce(gate.promise);
    const rejected = expect(f.manager.withSnapshot({ ...input, timeoutMs: 50 }, (db) => db.getFirstAsync("SELECT value FROM fixture")))
      .rejects.toMatchObject({ code: "LOCAL_READ_TIMEOUT" });
    await jest.advanceTimersByTimeAsync(50); await rejected; expect(f.db.closeAsync).not.toHaveBeenCalled();
    let idle = false; const drain = f.manager.waitForIdle().then(() => { idle = true; }); await tick(); expect(idle).toBe(false);
    gate.resolve({ value: 1 }); await drain; expect(f.db.closeAsync).toHaveBeenCalledTimes(1);
  });
  it("continues guarding result delivery while close is pending", async () => {
    const f = fixture(); const gate = deferred<void>(); const entered = deferred<void>();
    f.db.closeAsync.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    const rejected = expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_CONTEXT_INACTIVE" }); await entered.promise;
    expect(f.db.closeAsync).toHaveBeenCalledTimes(1); f.emit(OTHER); f.emit(USER); await rejected;
    let idle = false; const drain = f.manager.waitForIdle().then(() => { idle = true; }); await tick(); expect(idle).toBe(false);
    gate.resolve(); await drain;
  });
  it("retains failed-close handles, blocks new reads, and only reports idle after retry succeeds", async () => {
    const f = fixture(); f.db.closeAsync.mockRejectedValue(new Error("PRIVATE CLOSE FAILURE"));
    await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_CLOSE_FAILED" });
    await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_CLOSE_FAILED" }); expect(f.open).toHaveBeenCalledTimes(1);
    await expect(f.manager.waitForIdle()).rejects.toMatchObject({ code: "LOCAL_READ_CLOSE_FAILED" });
    f.db.closeAsync.mockResolvedValue(); await f.manager.waitForIdle(); expect(await f.read()).toEqual({ value: 1 });
  });
  it("limits open handles to two and cancels queued requests without opening them", async () => {
    const f = fixture(); const gates = [deferred<SQLite.SQLiteDatabase>(), deferred<SQLite.SQLiteDatabase>()];
    f.open.mockReturnValueOnce(gates[0].promise).mockReturnValueOnce(gates[1].promise);
    const all = [f.read(), f.read(), f.read()]; const observed = Promise.allSettled(all); await tick();
    expect(f.open).toHaveBeenCalledTimes(2); f.manager.invalidate();
    const outcomes = await observed; expect(outcomes.every((result) => result.status === "rejected")).toBe(true);
    gates[0].resolve(f.db as unknown as SQLite.SQLiteDatabase); gates[1].resolve(database() as unknown as SQLite.SQLiteDatabase);
    await f.manager.waitForIdle(); expect(f.open).toHaveBeenCalledTimes(2);
  });
  it("bounds waiting admission instead of opening unlimited connections", async () => {
    const f = fixture(); const a = deferred<SQLite.SQLiteDatabase>(); const b = deferred<SQLite.SQLiteDatabase>();
    f.open.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pending = Array.from({ length: 18 }, () => f.read()); const outcomes = Promise.allSettled(pending);
    await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_BUSY" }); f.manager.invalidate(); await outcomes;
    a.resolve(f.db as unknown as SQLite.SQLiteDatabase); b.resolve(database() as unknown as SQLite.SQLiteDatabase);
    await f.manager.waitForIdle();
  });
  it("uses reference-counted session deletion leases without blocking another session", async () => {
    const f = fixture(); const release1 = f.manager.pauseSession(SESSION); const release2 = f.manager.pauseSession(SESSION);
    await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_DELETION_PENDING" });
    await expect(f.manager.withSnapshot({ sessionId: OTHER }, async () => "ok")).resolves.toBe("ok");
    release1(); release1(); await expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_DELETION_PENDING" });
    release2(); expect(await f.read()).toEqual({ value: 1 });
  });
  it("invalidates a live session read when deletion preparation begins", async () => {
    const f = fixture(); const hold = deferred<unknown>(); f.db.getFirstAsync.mockReturnValueOnce(hold.promise);
    const rejected = expect(f.read()).rejects.toMatchObject({ code: "LOCAL_READ_CONTEXT_INACTIVE" }); await tick();
    const release = f.manager.pauseSession(SESSION); await rejected;
    hold.resolve({ value: 1 }); await f.manager.waitForIdle(); release();
  });
  it("does not let escaped read methods query a released connection", async () => {
    const f = fixture(); let escaped!: LocalSnapshotQueries;
    await f.manager.withSnapshot(input, async (reader) => { escaped = reader; });
    await expect(escaped.getFirstAsync("SELECT value FROM fixture")).rejects.toMatchObject({ code: "LOCAL_READ_CONTEXT_INACTIVE" });
    expect(f.db.getFirstAsync).not.toHaveBeenCalled();
  });
  it("drains a forgotten native read before rollback/close and does not report callback success", async () => {
    const f = fixture(); const hold = deferred<unknown>(); const returned = deferred<void>();
    f.db.getFirstAsync.mockReturnValueOnce(hold.promise);
    const rejected = expect(f.manager.withSnapshot(input, async (reader) => {
      void reader.getFirstAsync("SELECT value FROM fixture"); await tick(); returned.resolve(); return "not safe";
    })).rejects.toMatchObject({ code: "LOCAL_READ_INPUT_INVALID" });
    await returned.promise; await tick(); expect(f.db.closeAsync).not.toHaveBeenCalled(); hold.resolve({ value: 1 }); await rejected;
    expect(f.db.execAsync).toHaveBeenCalledWith("ROLLBACK;"); expect(f.db.closeAsync).toHaveBeenCalledTimes(1);
  });
  it("checks caller lifetime after query completion without disclosing caller exceptions", async () => {
    const f = fixture(); let active = true;
    f.db.getFirstAsync.mockImplementation(async () => { active = false; return { value: 1 }; });
    await expect(f.manager.withSnapshot({ ...input, assertActive: () => { if (!active) throw new Error("PRIVATE"); } },
      (reader) => reader.getFirstAsync("SELECT value FROM fixture"))).rejects.toMatchObject({ code: "LOCAL_READ_CONTEXT_INACTIVE" });
  });
});

describe("read handle factory", () => {
  const open = SQLite.openDatabaseAsync as jest.MockedFunction<typeof SQLite.openDatabaseAsync>;
  beforeEach(() => { jest.clearAllMocks(); __resetOpenLocalDbForTests(); });
  it("waits for canonical initialization and creates distinct handles to the same file without rerunning migrations", async () => {
    const main = database(); const first = database(); const second = database();
    open.mockResolvedValueOnce(main as never).mockResolvedValueOnce(first as never).mockResolvedValueOnce(second as never);
    expect(await openLocalReadDb()).toBe(first); expect(await openLocalReadDb()).toBe(second);
    expect(await openLocalDb()).toBe(main); expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(open.mock.calls).toEqual([["project_recall.db"], ["project_recall.db", { useNewConnection: true }], ["project_recall.db", { useNewConnection: true }]]);
    expect(main.execAsync.mock.calls.map(([sql]) => sql)).toEqual(["PRAGMA journal_mode = WAL;", "PRAGMA secure_delete = ON;"]);
    expect(first.execAsync).not.toHaveBeenCalled(); expect(main.closeAsync).not.toHaveBeenCalled();
  });
  it("does not close the shared writer if an adapter violates useNewConnection", async () => {
    const main = database(); open.mockResolvedValue(main as never);
    await expect(openLocalReadDb()).rejects.toThrow("A separate local read connection is required.");
    expect(main.closeAsync).not.toHaveBeenCalled();
  });
  it("retains the no-SQLite web behavior", async () => {
    const previous = Object.getOwnPropertyDescriptor(Platform, "OS")!;
    Object.defineProperty(Platform, "OS", { configurable: true, value: "web" });
    try { expect(await openLocalReadDb()).toBeNull(); expect(open).not.toHaveBeenCalled(); }
    finally { Object.defineProperty(Platform, "OS", previous); }
  });
});
