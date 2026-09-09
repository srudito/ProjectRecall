import {
  __resetSerializedLocalTransactionsForTests,
  runSerializedLocalTransaction,
  runSerializedLocalMutation,
  retainLocalWriteRecovery,
  LocalWriteRecoveryError,
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

describe("shared mutation ownership and native recovery", () => {
  beforeEach(() => { __resetSerializedLocalTransactionsForTests(); });
  it("holds one turn across a standalone write and its readback without a nested BEGIN", async () => {
    const read = deferred(); const entered = deferred(); const order: string[] = [];
    const db = { isInTransactionAsync: jest.fn(async () => false), execAsync: jest.fn() };
    const first = runSerializedLocalMutation(db, async () => { order.push("write"); entered.resolve(); await read.promise; order.push("read"); return 3; });
    await entered.promise;
    const second = runSerializedLocalMutation(db, async () => { order.push("second"); return 4; });
    await Promise.resolve(); expect(order).toEqual(["write"]);
    read.resolve(); expect(await Promise.all([first, second])).toEqual([3, 4]);
    expect(order).toEqual(["write", "read", "second"]); expect(db.execAsync).not.toHaveBeenCalled();
    expect(db.isInTransactionAsync).toHaveBeenCalledTimes(4);
  });
  it("runs retained cleanup inside the next turn, before its task, and never replays that task", async () => {
    const order: string[] = [];
    await withLocalTransactionTurn(async () => {
      retainLocalWriteRecovery(async () => { order.push("cleanup"); }); order.push("owner-end");
    });
    const task = jest.fn(async () => { order.push("new-write"); return 2; });
    expect(await runSerializedLocalMutation({}, task)).toBe(2);
    expect(order).toEqual(["owner-end", "cleanup", "new-write"]); expect(task).toHaveBeenCalledTimes(1);
  });
  it("rejects pending writes before SQL when cleanup fails, with one attempt per admission", async () => {
    let failing = true; const cleanup = jest.fn(async () => { if (failing) throw new Error("PRIVATE PATH"); });
    retainLocalWriteRecovery(cleanup);
    const task = jest.fn(async () => "saved");
    await expect(runSerializedLocalMutation({}, task)).rejects.toEqual(new LocalWriteRecoveryError());
    await expect(runSerializedLocalMutation({}, task)).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING", retryable: true });
    expect(cleanup).toHaveBeenCalledTimes(2); expect(task).not.toHaveBeenCalled();
    failing = false; expect(await runSerializedLocalMutation({}, task)).toBe("saved");
    expect(cleanup).toHaveBeenCalledTimes(3); expect(task).toHaveBeenCalledTimes(1);
  });
  it("retains a main-connection transaction after failed native rollback and recovers before the next mutation", async () => {
    let active = false; let rollbackFails = true;
    const db = { isInTransactionAsync: jest.fn(async () => active),
      execAsync: jest.fn(async (sql: string) => { expect(sql).toBe("ROLLBACK;"); if (rollbackFails) throw new Error("PRIVATE"); active = false; }),
      withTransactionAsync: jest.fn(async (task: () => Promise<void>) => { active = true; await task(); active = false; }) };
    const firstError = new Error("first transaction failed");
    await expect(runSerializedLocalTransaction(db, async () => { throw firstError; })).rejects.toBe(firstError);
    const next = jest.fn(async () => "safe");
    await expect(runSerializedLocalMutation(db, next)).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING" });
    expect(next).not.toHaveBeenCalled(); expect(active).toBe(true);
    rollbackFails = false; expect(await runSerializedLocalMutation(db, next)).toBe("safe");
    expect(active).toBe(false); expect(next).toHaveBeenCalledTimes(1); expect(db.execAsync).toHaveBeenCalledTimes(2);
  });
  it("blocks an unexpected main transaction before entering a standalone task", async () => {
    let active = true; const task = jest.fn(async () => 1);
    const db = { isInTransactionAsync: async () => active, execAsync: jest.fn(async () => { active = false; }) };
    await expect(runSerializedLocalMutation(db, task)).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING" });
    expect(task).not.toHaveBeenCalled(); expect(db.execAsync).not.toHaveBeenCalled();
    expect(await runSerializedLocalMutation(db, task)).toBe(1); expect(db.execAsync).toHaveBeenCalledWith("ROLLBACK;");
  });
  it("fails closed when native transaction inspection is unavailable, then recovers without closing the main handle", async () => {
    let broken = true; const task = jest.fn(async () => 1);
    const db = { isInTransactionAsync: jest.fn(async () => { if (broken) throw new Error("PRIVATE"); return false; }),
      execAsync: jest.fn(), closeAsync: jest.fn() };
    await expect(runSerializedLocalMutation(db, task)).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING" });
    await expect(runSerializedLocalMutation(db, task)).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING" });
    expect(task).not.toHaveBeenCalled(); broken = false;
    expect(await runSerializedLocalMutation(db, task)).toBe(1); expect(db.closeAsync).not.toHaveBeenCalled(); expect(db.execAsync).not.toHaveBeenCalled();
  });
  it("waits for actual recovery completion instead of treating a pending cleanup as an idle lane", async () => {
    const finish = deferred(); const entered = deferred(); const task = jest.fn(async () => "done");
    retainLocalWriteRecovery(async () => { entered.resolve(); await finish.promise; });
    const pending = runSerializedLocalMutation({}, task); await entered.promise; expect(task).not.toHaveBeenCalled();
    finish.resolve(); expect(await pending).toBe("done");
  });
  it("supports independent retained owners and idempotent discharge", async () => {
    const a = jest.fn(async () => {}); const b = jest.fn(async () => {});
    const discharge = retainLocalWriteRecovery(a); retainLocalWriteRecovery(b); discharge(); discharge();
    await runSerializedLocalMutation({}, async () => {});
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledTimes(1);
    await runSerializedLocalMutation({}, async () => {}); expect(b).toHaveBeenCalledTimes(1);
  });
  it("does not repeatedly recover a healthy connection after an ordinary task failure", async () => {
    const db = { isInTransactionAsync: jest.fn(async () => false), execAsync: jest.fn() };
    await expect(runSerializedLocalMutation(db, async () => { throw new Error("validation"); })).rejects.toThrow("validation");
    expect(await runSerializedLocalMutation(db, async () => 7)).toBe(7); expect(db.execAsync).not.toHaveBeenCalled();
  });
  it("does not replay a successful task after post-write inspection fails", async () => {
    const db = { isInTransactionAsync: jest.fn(async () => false), execAsync: jest.fn() };
    db.isInTransactionAsync.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("late native inspection"));
    const write = jest.fn(async () => 7);
    await expect(runSerializedLocalMutation(db, write)).rejects.toMatchObject({ code: "LOCAL_WRITE_RECOVERY_PENDING" });
    expect(write).toHaveBeenCalledTimes(1);
    await runSerializedLocalMutation(db, async () => 9); expect(write).toHaveBeenCalledTimes(1);
  });
});
