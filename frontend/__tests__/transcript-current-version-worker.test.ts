import type {
  NetInfoState,
  NetInfoStateType,
} from "@react-native-community/netinfo";

import type { TranscriptCurrentVersionSyncTarget } from "@/src/services/sqlite/repository";
import {
  createTranscriptCurrentVersionWorker,
  type TranscriptCurrentVersionWorkerDependencies,
} from "@/src/services/sync/transcript-current-version-worker";
import { CurrentTranscriptVersionClientError } from "@/src/services/transcription/current-version-client";
import type { CurrentTranscriptVersionSnapshot } from "@/src/services/transcription/result-types";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-20T00:00:00.000Z";

const target: TranscriptCurrentVersionSyncTarget = {
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
};

const readySnapshot: Extract<
  CurrentTranscriptVersionSnapshot,
  { kind: "ready" }
> = {
  kind: "ready",
  currentVersion: {
    id: VERSION_ID,
    workspace_id: WORKSPACE_ID,
    session_id: SESSION_ID,
    transcription_run_id: null,
    created_by: USER_ID,
    version: 2,
    version_origin: "user_edit",
    version_status: "final",
    parent_version_id: null,
    plain_text: "cross-device edit",
    language_summary: {},
    content_checksum_sha256: "a".repeat(64),
    is_current: true,
    created_at: NOW,
    updated_at: NOW,
  },
  currentSegments: [],
  intermediateVersions: [],
  evidenceVersion: null,
  evidenceSegments: [],
};

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

const makeDependencies = (
  overrides: Partial<TranscriptCurrentVersionWorkerDependencies> = {},
): TranscriptCurrentVersionWorkerDependencies => ({
  platform: "android",
  getConnectionState: jest.fn(async () => connectedState()),
  getAuthenticatedUserId: jest.fn(async () => USER_ID),
  isDeletionPending: jest.fn(() => false),
  listTargets: jest.fn(async () => [target]),
  fetchRemoteSnapshot: jest.fn(async () => readySnapshot),
  persistSnapshot: jest.fn(async () => undefined),
  normalizeRemoteError: jest.fn((error: unknown) => {
    if (error instanceof CurrentTranscriptVersionClientError) return error;
    return new CurrentTranscriptVersionClientError(
      "TRANSCRIPT_CURRENT_QUERY_FAILED",
      "The current transcript could not be synchronized yet.",
      { retryable: true, cause: error },
    );
  }),
  now: jest.fn(() => new Date(NOW)),
  random: jest.fn(() => 0.5),
  maxTargetsPerPass: 25,
  scheduleWake: jest.fn(
    (_callback: () => void, _delayMs: number) =>
      1 as unknown as ReturnType<typeof setTimeout>,
  ),
  clearWake: jest.fn(),
  notifyChanged: jest.fn(),
  ...overrides,
});

