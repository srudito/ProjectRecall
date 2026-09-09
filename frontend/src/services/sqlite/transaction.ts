/**
 * One cooperative write lane for the local database. Acquire it once at an
 * operation boundary; OnDb helpers use their caller's handle/turn directly.
 * Never acquire another turn from a task or recovery callback that owns one.
 */
export interface LocalWriteDatabase {
  // Optional for the existing minimal non-native test ports. Expo's real
  // SQLiteDatabase implements both; a failed native inspection fails closed.
  isInTransactionAsync?(): Promise<boolean>;
  execAsync?(sql: string): Promise<void>;
}
export interface LocalTransactionDatabase extends LocalWriteDatabase {
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export class LocalWriteRecoveryError extends Error {
  readonly code = "LOCAL_WRITE_RECOVERY_PENDING";
  readonly retryable = true;
  constructor() {
    super("Local write resources need recovery before another write can start.");
    this.name = "LocalWriteRecoveryError";
  }
}

type Recovery = { recover: () => Promise<void> };
let transactionTail: Promise<void> = Promise.resolve();
const recoveries = new Set<Recovery>();
let mainRecoveries = new WeakMap<LocalWriteDatabase, () => void>();

/**
 * INTERNAL: retain only cleanup of a possibly open native write transaction.
 * Recovery runs inline under the NEXT turn, not queued behind its own waiter.
 * No COMMIT replay, payload writes, network calls, timers, or nested turns.
 * The owner may discharge this barrier once rollback/close is confirmed.
 */
export const retainLocalWriteRecovery = (recover: () => Promise<void>): (() => void) => {
  const entry = { recover };
  recoveries.add(entry);
  return () => { recoveries.delete(entry); };
};

const recoverBeforeWrite = async (): Promise<void> => {
  // One attempt per retained owner per admission. A failed cleanup rejects the
  // waiting operation before its task starts; it never becomes a retry loop.
  for (const entry of [...recoveries]) {
    if (!recoveries.has(entry)) continue;
    try { await entry.recover(); }
    catch { throw new LocalWriteRecoveryError(); }
    recoveries.delete(entry);
  }
  if (recoveries.size !== 0) throw new LocalWriteRecoveryError();
};

/** FIFO ownership only; no implicit BEGIN. Held through native cleanup. */
export const withLocalTransactionTurn = async <T>(task: () => Promise<T>): Promise<T> => {
  const previousTurn = transactionTail;
  let releaseTurn!: () => void;
  transactionTail = new Promise<void>((resolve) => { releaseTurn = resolve; });
  await previousTurn;
  try {
    if (recoveries.size > 0) await recoverBeforeWrite();
    return await task();
  } finally { releaseTurn(); }
};

const retainMainRecovery = (db: LocalWriteDatabase): void => {
  if (mainRecoveries.has(db)) return;
  const discharge = retainLocalWriteRecovery(async () => {
    const active = await db.isInTransactionAsync!();
    if (active !== false) {
      if (active !== true || !db.execAsync) throw new LocalWriteRecoveryError();
      await db.execAsync("ROLLBACK;");
    }
    if (await db.isInTransactionAsync!() !== false) throw new LocalWriteRecoveryError();
    mainRecoveries.delete(db);
  });
  mainRecoveries.set(db, discharge);
};

const requireMainAutocommit = async (db: LocalWriteDatabase): Promise<void> => {
  if (typeof db.isInTransactionAsync !== "function") return;
  try {
    if (await db.isInTransactionAsync() === false) return;
  } catch { /* An unavailable inspection is not evidence of transaction end. */ }
  retainMainRecovery(db);
  throw new LocalWriteRecoveryError();
};

/**
 * Standalone mutation/claim+read unit, without adding a BEGIN. Initialize the
 * database before entering. Do not use this inside an already-owned callback.
 * A cleanup/inspection failure never implies an acknowledged write rolled back.
 */
export const runSerializedLocalMutation = async <T>(
  db: LocalWriteDatabase,
  task: () => Promise<T>,
): Promise<T> => withLocalTransactionTurn(async () => {
  const canInspect = typeof db.isInTransactionAsync === "function";
  if (canInspect) await requireMainAutocommit(db);
  let result: T;
  try { result = await task(); }
  catch (failure) {
    // Preserve the primary failure, but retain any unresolved native state
    // before releasing the JS turn. Never close the application's main handle.
    if (canInspect) {
      try { await requireMainAutocommit(db); } catch { /* The next turn is gated. */ }
    }
    throw failure;
  }
  if (canInspect) await requireMainAutocommit(db);
  return result;
});

export const runSerializedLocalTransaction = async <T>(
  db: LocalTransactionDatabase,
  task: () => Promise<T>,
): Promise<T> => runSerializedLocalMutation(db, async () => {
  let result!: T;
  await db.withTransactionAsync(async () => { result = await task(); });
  return result;
});

/** Test-only reset; never use while real operations or retained handles exist. */
export const __resetSerializedLocalTransactionsForTests = (): void => {
  transactionTail = Promise.resolve();
  recoveries.clear();
  mainRecoveries = new WeakMap();
};
