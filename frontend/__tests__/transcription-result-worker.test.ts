import type { NetInfoState } from "@react-native-community/netinfo";

import {
  createTranscriptionResultWorker,
  type TranscriptionResultWorkerDependencies,
} from "@/src/services/sync/transcription-result-worker";
import { TranscriptionResultClientError } from "@/src/services/transcription/result-client";
import {
  TranscriptionResultReconciliationError,
} from "@/src/services/transcription/result-reconciliation";
import type {
  SyncedProcessingJob,
  SyncedTranscriptSegment,
  SyncedTranscriptVersion,
  SyncedTranscriptionRun,
} from "@/src/services/transcription/result-types";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const RECORDING_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const SEGMENT_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-08-15T00:00:00.000Z");

const queueRow = {
  id: "99999999-9999-4999-8999-999999999999",
  user_id: USER_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  recording_id: RECORDING_ID,
  spoken_language_mode: "AUTO_DETECT",
  expected_spoken_languages: [],
  queue_status: "submitted" as const,
  attempt_count: 0,
  max_attempts: 5,
  next_retry_at: null,
  server_job_id: JOB_ID,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: "batch-transcription:test",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const syncWorkItem = {
  kind: "sync" as const,
  request: queueRow,
};

const job: SyncedProcessingJob = {
  id: JOB_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  recording_id: RECORDING_ID,
  created_by: USER_ID,
  job_type: "batch_transcription",
  status: "succeeded",
  idempotency_key: "batch-transcription:test",
  priority: 100,
  attempt_count: 1,
  max_attempts: 5,
  next_attempt_at: null,
  lease_owner: null,
  lease_expires_at: null,
  started_at: NOW.toISOString(),
  completed_at: NOW.toISOString(),
  cancelled_at: null,
  last_error_code: null,
  last_safe_error: null,
  request_payload: {},
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const run: SyncedTranscriptionRun = {
  id: RUN_ID,
  processing_job_id: JOB_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  recording_id: RECORDING_ID,
  created_by: USER_ID,
  run_attempt: 1,
  provider_key: "assemblyai",
  provider_model: "universal-2",
  request_mode: "AUTO_DETECT",
  requested_languages: [],
  status: "succeeded",
  provider_artifact_present: true,
  provider_cleanup_status: "succeeded",
  detected_languages: ["en"],
  primary_detected_language: "en",
  language_detection_status: "DETECTED",
  started_at: NOW.toISOString(),
  completed_at: NOW.toISOString(),
  last_error_code: null,
  last_safe_error: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const version: SyncedTranscriptVersion = {
  id: VERSION_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcription_run_id: RUN_ID,
  created_by: USER_ID,
  version: 1,
  version_origin: "provider",
  version_status: "final",
  parent_version_id: null,
  plain_text: "Hello world.",
  language_summary: { primaryLanguage: "en" },
  content_checksum_sha256: "a".repeat(64),
  is_current: true,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const segment: SyncedTranscriptSegment = {
  id: SEGMENT_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcript_version_id: VERSION_ID,
  segment_index: 0,
  start_ms: 0,
  end_ms: 1000,
  text: "Hello world.",
  language_code: "en",
  speaker_label: null,
  confidence: 0.99,
  provider_segment_id: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const online = {
  isConnected: true,
  isInternetReachable: true,
} as NetInfoState;

const dependencies = (): TranscriptionResultWorkerDependencies => ({
  platform: "android",
  getConnectionState: jest.fn(async () => online),
  getAuthenticatedUserId: jest.fn(async () => USER_ID),
  getNextOperation: jest
    .fn()
    .mockResolvedValueOnce(syncWorkItem)
    .mockResolvedValueOnce(null),
  getNextWakeAt: jest.fn(async () => null),
  fetchRemoteResult: jest.fn(async () => ({
    kind: "succeeded" as const,
    job,
    run,
    version,
    segments: [segment],
    expectedSegmentCount: 1,
  })),
  persistProgress: jest.fn(async () => undefined),
  persistCompleted: jest.fn(async () => undefined),
  persistTerminal: jest.fn(async () => undefined),
  rescheduleFailure: jest.fn(async () => undefined),
  markFailed: jest.fn(async () => undefined),
  markCancelled: jest.fn(async () => undefined),
  normalizeError: (error) =>
    error instanceof TranscriptionResultClientError
      ? error
      : new TranscriptionResultClientError(
          "TRANSCRIPTION_RESULT_QUERY_FAILED",
          "retry",
          { retryable: true, cause: error },
        ),
  now: () => NOW,
  random: () => 0.5,
  maxOperationsPerRun: 5,
  notifyChanged: jest.fn(),
  schedule: jest.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
  clearScheduled: jest.fn(),
});

describe("mobile transcription result worker", () => {
  it("skips remote work while offline", async () => {
    const deps = dependencies();
    deps.getConnectionState = jest.fn(async () => ({
      isConnected: false,
      isInternetReachable: false,
    }) as NetInfoState);
    const result = await createTranscriptionResultWorker(deps).run();
    expect(result.state).toBe("offline");
    expect(deps.fetchRemoteResult).not.toHaveBeenCalled();
  });

  it("rejects an invalid receipt locally without another remote read", async () => {
    const deps = dependencies();
    deps.getNextOperation = jest
      .fn()
      .mockResolvedValueOnce({
        kind: "reject" as const,
        request: queueRow,
        errorCode: "TRANSCRIPTION_RESULT_RECEIPT_INVALID" as const,
        safeError: "The local transcript completion receipt is invalid.",
      })
      .mockResolvedValueOnce(null);

    const result = await createTranscriptionResultWorker(deps).run();

    expect(result.failed).toBe(1);
    expect(deps.markFailed).toHaveBeenCalledWith(
      queueRow.id,
      "TRANSCRIPTION_RESULT_RECEIPT_INVALID",
      "The local transcript completion receipt is invalid.",
    );
    expect(deps.fetchRemoteResult).not.toHaveBeenCalled();
    expect(deps.persistCompleted).not.toHaveBeenCalled();
  });

  it("atomically persists a completed current transcript", async () => {
    const deps = dependencies();
    const result = await createTranscriptionResultWorker(deps).run();
    expect(result.synchronized).toBe(1);
    expect(deps.persistCompleted).toHaveBeenCalledWith({
      userId: USER_ID,
      queueId: queueRow.id,
      job,
      run,
      version,
      segments: [segment],
      expectedSegmentCount: 1,
      reconciledAt: NOW.toISOString(),
    });
    expect(deps.notifyChanged).toHaveBeenCalledTimes(1);
  });

  it("persists server progress and schedules another durable poll", async () => {
    const deps = dependencies();
    deps.fetchRemoteResult = jest.fn(async () => ({
      kind: "pending" as const,
      reason: "cleanup" as const,
      job,
      run: { ...run, provider_cleanup_status: "pending" },
    }));
    deps.getNextWakeAt = jest.fn(async () => "2026-08-15T00:00:10.000Z");
    const worker = createTranscriptionResultWorker(deps);
    const result = await worker.run();
    expect(result.pending).toBe(1);
    expect(deps.persistProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        queueId: queueRow.id,
        nextRetryAt: "2026-08-15T00:00:10.000Z",
        errorCode: "TRANSCRIPTION_RESULT_CLEANUP_PENDING",
      }),
    );
    expect(deps.schedule).toHaveBeenCalledWith(expect.any(Function), 10_000);
    worker.dispose();
  });

  it("fails closed on a cross-recording result", async () => {
    const deps = dependencies();
    deps.fetchRemoteResult = jest.fn(async () => ({
      kind: "succeeded" as const,
      job: { ...job, recording_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      run,
      version,
      segments: [segment],
      expectedSegmentCount: 1,
    }));
    const result = await createTranscriptionResultWorker(deps).run();
    expect(result.failed).toBe(1);
    expect(deps.markFailed).toHaveBeenCalledWith(
      queueRow.id,
      "TRANSCRIPTION_RESULT_SCOPE_MISMATCH",
      expect.any(String),
    );
    expect(deps.persistCompleted).not.toHaveBeenCalled();
  });

  it("retries a transport failure without discarding submitted intent", async () => {
    const deps = dependencies();
    deps.fetchRemoteResult = jest.fn(async () => {
      throw new TypeError("Network request failed");
    });
    const result = await createTranscriptionResultWorker(deps).run();
    expect(result.retried).toBe(1);
    expect(deps.rescheduleFailure).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: queueRow.id }),
    );
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("cancels a local poll anchor that is no longer visible under RLS", async () => {
    const deps = dependencies();
    deps.fetchRemoteResult = jest.fn(async () => {
      throw new TranscriptionResultClientError(
        "TRANSCRIPTION_RESULT_NOT_FOUND",
        "not found",
        { retryable: false },
      );
    });
    const result = await createTranscriptionResultWorker(deps).run();
    expect(result.cancelled).toBe(1);
    expect(deps.markCancelled).toHaveBeenCalledWith(
      queueRow.id,
      "TRANSCRIPTION_RESULT_NOT_FOUND",
      "not found",
    );
  });

  it("fails a permanent local evidence conflict without an endless retry", async () => {
    const deps = dependencies();
    deps.persistCompleted = jest.fn(async () => {
      throw new TranscriptionResultReconciliationError(
        "RESULT_RECONCILIATION_CONFLICT",
      );
    });
    const result = await createTranscriptionResultWorker(deps).run();
    expect(result.failed).toBe(1);
    expect(deps.markFailed).toHaveBeenCalledWith(
      queueRow.id,
      "RESULT_RECONCILIATION_CONFLICT",
      "The completed transcript conflicts with existing local evidence.",
    );
    expect(deps.rescheduleFailure).not.toHaveBeenCalled();
  });

  it("retries temporary local write recovery without discarding the request", async () => {
    const deps = dependencies();
    deps.persistCompleted = jest.fn(async () => {
      throw new TranscriptionResultReconciliationError(
        "RESULT_RECONCILIATION_WRITE_RETRYABLE",
      );
    });
    const result = await createTranscriptionResultWorker(deps).run();
    expect(result.retried).toBe(1);
    expect(deps.rescheduleFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        queueId: queueRow.id,
        errorCode: "RESULT_RECONCILIATION_WRITE_RETRYABLE",
      }),
    );
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("cancels a result whose local session was removed during the read", async () => {
    const deps = dependencies();
    deps.persistCompleted = jest.fn(async () => {
      throw new TranscriptionResultReconciliationError(
        "RESULT_RECONCILIATION_SESSION_UNAVAILABLE",
      );
    });
    const result = await createTranscriptionResultWorker(deps).run();
    expect(result.cancelled).toBe(1);
    expect(deps.markCancelled).toHaveBeenCalledWith(
      queueRow.id,
      "RESULT_RECONCILIATION_SESSION_UNAVAILABLE",
      "The local session is no longer available for this transcript.",
    );
  });

  it("returns one promise for concurrent runs", async () => {
    const deps = dependencies();
    let release!: () => void;
    deps.getConnectionState = jest.fn(
      () => new Promise<NetInfoState>((resolve) => {
        release = () => resolve(online);
      }),
    );
    const worker = createTranscriptionResultWorker(deps);
    const first = worker.run();
    const second = worker.run();
    expect(first).toBe(second);
    release();
    await first;
  });
});
