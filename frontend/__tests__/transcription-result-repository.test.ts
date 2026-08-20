import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
  getNextEligibleTranscriptionResultRequest,
  persistCompletedTranscriptionResult,
  persistTranscriptionResultProgress,
} from "@/src/services/sqlite/repository";
import type {
  SyncedProcessingJob,
  SyncedTranscriptSegment,
  SyncedTranscriptVersion,
  SyncedTranscriptionRun,
} from "@/src/services/transcription/result-types";

jest.mock("@/src/services/sqlite/schema", () => ({ openLocalDb: jest.fn() }));
jest.mock("@/src/services/sqlite/transaction", () => ({
  runSerializedLocalTransaction: jest.fn(
    async (_db: unknown, operation: () => Promise<void>) => operation(),
  ),
}));

const mockedOpen = openLocalDb as jest.MockedFunction<typeof openLocalDb>;
const mockedTransaction = runSerializedLocalTransaction as jest.MockedFunction<
  typeof runSerializedLocalTransaction
>;
const ids = Array.from({ length: 8 }, (_, index) =>
  `${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}-${index + 1}${index + 1}${index + 1}${index + 1}-4${index + 1}${index + 1}${index + 1}-8${index + 1}${index + 1}${index + 1}-${String(index + 1).repeat(12)}`,
);
const now = "2026-08-15T00:00:00.000Z";

const job: SyncedProcessingJob = {
  id: ids[0], workspace_id: ids[1], session_id: ids[2], recording_id: ids[3],
  created_by: ids[4], job_type: "batch_transcription", status: "succeeded",
  idempotency_key: "key", priority: 100, attempt_count: 1, max_attempts: 5,
  next_attempt_at: null, lease_owner: null, lease_expires_at: null,
  started_at: now, completed_at: now, cancelled_at: null, last_error_code: null,
  last_safe_error: null, request_payload: {}, created_at: now, updated_at: now,
};
const run: SyncedTranscriptionRun = {
  id: ids[5], processing_job_id: job.id, workspace_id: job.workspace_id,
  session_id: job.session_id, recording_id: job.recording_id, created_by: ids[4],
  run_attempt: 1, provider_key: "assemblyai", provider_model: "universal-2",
  request_mode: "AUTO_DETECT", requested_languages: [], status: "succeeded",
  provider_artifact_present: true, provider_cleanup_status: "succeeded",
  detected_languages: ["en"], primary_detected_language: "en",
  language_detection_status: "DETECTED", started_at: now, completed_at: now,
  last_error_code: null, last_safe_error: null, created_at: now, updated_at: now,
};
const version: SyncedTranscriptVersion = {
  id: ids[6], workspace_id: job.workspace_id, session_id: job.session_id,
  transcription_run_id: run.id, created_by: ids[4], version: 1,
  version_origin: "provider", version_status: "final", parent_version_id: null,
  plain_text: "hello", language_summary: {}, content_checksum_sha256: "a".repeat(64),
  is_current: true, created_at: now, updated_at: now,
};
const segment: SyncedTranscriptSegment = {
  id: ids[7], workspace_id: job.workspace_id, session_id: job.session_id,
  transcript_version_id: version.id, segment_index: 0, start_ms: 0, end_ms: 100,
  text: "hello", language_code: "en", speaker_label: null, confidence: 0.9,
  provider_segment_id: null, created_at: now, updated_at: now,
};

