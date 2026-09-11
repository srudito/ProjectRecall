import type {
  NetInfoState,
  NetInfoStateType,
} from "@react-native-community/netinfo";

import type { TranscriptEditQueueRow } from "@/src/services/sqlite/repository";
import {
  createTranscriptEditWorker,
  type TranscriptEditWorkerDependencies,
} from "@/src/services/sync/transcript-edit-worker";
import {
  TranscriptEditClientError,
  type RemoteTranscriptEditResult,
} from "@/src/services/transcription/edit-client";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BASE_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const LATER_CURRENT_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-08-19T00:00:00.000Z";

const connectedState = (): NetInfoState => ({
  type: "wifi" as NetInfoStateType.wifi,
  isConnected: true,
  isInternetReachable: true,
  details: {
    isConnectionExpensive: false,
    ssid: null,
    bssid: null,
    strength: null,
    ipAddress: null,
    subnet: null,
    frequency: null,
    linkSpeed: null,
    rxLinkSpeed: null,
    txLinkSpeed: null,
  },
});

const offlineState = (): NetInfoState => ({
  type: "none" as NetInfoStateType.none,
  isConnected: false,
  isInternetReachable: false,
  details: null,
});

const queueRow: TranscriptEditQueueRow = {
  id: CLIENT_VERSION_ID,
  user_id: USER_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  expected_current_version_id: BASE_VERSION_ID,
  plain_text: "corrected transcript",
  queue_status: "pending",
  attempt_count: 0,
  max_attempts: 5,
  next_retry_at: null,
  last_error_code: null,
  last_safe_error: null,
  created_at: NOW,
  updated_at: NOW,
};

const remoteResult: RemoteTranscriptEditResult = {
  transcriptVersionId: CLIENT_VERSION_ID,
  versionNumber: 2,
  currentVersionId: CLIENT_VERSION_ID,
  wasCreated: true,
};

const makeDependencies = (
  overrides: Partial<TranscriptEditWorkerDependencies> = {},
): TranscriptEditWorkerDependencies => {
  let returned = false;
  return {
    platform: "android",
    isMutationReleased: jest.fn(() => true),
    getConnectionState: jest.fn(async () => connectedState()),
    getAuthenticatedUserId: jest.fn(async () => USER_ID),
    isDeletionPending: jest.fn(() => false),
    getCurrentUserId: jest.fn(() => USER_ID),
    isAppActive: jest.fn(() => true),
    getNextWakeAt: jest.fn(async () => null),
    canSubmitOperation: jest.fn(async () => true),
    scheduleWake: jest.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
    clearWake: jest.fn(),
    resetSubmitting: jest.fn(async () => 0),
    getNextOperation: jest.fn(async () => {
      if (returned) return null;
      returned = true;
      return queueRow;
    }),
    claimOperation: jest.fn(async () => ({
      ...queueRow,
      queue_status: "submitting" as const,
      attempt_count: 1,
    })),
    deferOperation: jest.fn(async () => undefined),
    rescheduleOperation: jest.fn(async () => undefined),
    completeOperation: jest.fn(async () => undefined),
    markConflict: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
    markCancelled: jest.fn(async () => undefined),
    submitRemoteEdit: jest.fn(async () => remoteResult),
    normalizeRemoteError: jest.fn((error: unknown) => {
      if (error instanceof TranscriptEditClientError) return error;
      return new TranscriptEditClientError(
        "TRANSCRIPT_EDIT_REQUEST_FAILED",
        "The transcript edit could not be synchronized yet.",
        { retryable: true, cause: error },
      );
    }),
    now: jest.fn(() => new Date(NOW)),
    random: jest.fn(() => 0.5),
    maxOperationsPerRun: 10,
    maxAttempts: 5,
    notifyChanged: jest.fn(),
    requestCurrentVersionSync: jest.fn(),
    ...overrides,
  };
};

const expectedGuard = expect.objectContaining({ userId: USER_ID, assertActive: expect.any(Function) });