describe("generic current transcript version worker", () => {
  it("discovers local session targets and persists a remote current snapshot", async () => {
    const dependencies = makeDependencies();
    const worker = createTranscriptCurrentVersionWorker(dependencies);

    const result = await worker.run();

    expect(result).toMatchObject({
      state: "completed",
      processed: 1,
      synchronized: 1,
      empty: 0,
      retried: 0,
      failed: 0,
    });
    expect(dependencies.listTargets).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchRemoteSnapshot).toHaveBeenCalledWith({
      target,
      expectedUserId: USER_ID,
    });
    expect(dependencies.persistSnapshot).toHaveBeenCalledWith(readySnapshot);
    expect(dependencies.notifyChanged).toHaveBeenCalledTimes(1);
  });

  it("supports an explicit edit-success target without scanning every session", async () => {
    const dependencies = makeDependencies();
    const worker = createTranscriptCurrentVersionWorker(dependencies);

    const result = await worker.run(target);

    expect(result.synchronized).toBe(1);
    expect(dependencies.listTargets).not.toHaveBeenCalled();
    expect(dependencies.fetchRemoteSnapshot).toHaveBeenCalledWith({
      target,
      expectedUserId: USER_ID,
    });
  });

  it("keeps the offline cache intact when the server has no current transcript", async () => {
    const emptySnapshot: CurrentTranscriptVersionSnapshot = {
      kind: "empty",
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    };
    const dependencies = makeDependencies({
      fetchRemoteSnapshot: jest.fn(async () => emptySnapshot),
    });

    const result = await createTranscriptCurrentVersionWorker(
      dependencies,
    ).run();

    expect(result.empty).toBe(1);
    expect(result.synchronized).toBe(0);
    expect(dependencies.persistSnapshot).not.toHaveBeenCalled();
    expect(dependencies.notifyChanged).not.toHaveBeenCalled();
  });

  it("does no remote work while offline", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async () => offlineState()),
    });

    const result = await createTranscriptCurrentVersionWorker(
      dependencies,
    ).run();

    expect(result.state).toBe("offline");
    expect(dependencies.listTargets).not.toHaveBeenCalled();
    expect(dependencies.fetchRemoteSnapshot).not.toHaveBeenCalled();
  });

  it("does no remote work without an authenticated user", async () => {
    const dependencies = makeDependencies({
      getAuthenticatedUserId: jest.fn(async () => null),
    });

    const result = await createTranscriptCurrentVersionWorker(
      dependencies,
    ).run();

    expect(result.state).toBe("authentication_required");
    expect(dependencies.listTargets).not.toHaveBeenCalled();
    expect(dependencies.fetchRemoteSnapshot).not.toHaveBeenCalled();
  });

  it("retries a transient remote read with bounded backoff and no local mutation", async () => {
    const retryable = new CurrentTranscriptVersionClientError(
      "NETWORK_UNAVAILABLE",
      "The current transcript will retry when the network is available.",
      { retryable: true },
    );
    const dependencies = makeDependencies({
      fetchRemoteSnapshot: jest.fn(async () => {
        throw retryable;
      }),
      normalizeRemoteError: jest.fn(() => retryable),
    });
    const worker = createTranscriptCurrentVersionWorker(dependencies);

    const result = await worker.run(target);

    expect(result.retried).toBe(1);
    expect(dependencies.persistSnapshot).not.toHaveBeenCalled();
    expect(dependencies.scheduleWake).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Number),
    );
    worker.dispose();
  });

  it("preserves a target when authentication expires during the remote read", async () => {
    const authError = new CurrentTranscriptVersionClientError(
      "TRANSCRIPT_CURRENT_AUTHENTICATION_REQUIRED",
      "Sign in again before synchronizing the current transcript.",
      { retryable: true },
    );
    const dependencies = makeDependencies({
      fetchRemoteSnapshot: jest.fn(async () => {
        throw authError;
      }),
      normalizeRemoteError: jest.fn(() => authError),
    });
    const worker = createTranscriptCurrentVersionWorker(dependencies);

    const result = await worker.run(target);

    expect(result.state).toBe("authentication_required");
    expect(dependencies.persistSnapshot).not.toHaveBeenCalled();
    expect(dependencies.scheduleWake).not.toHaveBeenCalled();
    worker.dispose();
  });

  it("rechecks account-deletion quiescence after an in-flight authenticated read", async () => {
    let checks = 0;
    const dependencies = makeDependencies({
      isDeletionPending: jest.fn(() => {
        checks += 1;
        return checks >= 3;
      }),
    });
    const worker = createTranscriptCurrentVersionWorker(dependencies);

    const result = await worker.run(target);

    expect(result.processed).toBe(1);
    expect(dependencies.fetchRemoteSnapshot).toHaveBeenCalledTimes(1);
    expect(dependencies.persistSnapshot).not.toHaveBeenCalled();
    expect(dependencies.notifyChanged).not.toHaveBeenCalled();
    worker.dispose();
  });

  it("preserves a full-scan wake requested while discovery is in flight", async () => {
    let markDiscoveryStarted!: () => void;
    let releaseDiscovery!: () => void;
    const scheduledContinuations: (() => void)[] = [];
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    const blockedDiscovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const listTargets = jest.fn(
      async (): Promise<TranscriptCurrentVersionSyncTarget[]> => [],
    );
    listTargets.mockImplementationOnce(async () => {
      markDiscoveryStarted();
      await blockedDiscovery;
      return [target];
    });
    const dependencies = makeDependencies({
      listTargets,
      scheduleWake: jest.fn((callback: () => void) => {
        scheduledContinuations.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
    });
    const worker = createTranscriptCurrentVersionWorker(dependencies);

    const first = worker.run();
    await discoveryStarted;
    const second = worker.run();
    expect(second).toBe(first);

    releaseDiscovery();
    await first;

    expect(dependencies.scheduleWake).toHaveBeenCalledTimes(1);
    expect(scheduledContinuations).toHaveLength(1);
    scheduledContinuations[0]?.();
    await worker.waitForIdle();

    expect(listTargets).toHaveBeenCalledTimes(2);
    worker.dispose();
  });

  it("replays a wake requested while an earlier pass exits offline", async () => {
    let markConnectionStarted!: () => void;
    let releaseConnection!: () => void;
    const scheduledContinuations: (() => void)[] = [];
    const connectionStarted = new Promise<void>((resolve) => {
      markConnectionStarted = resolve;
    });
    const blockedConnection = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    const getConnectionState = jest.fn(async () => connectedState());
    getConnectionState.mockImplementationOnce(async () => {
      markConnectionStarted();
      await blockedConnection;
      return offlineState();
    });
    const dependencies = makeDependencies({
      getConnectionState,
      scheduleWake: jest.fn((callback: () => void) => {
        scheduledContinuations.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
    });
    const worker = createTranscriptCurrentVersionWorker(dependencies);

    const first = worker.run(target);
    await connectionStarted;
    const second = worker.run(target);
    expect(second).toBe(first);

    releaseConnection();
    const firstResult = await first;

    expect(firstResult.state).toBe("offline");
    expect(dependencies.fetchRemoteSnapshot).not.toHaveBeenCalled();
    expect(dependencies.scheduleWake).toHaveBeenCalledTimes(1);
    expect(scheduledContinuations).toHaveLength(1);

    scheduledContinuations[0]?.();
    await worker.waitForIdle();

    expect(getConnectionState).toHaveBeenCalledTimes(2);
    expect(dependencies.fetchRemoteSnapshot).toHaveBeenCalledTimes(1);
    expect(dependencies.persistSnapshot).toHaveBeenCalledTimes(1);
    worker.dispose();
  });

  it("coalesces concurrent runs into one remote pass", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependencies = makeDependencies({
      fetchRemoteSnapshot: jest.fn(async () => {
        await blocked;
        return readySnapshot;
      }),
    });
    const worker = createTranscriptCurrentVersionWorker(dependencies);

    const first = worker.run(target);
    const second = worker.run(target);
    expect(first).toBe(second);
    release();

    await first;
    expect(dependencies.fetchRemoteSnapshot).toHaveBeenCalledTimes(1);
    worker.dispose();
  });
});
