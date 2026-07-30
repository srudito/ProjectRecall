import {
  __resetSerializedLocalTransactionsForTests,
  runSerializedLocalTransaction,
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