describe("transcript edit outbox worker", () => {
  it("submits one immutable snapshot and completes only that snapshot", async () => {
    const dependencies = makeDependencies();

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result).toMatchObject({ succeeded: 1, processed: 1 });
    expect(dependencies.resetSubmitting).toHaveBeenCalledWith(USER_ID, expectedGuard);
    expect(dependencies.submitRemoteEdit).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      expectedCurrentVersionId: BASE_VERSION_ID,
      clientVersionId: CLIENT_VERSION_ID,
      plainText: "corrected transcript",
      expectedUserId: USER_ID,
    });
    expect(dependencies.completeOperation).toHaveBeenCalledWith({
      queueId: CLIENT_VERSION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      expectedCurrentVersionId: BASE_VERSION_ID,
      plainText: "corrected transcript",
    }, expectedGuard);
    expect(dependencies.requestCurrentVersionSync).toHaveBeenCalledWith({
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
    });
    expect(dependencies.notifyChanged).toHaveBeenCalledTimes(2);
  });

  it("accepts a successful late replay even when another version is now current", async () => {
    const dependencies = makeDependencies({
      submitRemoteEdit: jest.fn(async () => ({
        ...remoteResult,
        currentVersionId: LATER_CURRENT_VERSION_ID,
        wasCreated: false,
      })),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.succeeded).toBe(1);
    expect(dependencies.completeOperation).toHaveBeenCalledTimes(1);
    expect(dependencies.markConflict).not.toHaveBeenCalled();
  });

  it("preserves the local draft and marks stale-base saves as conflict", async () => {
    const conflict = new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_BASE_CONFLICT",
      "The transcript changed elsewhere before this edit could be saved.",
      { retryable: false },
    );
    const dependencies = makeDependencies({
      submitRemoteEdit: jest.fn(async () => {
        throw conflict;
      }),
      normalizeRemoteError: jest.fn(() => conflict),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.conflicts).toBe(1);
    expect(dependencies.markConflict).toHaveBeenCalledWith(
      CLIENT_VERSION_ID,
      conflict.code,
      conflict.message,
      expectedGuard,
    );
    expect(dependencies.completeOperation).not.toHaveBeenCalled();
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
    expect(dependencies.requestCurrentVersionSync).not.toHaveBeenCalled();
  });

  it("defers a feature-disabled edit without consuming it as terminal failure", async () => {
    const disabled = new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_FEATURE_DISABLED",
      "Transcript editing is temporarily unavailable.",
      { retryable: false },
    );
    const dependencies = makeDependencies({
      submitRemoteEdit: jest.fn(async () => {
        throw disabled;
      }),
      normalizeRemoteError: jest.fn(() => disabled),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.deferred).toBe(1);
    expect(dependencies.deferOperation).toHaveBeenCalledWith(
      CLIENT_VERSION_ID,
      expect.any(String),
      disabled.code,
      disabled.message,
      expectedGuard,
    );
    expect(dependencies.markFailed).not.toHaveBeenCalled();
  });

  it("defers an expired authentication session and stops the run", async () => {
    const authError = new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED",
      "Sign in again before synchronizing transcript edits.",
      { retryable: true },
    );
    const dependencies = makeDependencies({
      submitRemoteEdit: jest.fn(async () => {
        throw authError;
      }),
      normalizeRemoteError: jest.fn(() => authError),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.state).toBe("authentication_required");
    expect(result.deferred).toBe(1);
    expect(dependencies.deferOperation).toHaveBeenCalled();
  });

  it("backs off retryable network failures", async () => {
    const networkError = new TranscriptEditClientError(
      "NETWORK_UNAVAILABLE",
      "The transcript edit is saved locally and will retry when the network is available.",
      { retryable: true },
    );
    const dependencies = makeDependencies({
      submitRemoteEdit: jest.fn(async () => {
        throw networkError;
      }),
      normalizeRemoteError: jest.fn(() => networkError),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.retried).toBe(1);
    expect(dependencies.rescheduleOperation).toHaveBeenCalledWith(
      CLIENT_VERSION_ID,
      expect.any(String),
      networkError.code,
      networkError.message,
      expectedGuard,
    );
    expect(dependencies.markFailed).not.toHaveBeenCalled();
  });

  it("stops retrying after the bounded attempt budget is exhausted", async () => {
    const networkError = new TranscriptEditClientError(
      "NETWORK_UNAVAILABLE",
      "The transcript edit is saved locally and will retry when the network is available.",
      { retryable: true },
    );
    const dependencies = makeDependencies({
      claimOperation: jest.fn(async () => ({
        ...queueRow,
        queue_status: "submitting" as const,
        attempt_count: 5,
      })),
      submitRemoteEdit: jest.fn(async () => {
        throw networkError;
      }),
      normalizeRemoteError: jest.fn(() => networkError),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.failed).toBe(1);
    expect(dependencies.markFailed).toHaveBeenCalledWith(
      CLIENT_VERSION_ID,
      networkError.code,
      networkError.message,
      expectedGuard,
    );
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
  });

  it("cancels an edit whose server session is no longer available", async () => {
    const unavailable = new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_SESSION_UNAVAILABLE",
      "This session is no longer available for transcript editing.",
      { retryable: false },
    );
    const dependencies = makeDependencies({
      submitRemoteEdit: jest.fn(async () => {
        throw unavailable;
      }),
      normalizeRemoteError: jest.fn(() => unavailable),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.cancelled).toBe(1);
    expect(dependencies.markCancelled).toHaveBeenCalledWith(
      CLIENT_VERSION_ID,
      unavailable.code,
      unavailable.message,
      expectedGuard,
    );
  });

  it("does not claim edit work while offline", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async () => offlineState()),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.state).toBe("offline");
    expect(dependencies.claimOperation).not.toHaveBeenCalled();
    expect(dependencies.resetSubmitting).not.toHaveBeenCalled();
  });

  it("does not synchronize local edits while account deletion is pending", async () => {
    const dependencies = makeDependencies({
      isDeletionPending: jest.fn(() => true),
    });

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result.processed).toBe(0);
    expect(dependencies.getConnectionState).not.toHaveBeenCalled();
  });

  it("recovers interrupted submitting rows before every single-flight run", async () => {
    const dependencies = makeDependencies();
    const worker = createTranscriptEditWorker(dependencies);

    await worker.run();
    await worker.run();

    expect(dependencies.resetSubmitting).toHaveBeenCalledTimes(2);
    expect(dependencies.resetSubmitting).toHaveBeenNthCalledWith(1, USER_ID, expectedGuard);
    expect(dependencies.resetSubmitting).toHaveBeenNthCalledWith(2, USER_ID, expectedGuard);
  });
});

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const scheduledWorker = (overrides: Partial<TranscriptEditWorkerDependencies> = {}) => {
  const wakes: { callback: () => void; delayMs: number }[] = [];
  const dependencies = makeDependencies({
    scheduleWake: jest.fn((callback: () => void, delayMs: number) => {
      wakes.push({ callback, delayMs });
      return wakes.length as unknown as ReturnType<typeof setTimeout>;
    }),
    ...overrides,
  });
  return { dependencies, wakes, worker: createTranscriptEditWorker(dependencies) };
};

