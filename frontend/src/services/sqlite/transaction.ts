/**
 * Serialize repository-level SQLite transactions inside this JavaScript
 * runtime so Android never receives overlapping BEGIN statements.
 *
 * Transaction callbacks must use the supplied database operations directly.
 * They must not call runSerializedLocalTransaction() recursively.
 */
export interface LocalTransactionDatabase {
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

let transactionTail: Promise<void> = Promise.resolve();

/** Cooperative FIFO ownership only; never call this recursively. No BEGIN is implicit. */
export const withLocalTransactionTurn = async <T>(task: () => Promise<T>): Promise<T> => {
  const previousTurn = transactionTail;
  let releaseTurn!: () => void;
  transactionTail = new Promise<void>((resolve) => { releaseTurn = resolve; });
  await previousTurn;
  try { return await task(); }
  finally { releaseTurn(); }
};

export const runSerializedLocalTransaction = async <T>(
  db: LocalTransactionDatabase,
  task: () => Promise<T>,
): Promise<T> => withLocalTransactionTurn(async () => {
  let result!: T;
  await db.withTransactionAsync(async () => { result = await task(); });
  return result;
});

/** Test-only reset for deterministic unit tests. */
export const __resetSerializedLocalTransactionsForTests = (): void => {
  transactionTail = Promise.resolve();
};
