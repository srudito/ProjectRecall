import {
  __resetSerializedLocalTransactionsForTests,
  runSerializedLocalTransaction,
  withLocalTransactionTurn,
  type LocalTransactionDatabase,
} from "@/src/services/sqlite/transaction";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("serialized local SQLite transactions", () => {
  beforeEach(() => {
    __resetSerializedLocalTransactionsForTests();
  });

  it("does not begin a second transaction while the first is active", async () => {
    let activeTransactions = 0;
    let maximumConcurrentTransactions = 0;
    const firstTaskEntered = deferred();
    const releaseFirstTask = deferred();
    const executionOrder: string[] = [];

    const db: LocalTransactionDatabase = {
      withTransactionAsync: jest.fn(async (task) => {
        activeTransactions += 1;
        maximumConcurrentTransactions = Math.max(
          maximumConcurrentTransactions,
          activeTransactions,
        );

        if (activeTransactions > 1) {
          throw new Error("cannot start a transaction within a transaction");
        }

        try {
          await task();
        } finally {
          activeTransactions -= 1;
        }
      }),
    };

    const first = runSerializedLocalTransaction(db, async () => {
      executionOrder.push("first-start");
      firstTaskEntered.resolve();
      await releaseFirstTask.promise;
      executionOrder.push("first-end");
      return "first";
    });

    await firstTaskEntered.promise;

    const second = runSerializedLocalTransaction(db, async () => {
      executionOrder.push("second");
      return "second";
    });

    await Promise.resolve();
    expect(executionOrder).toEqual(["first-start"]);

    releaseFirstTask.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(maximumConcurrentTransactions).toBe(1);
    expect(executionOrder).toEqual([
      "first-start",
      "first-end",
      "second",
    ]);
  });

  it("releases the queue after a transaction failure", async () => {
    const db: LocalTransactionDatabase = {
      withTransactionAsync: jest.fn(async (task) => {
        await task();
      }),
    };

    await expect(
      runSerializedLocalTransaction(db, async () => {
        throw new Error("transaction failed");
      }),
    ).rejects.toThrow("transaction failed");

    await expect(
      runSerializedLocalTransaction(db, async () => "recovered"),
    ).resolves.toBe("recovered");
  });
});

describe("owned history write turns share the existing FIFO", () => {
  beforeEach(() => { __resetSerializedLocalTransactionsForTests(); });
  it("orders owned connection work between existing transactions without adding a nested BEGIN", async () => {
    const entered = deferred(); const release = deferred(); const events: string[] = [];
    const db = { withTransactionAsync: jest.fn(async (task: () => Promise<void>) => { events.push("begin"); await task(); events.push("end"); }) };
    const first = runSerializedLocalTransaction(db, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const owned = withLocalTransactionTurn(async () => { events.push("owned-begin"); events.push("owned-close"); return 7; });
    const last = runSerializedLocalTransaction(db, async () => { events.push("last"); });
    await Promise.resolve(); expect(events).toEqual(["begin"]); release.resolve();
    await first; expect(await owned).toBe(7); await last;
    expect(events).toEqual(["begin", "end", "owned-begin", "owned-close", "begin", "last", "end"]);
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(2);
  });
  it("releases the cooperative turn after owned rollback/close failure", async () => {
    await expect(withLocalTransactionTurn(async () => { throw new Error("owned failure"); })).rejects.toThrow("owned failure");
    expect(await withLocalTransactionTurn(async () => "next")).toBe("next");
  });
});