describe("3D.2B edit worker wake and lifecycle safety", () => {
  it("retains a Save wake after an in-flight empty queue read", async () => {
    const started = deferred<void>();
    const emptyRead = deferred<TranscriptEditQueueRow | null>();
    let reads = 0;
    const { worker, wakes, dependencies } = scheduledWorker({
      getNextOperation: jest.fn(async () => {
        reads += 1;
        if (reads === 1) { started.resolve(); return emptyRead.promise; }
        return reads === 2 ? queueRow : null;
      }),
    });
    const first = worker.run();
    await started.promise;
    expect(worker.run()).toBe(first);
    emptyRead.resolve(null);
    await first;
    expect(wakes).toHaveLength(1);
    wakes[0].callback();
    await worker.waitForIdle();
    expect(dependencies.submitRemoteEdit).toHaveBeenCalledTimes(1);
    worker.dispose();
  });

  it("retains a reconnect wake while an older pass exits offline", async () => {
    const started = deferred<void>(); const connection = deferred<NetInfoState>();
    let connections = 0;
    const { worker, wakes, dependencies } = scheduledWorker({
      getConnectionState: jest.fn(async () => {
        connections += 1;
        if (connections === 1) { started.resolve(); return connection.promise; }
        return connectedState();
      }),
    });
    const first = worker.run(); await started.promise;
    expect(worker.run()).toBe(first);
    connection.resolve(offlineState());
    expect((await first).state).toBe("offline");
    expect(wakes).toHaveLength(1);
    wakes[0].callback(); await worker.waitForIdle();
    expect(dependencies.completeOperation).toHaveBeenCalledTimes(1);
    worker.dispose();
  });

  it("waits for the durable claim before checking scope or sending the RPC", async () => {
    const started = deferred<void>(); const claim = deferred<TranscriptEditQueueRow | null>();
    const { worker, dependencies } = scheduledWorker({
      claimOperation: jest.fn(async () => { started.resolve(); return claim.promise; }),
    });
    const pending = worker.run(); await started.promise;
    expect(dependencies.canSubmitOperation).not.toHaveBeenCalled();
    expect(dependencies.submitRemoteEdit).not.toHaveBeenCalled();
    claim.resolve({ ...queueRow, queue_status: "submitting", attempt_count: 1 });
    await pending;
    expect(dependencies.canSubmitOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: CLIENT_VERSION_ID, queue_status: "submitting" }), expectedGuard,
    );
    expect(dependencies.getNextOperation).toHaveBeenCalledWith(USER_ID, NOW, 5, expectedGuard);
    expect(dependencies.getNextWakeAt).toHaveBeenCalledWith(USER_ID, NOW, 5, expectedGuard);
    worker.dispose();
  });

  it("does not submit a claim whose session becomes unavailable", async () => {
    const { worker, dependencies } = scheduledWorker({ canSubmitOperation: jest.fn(async () => false) });
    expect((await worker.run()).cancelled).toBe(1);
    expect(dependencies.submitRemoteEdit).not.toHaveBeenCalled();
    expect(dependencies.markCancelled).toHaveBeenCalledWith(CLIENT_VERSION_ID,
      "TRANSCRIPT_EDIT_SESSION_UNAVAILABLE", expect.any(String), expectedGuard);
    worker.dispose();
  });

  it.each(["user", "workspace", "session", "base", "text", "id"])(
    "fails closed on a changed claimed %s without changing another row", async (field) => {
      const patch = field === "user" ? { user_id: LATER_CURRENT_VERSION_ID }
        : field === "workspace" ? { workspace_id: LATER_CURRENT_VERSION_ID }
          : field === "session" ? { session_id: LATER_CURRENT_VERSION_ID }
            : field === "base" ? { expected_current_version_id: LATER_CURRENT_VERSION_ID }
              : field === "id" ? { id: LATER_CURRENT_VERSION_ID } : { plain_text: "changed" };
      const { worker, dependencies, wakes } = scheduledWorker({
        claimOperation: jest.fn(async () => ({ ...queueRow, ...patch, queue_status: "submitting" as const, attempt_count: 1 })),
      });
      await expect(worker.run()).rejects.toThrow("claim scope changed");
      expect(dependencies.submitRemoteEdit).not.toHaveBeenCalled();
      expect(dependencies.markFailed).not.toHaveBeenCalled(); expect(wakes).toEqual([]);
      worker.dispose();
    },
  );

  it.each(["web", "background", "signed_out", "deletion"])("admits no work for %s", async (condition) => {
    const { worker, dependencies, wakes } = scheduledWorker({
      platform: condition === "web" ? "web" : "android",
      isAppActive: () => condition !== "background",
      getCurrentUserId: () => condition === "signed_out" ? null : USER_ID,
      isDeletionPending: () => condition === "deletion",
    });
    await worker.run();
    expect(dependencies.getConnectionState).not.toHaveBeenCalled();
    expect(dependencies.resetSubmitting).not.toHaveBeenCalled(); expect(wakes).toEqual([]);
    worker.dispose();
  });

  it("ignores a stale authenticated-user response after sign-out", async () => {
    const started = deferred<void>(); const auth = deferred<string | null>();
    let user: string | null = USER_ID;
    const { worker, dependencies, wakes } = scheduledWorker({
      getCurrentUserId: () => user,
      getAuthenticatedUserId: async () => { started.resolve(); return auth.promise; },
    });
    const pending = worker.run(); await started.promise;
    user = null; auth.resolve(USER_ID);
    expect((await pending).state).toBe("authentication_required");
    expect(dependencies.resetSubmitting).not.toHaveBeenCalled(); expect(wakes).toEqual([]);
    worker.dispose();
  });

  it("can roll back an admitted claim when the run guard is invalidated", async () => {
    const started = deferred<void>(); const release = deferred<void>();
    const { worker, dependencies } = scheduledWorker({
      claimOperation: async (_id, guard) => {
        started.resolve(); await release.promise; guard?.assertActive();
        return { ...queueRow, queue_status: "submitting", attempt_count: 1 };
      },
    });
    const pending = worker.run(); await started.promise; worker.pause(); release.resolve();
    expect((await pending).state).toBe("paused");
    expect(dependencies.submitRemoteEdit).not.toHaveBeenCalled(); worker.dispose();
  });

  it("stop/drain waits for the real in-flight RPC and suppresses its late writes", async () => {
    const started = deferred<void>(); const remote = deferred<RemoteTranscriptEditResult>();
    const { worker, dependencies, wakes } = scheduledWorker({
      submitRemoteEdit: async () => { started.resolve(); return remote.promise; },
    });
    const pending = worker.run(); await started.promise; worker.pause();
    let idle = false;
    const drain = worker.waitForIdle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle).toBe(false);
    expect((await worker.run()).state).toBe("paused");
    remote.resolve(remoteResult); await drain;
    expect((await pending).state).toBe("paused");
    expect(dependencies.completeOperation).not.toHaveBeenCalled();
    expect(dependencies.requestCurrentVersionSync).not.toHaveBeenCalled();
    expect(wakes).toEqual([]); worker.dispose();
  });

  it("does not persist a late result when the deletion marker changes without a lifecycle event", async () => {
    const started = deferred<void>(); const remote = deferred<RemoteTranscriptEditResult>();
    let deleting = false;
    const { worker, dependencies, wakes } = scheduledWorker({
      isDeletionPending: () => deleting,
      submitRemoteEdit: async () => { started.resolve(); return remote.promise; },
    });
    const pending = worker.run(); await started.promise;
    deleting = true; remote.resolve(remoteResult); await pending;
    expect(dependencies.completeOperation).not.toHaveBeenCalled(); expect(wakes).toEqual([]);
    worker.dispose();
  });

  it("keeps A -> B -> A generations separate while replaying the stable operation", async () => {
    const started = deferred<void>(); const remote = deferred<RemoteTranscriptEditResult>();
    let user = USER_ID; let completed = false; let submissions = 0;
    const { worker, dependencies, wakes } = scheduledWorker({
      getCurrentUserId: () => user,
      getNextOperation: async () => completed ? null : queueRow,
      submitRemoteEdit: jest.fn(async () => {
        submissions += 1;
        if (submissions === 1) { started.resolve(); return remote.promise; }
        return remoteResult;
      }),
      completeOperation: jest.fn(async () => { completed = true; }),
    });
    const pending = worker.run(); await started.promise;
    user = LATER_CURRENT_VERSION_ID; worker.pause(); void worker.resume();
    user = USER_ID; worker.pause(); void worker.resume();
    remote.resolve(remoteResult); await pending;
    expect(dependencies.completeOperation).not.toHaveBeenCalled();
    expect(wakes).toHaveLength(1); wakes[0].callback(); await worker.waitForIdle();
    expect(dependencies.submitRemoteEdit).toHaveBeenCalledTimes(2);
    expect(dependencies.submitRemoteEdit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientVersionId: CLIENT_VERSION_ID, expectedCurrentVersionId: BASE_VERSION_ID, plainText: queueRow.plain_text,
    }));
    expect(dependencies.completeOperation).toHaveBeenCalledTimes(1); worker.dispose();
  });

  it("schedules the durable due-time and never forces a claim on repeated wakes", async () => {
    let now = Date.parse(NOW); const due = now + 5_000; let completed = false;
    const { worker, dependencies, wakes } = scheduledWorker({
      now: () => new Date(now),
      getNextOperation: jest.fn(async () => now >= due && !completed ? queueRow : null),
      getNextWakeAt: async () => completed ? null : new Date(due).toISOString(),
      completeOperation: async () => { completed = true; },
    });
    await worker.run(); expect(wakes[0].delayMs).toBe(5_000);
    now += 1_000; await worker.run(); expect(wakes[1].delayMs).toBe(4_000);
    expect(dependencies.claimOperation).not.toHaveBeenCalled();
    wakes[0].callback(); expect(dependencies.claimOperation).not.toHaveBeenCalled();
    now = due; wakes[1].callback(); await worker.waitForIdle();
    expect(dependencies.submitRemoteEdit).toHaveBeenCalledTimes(1); worker.dispose();
  });

  it("reconstructs the next retry from SQLite in a fresh worker instance", async () => {
    const deps = { getNextOperation: jest.fn(async () => null),
      getNextWakeAt: jest.fn(async () => new Date(Date.parse(NOW) + 9_000).toISOString()) };
    const first = scheduledWorker(deps); await first.worker.run(); first.worker.dispose();
    const second = scheduledWorker(deps); await second.worker.run();
    expect(second.wakes[0].delayMs).toBe(9_000); second.worker.dispose();
  });

  it("cancels a scheduled callback on pause and recalculates it on resume", async () => {
    const { worker, dependencies, wakes } = scheduledWorker({
      getNextOperation: async () => null, getNextWakeAt: async () => NOW,
    });
    await worker.run(); expect(wakes[0].delayMs).toBe(250);
    worker.pause(); wakes[0].callback(); await worker.waitForIdle();
    expect(dependencies.resetSubmitting).toHaveBeenCalledTimes(1);
    await worker.resume(); expect(wakes).toHaveLength(2);
    worker.dispose(); wakes[1].callback(); await worker.resume();
    expect(dependencies.resetSubmitting).toHaveBeenCalledTimes(2);
  });

  it("does not spin timers offline or after an authentication-required response", async () => {
    const offline = scheduledWorker({ getConnectionState: async () => offlineState() });
    await offline.worker.run(); expect(offline.wakes).toEqual([]); offline.worker.dispose();
    const blocked = scheduledWorker({ submitRemoteEdit: async () => {
      throw new TranscriptEditClientError("TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED", "Sign in again.", { retryable: true });
    }, getNextWakeAt: jest.fn(async () => NOW) });
    await blocked.worker.run(); expect(blocked.wakes).toEqual([]);
    expect(blocked.dependencies.getNextWakeAt).not.toHaveBeenCalled(); blocked.worker.dispose();
  });

  it("schedules a persisted transient retry but does not requeue conflict or exhausted rows", async () => {
    const retry = scheduledWorker({ submitRemoteEdit: async () => {
      throw new TranscriptEditClientError("NETWORK_UNAVAILABLE", "Retry later.", { retryable: true });
    }, getNextWakeAt: async () => new Date(Date.parse(NOW) + 4_000).toISOString() });
    expect((await retry.worker.run()).retried).toBe(1); expect(retry.wakes[0].delayMs).toBe(4_000);
    retry.worker.dispose();
    const terminal = scheduledWorker({
      claimOperation: async () => ({ ...queueRow, queue_status: "submitting", attempt_count: 5 }),
      submitRemoteEdit: async () => { throw new TranscriptEditClientError("NETWORK_UNAVAILABLE", "Retry later.", { retryable: true }); },
    });
    expect((await terminal.worker.run()).failed).toBe(1); expect(terminal.wakes).toEqual([]);
    expect(terminal.dependencies.rescheduleOperation).not.toHaveBeenCalled(); terminal.worker.dispose();
  });

  it("never normalizes a local completion failure into a remote failure or self-retries it", async () => {
    const failure = new Error("Injected local commit failure");
    const { worker, dependencies, wakes } = scheduledWorker({ completeOperation: async () => { throw failure; } });
    await expect(worker.run()).rejects.toBe(failure);
    expect(dependencies.normalizeRemoteError).not.toHaveBeenCalled();
    expect(dependencies.markFailed).not.toHaveBeenCalled();
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
    expect(dependencies.requestCurrentVersionSync).not.toHaveBeenCalled(); expect(wakes).toEqual([]);
    worker.dispose();
  });

  it("notifies after claim and settlement without letting a listener failure corrupt success", async () => {
    const { worker, dependencies } = scheduledWorker({ notifyChanged: jest.fn(() => { throw new Error("listener"); }) });
    expect((await worker.run()).succeeded).toBe(1);
    expect(dependencies.notifyChanged).toHaveBeenCalledTimes(2); worker.dispose();
  });
});


