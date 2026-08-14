import type { SupabaseClient } from "@supabase/supabase-js";
import type { NetInfoState, NetInfoStateType } from "@react-native-community/netinfo";

import {
  createTranscriptionRequestWorker,
  type TranscriptionRequestWorkerDependencies,
} from "@/src/services/sync/transcription-request-worker";
import type {
  RecordingRecord,
  SessionRecord,
  TranscriptionRequestQueueRow,
} from "@/src/services/sqlite/repository";
import {
  invokeRemoteTranscriptionRequest,
  TranscriptionRequestClientError,
  type RemoteTranscriptionRequestResult,
} from "@/src/services/transcription/request-client";
import {
  buildTranscriptionRequestQueueRow,
  LocalTranscriptionRequestError,
  prepareLocalTranscriptionRequest,
} from "@/src/services/transcription/service";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const RECORDING_ID = "77777777-7777-4777-8777-777777777777";
const QUEUE_ID = "88888888-8888-4888-8888-888888888888";
const JOB_ID = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-08-14T10:00:00.000Z";

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

const session: SessionRecord = {
  id: SESSION_ID,
  workspace_id: WORKSPACE_ID,
  project_id: null,
  created_by: USER_ID,
  title: "Transcription session",
  session_type: "standard",
  status: "recorded",
  started_at: "2026-08-14T09:59:30.000Z",
  stopped_at: NOW,
  total_recorded_duration_ms: 30_000,
  spoken_language_mode: "SINGLE_LANGUAGE",
  expected_spoken_languages: ["en"],
  detected_spoken_languages: [],
  primary_detected_language: null,
  language_detection_status: "NOT_STARTED",
  summary_output_language: null,
  translation_target_language: null,
  transcript_display_mode: "ORIGINAL",
  language_metadata: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  created_at: "2026-08-14T09:59:00.000Z",
  updated_at: NOW,
  deleted_at: null,
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: NOW,
};

const recording: RecordingRecord = {
  id: RECORDING_ID,
  workspace_id: WORKSPACE_ID,
  project_id: null,
  session_id: SESSION_ID,
  local_file_uri: "file:///documents/transcription.m4a",
  private_storage_path: `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/transcription.m4a`,
  mime_type: "audio/mp4",
  original_file_name: "transcription.m4a",
  file_size: 1024,
  duration_ms: 30_000,
  recording_format: "m4a",
  checksum_sha256: null,
  upload_status: "synchronized",
  upload_error_code: null,
  upload_error_message: null,
  created_at: NOW,
  updated_at: NOW,
};

const prepared = prepareLocalTranscriptionRequest({ session, recording });

const queueRow: TranscriptionRequestQueueRow = buildTranscriptionRequestQueueRow({
  prepared,
  userId: USER_ID,
  id: QUEUE_ID,
  now: NOW,
});

const remoteResult: RemoteTranscriptionRequestResult = {
  jobId: JOB_ID,
  status: "queued",
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  recordingId: RECORDING_ID,
  created: true,
  requestId: "request-1",
};

