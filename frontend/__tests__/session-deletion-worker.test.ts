import type {
  NetInfoState,
  NetInfoStateType,
} from "@react-native-community/netinfo";

import type { SessionDeletionQueueRow } from "@/src/services/sqlite/repository";
import { ProjectSyncError } from "@/src/services/supabase/project-repository";
import {
  createSessionDeletionWorker,
  type SessionDeletionWorkerDependencies,
} from "@/src/services/sync/session-deletion-worker";

const userId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "55555555-5555-4555-8555-555555555555";

const connectedWifiState = (): NetInfoState => ({
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

const deletionRow: SessionDeletionQueueRow = {
  id: `session-delete:${sessionId}`,
  user_id: userId,
  workspace_id: workspaceId,
  session_id: sessionId,
  queue_status: "pending",
  attempt_count: 0,
  next_retry_at: null,
  storage_paths: [`${workspaceId}/${sessionId}/recording/audio.m4a`],
  local_file_uris: ["file:///documents/audio.m4a"],
  storage_deleted: false,
  cloud_metadata_deleted: false,
  local_files_deleted: false,
  last_error_code: null,
  last_safe_error: null,
  created_at: "2026-07-30T10:00:00.000Z",
  updated_at: "2026-07-30T10:00:00.000Z",
};

const makeDependencies = (
  overrides: Partial<SessionDeletionWorkerDependencies> = {},
): SessionDeletionWorkerDependencies => {
  let returned = false;
  return {
    platform: "android",
    getConnectionState: jest.fn(
      async (): Promise<NetInfoState> => connectedWifiState(),
    ),
    getAuthenticatedUserId: jest.fn(async () => userId),
    resetInProgress: jest.fn(async () => 0),
    getNextOperation: jest.fn(async () => {
      if (returned) return null;
      returned = true;
      return deletionRow;
    }),
    claimOperation: jest.fn(
      async (): Promise<SessionDeletionQueueRow | null> => ({
        ...deletionRow,
        queue_status: "in_progress",
        attempt_count: 1,
      }),
    ),
    discoverStoragePaths: jest.fn(async () => [
      `${workspaceId}/${sessionId}/evidence/photo.jpg`,
    ]),
    removeStoragePaths: jest.fn(async () => undefined),
    deleteCloudSession: jest.fn(async () => undefined),
    discoverLocalFileUris: jest.fn(async () => [
      "file:///documents/photo.jpg",
    ]),
    deleteLocalFiles: jest.fn(async () => undefined),
    hardDeleteLocalData: jest.fn(async () => undefined),
    updateProgress: jest.fn(async () => undefined),
    rescheduleOperation: jest.fn(async () => undefined),
    markOperationFailed: jest.fn(async () => undefined),
    deleteCompletedOperation: jest.fn(async () => undefined),
    now: jest.fn(() => new Date("2026-07-30T10:01:00.000Z")),
    random: jest.fn(() => 0.5),
    maxOperationsPerRun: 10,
    maxAttempts: 8,
    notifyChanged: jest.fn(),
    ...overrides,
  };
};

describe("session deletion worker", () => {
  it("deletes Storage, cloud metadata, local files, and local rows in order", async () => {
    const calls: string[] = [];
    const dependencies = makeDependencies({
      removeStoragePaths: jest.fn(async () => {
        calls.push("storage");
      }),
      deleteCloudSession: jest.fn(async () => {
        calls.push("cloud");
      }),
      deleteLocalFiles: jest.fn(async () => {
        calls.push("files");
      }),
      hardDeleteLocalData: jest.fn(async () => {
        calls.push("local");
      }),
      deleteCompletedOperation: jest.fn(async () => {
        calls.push("queue");
      }),
    });
    const worker = createSessionDeletionWorker(dependencies);

    const result = await worker.run();

    expect(result.deleted).toBe(1);
    expect(calls).toEqual(["storage", "cloud", "files", "local", "queue"]);
    expect(dependencies.removeStoragePaths).toHaveBeenCalledWith([
      `${workspaceId}/${sessionId}/recording/audio.m4a`,
      `${workspaceId}/${sessionId}/evidence/photo.jpg`,
    ]);
    expect(dependencies.deleteLocalFiles).toHaveBeenCalledWith(
      ["file:///documents/audio.m4a", "file:///documents/photo.jpg"],
      sessionId,
    );
  });

  it("does not claim deletion work while offline", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(
        async (): Promise<NetInfoState> => offlineState(),
      ),
    });
    const worker = createSessionDeletionWorker(dependencies);

    const result = await worker.run();

    expect(result.state).toBe("offline");
    expect(dependencies.claimOperation).not.toHaveBeenCalled();
  });

  it("marks work owned by another user as failed", async () => {
    const dependencies = makeDependencies({
      claimOperation: jest.fn(async () => ({
        ...deletionRow,
        user_id: "99999999-9999-4999-8999-999999999999",
        queue_status: "in_progress" as const,
        attempt_count: 1,
      })),
    });
    const worker = createSessionDeletionWorker(dependencies);

    const result = await worker.run();

    expect(result.failed).toBe(1);
    expect(dependencies.markOperationFailed).toHaveBeenCalledWith(
      deletionRow.id,
      "DELETE_USER_MISMATCH",
      expect.stringContaining("another signed-in user"),
    );
    expect(dependencies.removeStoragePaths).not.toHaveBeenCalled();
  });

  it("reschedules a retryable network failure", async () => {
    const dependencies = makeDependencies({
      removeStoragePaths: jest.fn(async () => {
        throw new ProjectSyncError(
          "NETWORK_UNAVAILABLE",
          "The connection is unavailable.",
          { retryable: true },
        );
      }),
    });
    const worker = createSessionDeletionWorker(dependencies);

    const result = await worker.run();

    expect(result.retried).toBe(1);
    expect(dependencies.rescheduleOperation).toHaveBeenCalledWith(
      deletionRow.id,
      expect.any(String),
      "NETWORK_UNAVAILABLE",
      "The connection is unavailable.",
    );
  });

  it("does not automatically retry a permanent access error", async () => {
    const dependencies = makeDependencies({
      removeStoragePaths: jest.fn(async () => {
        throw new ProjectSyncError(
          "REMOTE_ACCESS_DENIED",
          "The deletion is not permitted.",
          { retryable: false, status: 403 },
        );
      }),
    });
    const worker = createSessionDeletionWorker(dependencies);

    const result = await worker.run();

    expect(result.failed).toBe(1);
    expect(dependencies.markOperationFailed).toHaveBeenCalledWith(
      deletionRow.id,
      "REMOTE_ACCESS_DENIED",
      "The deletion is not permitted.",
    );
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
  });

  it("resumes after Storage cleanup without deleting Storage twice", async () => {
    const dependencies = makeDependencies({
      claimOperation: jest.fn(async () => ({
        ...deletionRow,
        queue_status: "in_progress" as const,
        attempt_count: 2,
        storage_deleted: true,
      })),
    });
    const worker = createSessionDeletionWorker(dependencies);

    const result = await worker.run();

    expect(result.deleted).toBe(1);
    expect(dependencies.removeStoragePaths).not.toHaveBeenCalled();
    expect(dependencies.deleteCloudSession).toHaveBeenCalledTimes(1);
  });

  it("returns one shared run while cleanup is already active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependencies = makeDependencies({
      removeStoragePaths: jest.fn(() => gate),
    });
    const worker = createSessionDeletionWorker(dependencies);

    const first = worker.run();
    const second = worker.run();

    expect(first).toBe(second);
    release();
    await first;
    expect(dependencies.removeStoragePaths).toHaveBeenCalledTimes(1);
  });
});