describe("3D.2B bounded batch continuation", () => {
  it("continues a remaining batch without overlapping or exceeding the pass limit", async () => {
    const rows = [queueRow, { ...queueRow, id: LATER_CURRENT_VERSION_ID }];
    let completed = 0;
    const { worker, dependencies, wakes } = scheduledWorker({
      maxOperationsPerRun: 1,
      getNextOperation: async () => rows[completed] ?? null,
      claimOperation: async () => ({ ...rows[completed], queue_status: "submitting", attempt_count: 1 }),
      submitRemoteEdit: jest.fn(async (input) => ({ ...remoteResult, transcriptVersionId: input.clientVersionId })),
      completeOperation: async () => { completed += 1; },
      getNextWakeAt: async () => completed < rows.length ? NOW : null,
    });
    expect((await worker.run()).processed).toBe(1);
    expect(dependencies.submitRemoteEdit).toHaveBeenCalledTimes(1);
    expect(wakes).toHaveLength(1); expect(wakes[0].delayMs).toBe(250);
    wakes[0].callback(); await worker.waitForIdle();
    expect(completed).toBe(2); expect(wakes).toHaveLength(1); worker.dispose();
  });

  it("does not turn a timer installation failure after success into a failed run", async () => {
    const { worker, dependencies } = scheduledWorker({
      getNextWakeAt: async () => NOW,
      scheduleWake: () => { throw new Error("Timer unavailable"); },
    });
    expect((await worker.run()).succeeded).toBe(1);
    expect(dependencies.markFailed).not.toHaveBeenCalled(); worker.dispose();
  });
});