const makeDependencies = (
  overrides: Partial<TranscriptionRequestWorkerDependencies> = {},
): TranscriptionRequestWorkerDependencies => {
  let returned = false;
  return {
    platform: "android",
    getConnectionState: jest.fn(async () => connectedState()),
    getAuthenticatedUserId: jest.fn(async () => USER_ID),
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
    getLocalSession: jest.fn(async () => session),
    getLocalRecording: jest.fn(async () => recording),
    deferOperation: jest.fn(async () => undefined),
    rescheduleOperation: jest.fn(async () => undefined),
    markSubmitted: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
    markCancelled: jest.fn(async () => undefined),
    submitRemoteRequest: jest.fn(async () => remoteResult),
    normalizeRemoteError: jest.fn(async (error: unknown) => {
      if (error instanceof TranscriptionRequestClientError) return error;
      return new TranscriptionRequestClientError(
        "TRANSCRIPTION_REQUEST_FAILED",
        "The transcription request could not be created.",
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

describe("mobile transcription request integration", () => {
  it("can persist local intent before the recording upload finishes", () => {
    const pendingPrepared = prepareLocalTranscriptionRequest({
      session,
      recording: { ...recording, upload_status: "pending" },
    });

    expect(pendingPrepared.idempotencyKey).toBe(prepared.idempotencyKey);
    expect(pendingPrepared.recordingId).toBe(RECORDING_ID);
  });

  it("rejects invalid local media metadata before queueing", () => {
    expect(() =>
      prepareLocalTranscriptionRequest({
        session,
        recording: { ...recording, duration_ms: 0 },
      }),
    ).toThrow(LocalTranscriptionRequestError);
  });

  it("requires a failed recording upload to be retried before queueing", () => {
    expect(() =>
      prepareLocalTranscriptionRequest({
        session,
        recording: { ...recording, upload_status: "failed" },
      }),
    ).toThrow(LocalTranscriptionRequestError);
  });

  it("builds a stable provider-neutral queue record", () => {
    expect(queueRow).toEqual(
      expect.objectContaining({
        id: QUEUE_ID,
        user_id: USER_ID,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        recording_id: RECORDING_ID,
        spoken_language_mode: "SINGLE_LANGUAGE",
        expected_spoken_languages: ["en"],
        queue_status: "pending",
        attempt_count: 0,
        server_job_id: null,
        idempotency_key: prepared.idempotencyKey,
      }),
    );
    expect(prepared.idempotencyKey).toContain(RECORDING_ID);
  });

  it("invokes only transcription-request with the current user session", async () => {
    const invoke = jest.fn(async () => ({ data: remoteResult, error: null }));
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "test-access-token",
              user: { id: USER_ID },
            },
          },
          error: null,
        })),
      },
      functions: { invoke },
    } as unknown as SupabaseClient;

    const result = await invokeRemoteTranscriptionRequest(
      { recordingId: RECORDING_ID, expectedUserId: USER_ID },
      client,
    );

    expect(result).toEqual(remoteResult);
    expect(invoke).toHaveBeenCalledWith("transcription-request", {
      body: { recordingId: RECORDING_ID },
      headers: { Authorization: "Bearer test-access-token" },
    });
  });

  it("does not invoke the function for a different authenticated user", async () => {
    const invoke = jest.fn();
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "test-access-token",
              user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
            },
          },
          error: null,
        })),
      },
      functions: { invoke },
    } as unknown as SupabaseClient;

    await expect(
      invokeRemoteTranscriptionRequest(
        { recordingId: RECORDING_ID, expectedUserId: USER_ID },
        client,
      ),
    ).rejects.toMatchObject({
      code: "TRANSCRIPTION_AUTHENTICATION_REQUIRED",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("submits one queued request and stores the server job id", async () => {
    const dependencies = makeDependencies();
    const worker = createTranscriptionRequestWorker(dependencies);

    const result = await worker.run();

    expect(result.submitted).toBe(1);
    expect(dependencies.resetSubmitting).toHaveBeenCalledWith(USER_ID);
    expect(dependencies.submitRemoteRequest).toHaveBeenCalledWith({
      recordingId: RECORDING_ID,
      expectedUserId: USER_ID,
    });
    expect(dependencies.markSubmitted).toHaveBeenCalledWith(QUEUE_ID, JOB_ID);
    expect(dependencies.notifyChanged).toHaveBeenCalledTimes(1);
  });

  it("accepts an idempotent server response that reuses the existing job", async () => {
    const dependencies = makeDependencies({
      submitRemoteRequest: jest.fn(async () => ({
        ...remoteResult,
        status: "processing" as const,
        created: false,
      })),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.submitted).toBe(1);
    expect(dependencies.markSubmitted).toHaveBeenCalledWith(QUEUE_ID, JOB_ID);
  });

  it("does not treat a terminal remote failed job as submitted", async () => {
    const dependencies = makeDependencies({
      submitRemoteRequest: jest.fn(async () => ({
        ...remoteResult,
        status: "failed" as const,
        created: false,
      })),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.failed).toBe(1);
    expect(dependencies.markFailed).toHaveBeenCalledWith(
      QUEUE_ID,
      "TRANSCRIPTION_REMOTE_JOB_FAILED",
      expect.any(String),
    );
    expect(dependencies.markSubmitted).not.toHaveBeenCalled();
  });

  it("recovers submitting rows before every single-flight run", async () => {
    const dependencies = makeDependencies();
    const worker = createTranscriptionRequestWorker(dependencies);

    await worker.run();
    await worker.run();

    expect(dependencies.resetSubmitting).toHaveBeenCalledTimes(2);
    expect(dependencies.resetSubmitting).toHaveBeenNthCalledWith(1, USER_ID);
    expect(dependencies.resetSubmitting).toHaveBeenNthCalledWith(2, USER_ID);
  });

  it("does not claim local work while offline", async () => {
    const dependencies = makeDependencies({
      getConnectionState: jest.fn(async () => offlineState()),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.state).toBe("offline");
    expect(dependencies.claimOperation).not.toHaveBeenCalled();
  });

  it("waits for a recording upload without consuming retry budget", async () => {
    const dependencies = makeDependencies({
      getLocalRecording: jest.fn(async () => ({
        ...recording,
        upload_status: "pending",
      })),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.deferred).toBe(1);
    expect(dependencies.deferOperation).toHaveBeenCalledWith(
      QUEUE_ID,
      expect.any(String),
      "TRANSCRIPTION_RECORDING_UPLOAD_PENDING",
      expect.any(String),
    );
    expect(dependencies.submitRemoteRequest).not.toHaveBeenCalled();
  });

  it("preserves the local intent while the remote feature kill switch is off", async () => {
    const featureDisabled = new TranscriptionRequestClientError(
      "TRANSCRIPTION_FEATURE_DISABLED",
      "Transcription is temporarily unavailable.",
      { retryable: false, status: 403 },
    );
    const dependencies = makeDependencies({
      submitRemoteRequest: jest.fn(async () => {
        throw featureDisabled;
      }),
      normalizeRemoteError: jest.fn(async () => featureDisabled),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.deferred).toBe(1);
    expect(dependencies.deferOperation).toHaveBeenCalledWith(
      QUEUE_ID,
      expect.any(String),
      "TRANSCRIPTION_FEATURE_DISABLED",
      featureDisabled.message,
    );
    expect(dependencies.markFailed).not.toHaveBeenCalled();
  });

  it("backs off retryable network failures", async () => {
    const networkError = new TranscriptionRequestClientError(
      "NETWORK_UNAVAILABLE",
      "The request will retry when the network is available.",
      { retryable: true },
    );
    const dependencies = makeDependencies({
      submitRemoteRequest: jest.fn(async () => {
        throw networkError;
      }),
      normalizeRemoteError: jest.fn(async () => networkError),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.retried).toBe(1);
    expect(dependencies.rescheduleOperation).toHaveBeenCalledWith(
      QUEUE_ID,
      expect.any(String),
      "NETWORK_UNAVAILABLE",
      networkError.message,
    );
  });

  it("stops retrying after the bounded attempt budget is exhausted", async () => {
    const networkError = new TranscriptionRequestClientError(
      "NETWORK_UNAVAILABLE",
      "Network unavailable.",
      { retryable: true },
    );
    const dependencies = makeDependencies({
      claimOperation: jest.fn(async () => ({
        ...queueRow,
        queue_status: "submitting" as const,
        attempt_count: 5,
      })),
      submitRemoteRequest: jest.fn(async () => {
        throw networkError;
      }),
      normalizeRemoteError: jest.fn(async () => networkError),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.failed).toBe(1);
    expect(dependencies.markFailed).toHaveBeenCalledWith(
      QUEUE_ID,
      "NETWORK_UNAVAILABLE",
      networkError.message,
    );
    expect(dependencies.rescheduleOperation).not.toHaveBeenCalled();
  });

  it("fails safely if the server returns a different recording scope", async () => {
    const dependencies = makeDependencies({
      submitRemoteRequest: jest.fn(async () => ({
        ...remoteResult,
        recordingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      })),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.failed).toBe(1);
    expect(dependencies.markFailed).toHaveBeenCalledWith(
      QUEUE_ID,
      "TRANSCRIPTION_RESPONSE_SCOPE_MISMATCH",
      expect.any(String),
    );
    expect(dependencies.markSubmitted).not.toHaveBeenCalled();
  });

  it("cancels requests when their local session has been deleted", async () => {
    const dependencies = makeDependencies({
      getLocalSession: jest.fn(async () => ({ ...session, deleted_at: NOW })),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.cancelled).toBe(1);
    expect(dependencies.markCancelled).toHaveBeenCalledWith(
      QUEUE_ID,
      "TRANSCRIPTION_SESSION_UNAVAILABLE",
      expect.any(String),
    );
    expect(dependencies.submitRemoteRequest).not.toHaveBeenCalled();
  });

  it("does not submit a queue row owned by another authenticated user", async () => {
    const dependencies = makeDependencies({
      claimOperation: jest.fn(async () => ({
        ...queueRow,
        user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        queue_status: "submitting" as const,
        attempt_count: 1,
      })),
    });

    const result = await createTranscriptionRequestWorker(dependencies).run();

    expect(result.failed).toBe(1);
    expect(dependencies.markFailed).toHaveBeenCalledWith(
      QUEUE_ID,
      "TRANSCRIPTION_REQUEST_USER_MISMATCH",
      expect.any(String),
    );
    expect(dependencies.submitRemoteRequest).not.toHaveBeenCalled();
  });
});
