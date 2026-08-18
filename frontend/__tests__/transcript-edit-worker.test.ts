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
    getConnectionState: jest.fn(async () => connectedState()),
    getAuthenticatedUserId: jest.fn(async () => USER_ID),
    isDeletionPending: jest.fn(() => false),
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
    ...overrides,
  };
};

describe("transcript edit outbox worker", () => {
  it("submits one immutable snapshot and completes only that snapshot", async () => {
    const dependencies = makeDependencies();

    const result = await createTranscriptEditWorker(dependencies).run();

    expect(result).toMatchObject({ succeeded: 1, processed: 1 });
    expect(dependencies.resetSubmitting).toHaveBeenCalledWith(USER_ID);
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
    });
    expect(dependencies.notifyChanged).toHaveBeenCalledTimes(1);
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
    );
    expect(dependencies.completeOperation).not.toHaveBeenCalled();
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
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
    expect(dependencies.resetSubmitting).toHaveBeenNthCalledWith(1, USER_ID);
    expect(dependencies.resetSubmitting).toHaveBeenNthCalledWith(2, USER_ID);
  });
});
