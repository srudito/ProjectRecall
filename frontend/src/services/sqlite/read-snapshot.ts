import type * as SQLite from "expo-sqlite";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import { useAuthStore } from "@/src/stores/auth-store";

import { openLocalReadDb } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const messages = {
  LOCAL_READ_INPUT_INVALID: "The local read request is invalid.",
  LOCAL_READ_AUTH_REQUIRED: "Sign in to the same account to read this local transcript.",
  LOCAL_READ_CONTEXT_INACTIVE: "This local read is no longer active.",
  LOCAL_READ_DELETION_PENDING: "Local reads are paused during deletion.",
  LOCAL_READ_STORAGE_UNAVAILABLE: "Local transcript storage is unavailable.",
  LOCAL_READ_CANCELLED: "The local read was cancelled.",
  LOCAL_READ_TIMEOUT: "The local read timed out.",
  LOCAL_READ_BUSY: "Other local reads are still in progress.",
  LOCAL_READ_QUERY_FAILED: "The local transcript could not be read.",
  LOCAL_READ_CLOSE_FAILED: "Local read resources have not been released.",
} as const;
export type LocalReadSnapshotErrorCode = keyof typeof messages;
export class LocalReadSnapshotError extends Error {
  readonly code: LocalReadSnapshotErrorCode;
  constructor(code: LocalReadSnapshotErrorCode) {
    super(messages[code]);
    this.name = "LocalReadSnapshotError";
    this.code = code;
  }
}
const error = (code: LocalReadSnapshotErrorCode) => new LocalReadSnapshotError(code);