describe("SQLite transcription result persistence", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ingests job, run, current version and segments in one transaction", async () => {
    const statements: string[] = [];
    const db = {
      getFirstAsync: jest.fn(async () => ({ id: "queue" })),
      runAsync: jest.fn(async (sql: string) => {
        statements.push(sql);
        return { changes: 1 };
      }),
    };
    mockedOpen.mockResolvedValue(db as never);

    await persistCompletedTranscriptionResult({
      queueId: "queue",
      job,
      run,
      version,
      segments: [segment],
    });

    expect(mockedTransaction).toHaveBeenCalledWith(db, expect.any(Function));
    const sql = statements.join("\n");
    expect(sql).toContain("INSERT INTO local_processing_jobs");
    expect(sql).toContain("INSERT INTO local_transcription_runs");
    expect(sql).toContain("SET is_current = 0");
    expect(sql).toContain("INSERT INTO local_transcript_versions");
    expect(sql).toContain("DELETE FROM local_transcript_segments");
    expect(sql).toContain("INSERT INTO local_transcript_segments");
    expect(sql).toContain("UPDATE local_transcription_request_queue");
    expect(sql.indexOf("SET is_current = 0")).toBeLessThan(
      sql.indexOf("INSERT INTO local_transcript_versions"),
    );
  });

  it("keeps a cached final provider result complete after current switches to an edit", async () => {
    const getFirstAsync = jest.fn(
      async (_sql: string, _params?: unknown[]) => null,
    );
    mockedOpen.mockResolvedValue({ getFirstAsync } as never);

    await getNextEligibleTranscriptionResultRequest(ids[4], now);

    expect(getFirstAsync).toHaveBeenCalledTimes(1);
    const sql = String(getFirstAsync.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("result_version.version_origin = 'provider'");
    expect(sql).toContain("result_version.version_status = 'final'");
    expect(sql).not.toContain("result_version.is_current = 1");
    expect(getFirstAsync).toHaveBeenCalledWith(expect.any(String), [
      ids[4],
      now,
    ]);
  });

  it("does not let an in-flight provider result downgrade a newer local edit", async () => {
    const newerVersionId = "99999999-9999-4999-8999-999999999999";
    const statements: string[] = [];
    let providerVersionParams: unknown[] | undefined;
    const getFirstAsync = jest.fn(async (sql: string) => {
      if (sql.includes("local_transcription_request_queue")) {
        return { id: "queue" };
      }
      if (sql.includes("local_transcript_versions")) {
        return { id: newerVersionId, version: version.version + 1 };
      }
      return null;
    });
    const runAsync = jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("INSERT INTO local_transcript_versions")) {
        providerVersionParams = params;
      }
      return { changes: 1 };
    });
    mockedOpen.mockResolvedValue({ getFirstAsync, runAsync } as never);

    await persistCompletedTranscriptionResult({
      queueId: "queue",
      job,
      run,
      version,
      segments: [segment],
    });

    const sql = statements.join("\n");
    expect(sql).toContain("INSERT INTO local_processing_jobs");
    expect(sql).toContain("INSERT INTO local_transcription_runs");
    expect(sql).toContain("UPDATE local_transcription_request_queue");
    expect(sql).not.toContain("SET is_current = 0");
    expect(sql).toContain("INSERT INTO local_transcript_versions");
    expect(sql).toContain("INSERT INTO local_transcript_segments");
    expect(providerVersionParams?.[12]).toBe(0);
  });

  it("rejects a current user edit as a provider-result payload", async () => {
    mockedOpen.mockResolvedValue(null);

    await expect(
      persistCompletedTranscriptionResult({
        queueId: "queue",
        job,
        run,
        version: {
          ...version,
          version_origin: "user_edit",
          parent_version_id: ids[7],
        },
        segments: [],
      }),
    ).rejects.toThrow("The transcript result scope is invalid.");

    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("persists a remotely non-current provider result without switching local current", async () => {
    const existingCurrentId = "99999999-9999-4999-8999-999999999999";
    const statements: string[] = [];
    let providerVersionParams: unknown[] | undefined;
    const getFirstAsync = jest.fn(async (sql: string) => {
      if (sql.includes("local_transcription_request_queue")) {
        return { id: "queue" };
      }
      if (sql.includes("local_transcript_versions")) {
        return { id: existingCurrentId, version: version.version + 1 };
      }
      return null;
    });
    const runAsync = jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("INSERT INTO local_transcript_versions")) {
        providerVersionParams = params;
      }
      return { changes: 1 };
    });
    mockedOpen.mockResolvedValue({ getFirstAsync, runAsync } as never);

    await persistCompletedTranscriptionResult({
      queueId: "queue",
      job,
      run,
      version: { ...version, is_current: false },
      segments: [segment],
    });

    const sql = statements.join("\n");
    expect(sql).not.toContain("SET is_current = 0");
    expect(sql).toContain("INSERT INTO local_transcript_versions");
    expect(sql).toContain("INSERT INTO local_transcript_segments");
    expect(sql).toContain("UPDATE local_transcription_request_queue");
    expect(providerVersionParams?.[12]).toBe(0);
  });

  it("persists processing status without transcript rows", async () => {
    const statements: string[] = [];
    const db = {
      getFirstAsync: jest.fn(async () => ({ id: "queue" })),
      runAsync: jest.fn(async (sql: string) => {
        statements.push(sql);
        return { changes: 1 };
      }),
    };
    mockedOpen.mockResolvedValue(db as never);

    await persistTranscriptionResultProgress({
      queueId: "queue",
      job: { ...job, status: "processing" },
      run: { ...run, status: "processing" },
      nextRetryAt: "2026-08-15T00:00:15.000Z",
      errorCode: "TRANSCRIPTION_RESULT_PROCESSING",
      safeError: "processing",
    });

    const sql = statements.join("\n");
    expect(sql).toContain("INSERT INTO local_processing_jobs");
    expect(sql).toContain("INSERT INTO local_transcription_runs");
    expect(sql).not.toContain("INSERT INTO local_transcript_versions");
  });
});