/** A callback cannot obtain exec/run/transaction/close or the native handle. */
export interface LocalSnapshotQueries {
  getFirstAsync<T>(sql: string, params?: SQLite.SQLiteBindValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: SQLite.SQLiteBindValue[]): Promise<T[]>;
}
export interface LocalReadSnapshotInput {
  sessionId: string;
  workspaceId?: string;
  userId?: string;
  assertActive?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface LocalReadSnapshotScope {
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly userId: string;
}
export interface LocalReadSnapshotDependencies {
  open: () => Promise<SQLite.SQLiteDatabase | null>;
  identity: () => { initialized: boolean; userId: string | null };
  subscribeIdentity: (listener: () => void) => () => void;
  deletionPending: () => boolean;
}
interface ReadOwner {
  sessionId: string;
  started: boolean;
  wake: () => void;
  stop: (reason: LocalReadSnapshotError) => void;
  drained: Promise<void>;
}

/**
 * Two owned handles, at most sixteen waiting requests. No shared connection,
 * persistent read transaction, writer queue, network or automatic retry loop.
 * Timeout cancels delivery; ownership remains until native work AND close drain.
 */
export const createLocalReadSnapshotManager = (dependencies: LocalReadSnapshotDependencies) => {
  const owners = new Set<ReadOwner>();
  const waiting: ReadOwner[] = [];
  const pausedSessions = new Map<string, number>();
  const failedHandles = new Set<SQLite.SQLiteDatabase>();
  let running = 0;
  let retryingClose: Promise<void> | null = null;

  const pump = (): void => {
    while (running < 2 && waiting.length > 0) {
      const owner = waiting.shift()!;
      if (failedHandles.size > 0) {
        owner.stop(error("LOCAL_READ_CLOSE_FAILED"));
        owner.wake();
        continue;
      }
      owner.started = true;
      running += 1;
      owner.wake();
    }
  };
  const invalidate = (sessionId?: string): void => {
    for (const owner of owners) {
      if (sessionId === undefined || owner.sessionId === sessionId.toLowerCase()) {
        owner.stop(error("LOCAL_READ_CONTEXT_INACTIVE"));
      }
    }
  };
  /** Lease spans deletion preparation through commit/rollback, including awaits. */
  const pauseSession = (sessionId: string): (() => void) => {
    const id = sessionId.toLowerCase();
    pausedSessions.set(id, (pausedSessions.get(id) ?? 0) + 1);
    invalidate(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (pausedSessions.get(id) ?? 1) - 1;
      if (count === 0) pausedSessions.delete(id);
      else pausedSessions.set(id, count);
    };
  };

  const withSnapshot = async <T>(
    input: LocalReadSnapshotInput,
    task: (queries: LocalSnapshotQueries, scope: LocalReadSnapshotScope) => Promise<T>,
  ): Promise<T> => {
    if (!input || typeof input.sessionId !== "string" || !UUID.test(input.sessionId) || typeof task !== "function" ||
        (input.workspaceId !== undefined && (typeof input.workspaceId !== "string" || !UUID.test(input.workspaceId))) ||
        (input.userId !== undefined && (typeof input.userId !== "string" || !UUID.test(input.userId))) ||
        (input.assertActive !== undefined && typeof input.assertActive !== "function")) {
      throw error("LOCAL_READ_INPUT_INVALID");
    }
    const timeoutMs = input.timeoutMs === undefined ? 20_000 : input.timeoutMs;
    const signal = input.signal;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
        (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" ||
          typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function"))) {
      throw error("LOCAL_READ_INPUT_INVALID");
    }
    const identity = dependencies.identity();
    const expectedUser = input.userId?.toLowerCase() ?? identity.userId?.toLowerCase();
    if (!identity.initialized || !expectedUser || identity.userId?.toLowerCase() !== expectedUser) {
      throw error("LOCAL_READ_AUTH_REQUIRED");
    }
    const scope: LocalReadSnapshotScope = Object.freeze({ sessionId: input.sessionId.toLowerCase(),
      workspaceId: input.workspaceId?.toLowerCase(), userId: expectedUser });
    const assertActive = input.assertActive;
    const checkContext = (): void => {
      if (signal?.aborted) throw error("LOCAL_READ_CANCELLED");
      if (dependencies.deletionPending() || pausedSessions.has(scope.sessionId)) throw error("LOCAL_READ_DELETION_PENDING");
      const auth = dependencies.identity();
      if (!auth.initialized || auth.userId?.toLowerCase() !== scope.userId) throw error("LOCAL_READ_CONTEXT_INACTIVE");
      try { assertActive?.(); } catch { throw error("LOCAL_READ_CONTEXT_INACTIVE"); }
    };
    checkContext();
    if (failedHandles.size > 0) throw error("LOCAL_READ_CLOSE_FAILED");
    if (owners.size >= 18) throw error("LOCAL_READ_BUSY");

    let stopped: LocalReadSnapshotError | null = null;
    let finished = false;
    let wake!: () => void;
    const permit = new Promise<void>((resolve) => { wake = resolve; });
    let markDrained!: () => void;
    const drained = new Promise<void>((resolve) => { markDrained = resolve; });
    let interrupt!: (reason: LocalReadSnapshotError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
    void interrupted.catch(() => undefined);
    const deadline = Date.now() + timeoutMs;
    const stop = (reason: LocalReadSnapshotError): void => {
      if (finished || stopped) return;
      stopped = reason;
      interrupt(reason);
      const index = waiting.indexOf(owner);
      if (index >= 0) { waiting.splice(index, 1); wake(); }
    };
    const guard = (): void => {
      if (stopped) throw stopped;
      if (finished) throw error("LOCAL_READ_CONTEXT_INACTIVE");
      try {
        checkContext();
        if (Date.now() >= deadline) throw error("LOCAL_READ_TIMEOUT");
      } catch (failure) {
        const safe = failure instanceof LocalReadSnapshotError ? failure : error("LOCAL_READ_CONTEXT_INACTIVE");
        stop(safe);
        throw safe;
      }
    };
    const owner: ReadOwner = { sessionId: scope.sessionId, started: false, wake, stop, drained };
    owners.add(owner);
    let unsubscribe: (() => void) | undefined;
    const cancel = (): void => stop(error("LOCAL_READ_CANCELLED"));
    const timer = setTimeout(() => stop(error("LOCAL_READ_TIMEOUT")), timeoutMs);
    // Observe every identity transition, including A -> B -> A while queued.
    try {
      unsubscribe = dependencies.subscribeIdentity(() => {
        const auth = dependencies.identity();
        if (!auth.initialized || auth.userId?.toLowerCase() !== scope.userId) stop(error("LOCAL_READ_CONTEXT_INACTIVE"));
      });
      signal?.addEventListener("abort", cancel);
      guard();
    } catch { stop(error("LOCAL_READ_CONTEXT_INACTIVE")); }
    if (stopped) wake();
    else { waiting.push(owner); pump(); }

    const operation = (async (): Promise<T> => {
      let db: SQLite.SQLiteDatabase | null = null;
      let transactionOpen = false;
      let acceptingQueries = false;
      let queryTail: Promise<unknown> = Promise.resolve();
      const queriesInFlight = new Set<Promise<unknown>>();
      try {
        await permit;
        guard();
        try { db = await dependencies.open(); } catch { throw error("LOCAL_READ_STORAGE_UNAVAILABLE"); }
        guard();
        if (!db) throw error("LOCAL_READ_STORAGE_UNAVAILABLE");
        const connection = db;
        try {
          await connection.execAsync("PRAGMA query_only = ON; PRAGMA read_uncommitted = OFF; PRAGMA busy_timeout = 1000;");
          guard();
          await connection.execAsync("BEGIN DEFERRED TRANSACTION;");
          transactionOpen = true;
        } catch (failure) { throw stopped ?? (failure instanceof LocalReadSnapshotError ? failure : error("LOCAL_READ_QUERY_FAILED")); }
        guard();
        acceptingQueries = true;
        const query = <V>(sql: string, params: SQLite.SQLiteBindValue[] | undefined,
          execute: (values: SQLite.SQLiteBindValue[]) => Promise<V>): Promise<V> => {
          const values = params?.slice() ?? [];
          const pending = queryTail.then(async () => {
            guard();
            if (!acceptingQueries || !/^\s*SELECT\b/i.test(sql) || sql.includes("\0")) throw error("LOCAL_READ_INPUT_INVALID");
            let result: V;
            try { result = await execute(values); } catch { throw stopped ?? error("LOCAL_READ_QUERY_FAILED"); }
            guard();
            return result;
          });
          const tracked = pending.finally(() => { queriesInFlight.delete(tracked); });
          queriesInFlight.add(tracked);
          queryTail = tracked.catch(() => undefined);
          return tracked;
        };
        const reader: LocalSnapshotQueries = Object.freeze({
          getFirstAsync: <V>(sql: string, params?: SQLite.SQLiteBindValue[]) =>
            query(sql, params, (values) => connection.getFirstAsync<V>(sql, values)),
          getAllAsync: <V>(sql: string, params?: SQLite.SQLiteBindValue[]) =>
            query(sql, params, (values) => connection.getAllAsync<V>(sql, values)),
        });
        const result = await task(reader, scope);
        acceptingQueries = false;
        if (queriesInFlight.size > 0) throw error("LOCAL_READ_INPUT_INVALID");
        guard();
        try { await connection.execAsync("COMMIT;"); transactionOpen = false; }
        catch { throw error("LOCAL_READ_QUERY_FAILED"); }
        guard();
        return result;
      } finally {
        acceptingQueries = false;
        // Do not race a still-running native SELECT with ROLLBACK or close.
        await Promise.allSettled([...queriesInFlight]);
        if (db) {
          try {
            if (transactionOpen) { try { await db.execAsync("ROLLBACK;"); } catch { /* close still required */ } }
          } finally {
            try { await db.closeAsync(); }
            catch { failedHandles.add(db); throw error("LOCAL_READ_CLOSE_FAILED"); }
          }
        }
      }
    })();
    const cleanup = (): void => {
      owners.delete(owner);
      if (owner.started) running -= 1;
      markDrained();
      pump();
    };
    // The caller can time out first. Drain tracking never follows Promise.race.
    void operation.then(cleanup, cleanup);
    try {
      const result = await Promise.race([operation, interrupted]);
      guard(); // Includes account/session changes while COMMIT/close awaited.
      return result;
    } finally {
      finished = true;
      clearTimeout(timer);
      try { signal?.removeEventListener("abort", cancel); } catch { /* No raw cleanup errors. */ }
      try { unsubscribe?.(); } catch { /* Finished owner cannot publish again. */ }
    }
  };

  const waitForIdle = async (): Promise<void> => {
    while (owners.size > 0) await Promise.all([...owners].map((owner) => owner.drained));
    if (retryingClose) return retryingClose;
    const retry = async (): Promise<void> => {
      for (const db of failedHandles) {
        try { await db.closeAsync(); failedHandles.delete(db); }
        catch { throw error("LOCAL_READ_CLOSE_FAILED"); }
      }
    };
    retryingClose = retry();
    try { await retryingClose; } finally { retryingClose = null; }
  };
  return { withSnapshot, invalidate, pauseSession, waitForIdle };
};

const snapshots = createLocalReadSnapshotManager({
  open: () => openLocalReadDb(),
  identity: () => { const auth = useAuthStore.getState(); return { initialized: auth.initialized, userId: auth.user?.id ?? null }; },
  subscribeIdentity: (listener) => useAuthStore.subscribe(listener),
  deletionPending: isAccountDeletionLocallyPending,
});
export const withLocalReadSnapshot = snapshots.withSnapshot;
export const invalidateLocalReadSnapshots = snapshots.invalidate;
export const pauseSessionReadSnapshots = snapshots.pauseSession;
export const waitForLocalReadSnapshotsIdle = snapshots.waitForIdle;
