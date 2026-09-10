import { openLocalDb } from "@/src/services/sqlite/schema";
import {
  getNextTranscriptionResultWakeAt,
  getNextTranscriptionResultWorkItem,
} from "@/src/services/sqlite/repository";
import {
  encodeTranscriptionResultReceipt,
  type ResultReceiptRow,
} from "@/src/services/transcription/result-receipt";

jest.mock("@/src/services/sqlite/schema", () => ({ openLocalDb: jest.fn() }));

const mockedOpen = openLocalDb as jest.MockedFunction<typeof openLocalDb>;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RECORDING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VERSION = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-10T12:00:00.000Z";
const FUTURE = "2026-09-10T12:01:00.000Z";

const rawRequest = (patch: Record<string, unknown> = {}) => ({
  id: "legacy-request-a",
  user_id: USER,
  workspace_id: WORKSPACE,
  session_id: SESSION,
  recording_id: RECORDING,
  spoken_language_mode: "AUTO_DETECT",
  expected_spoken_languages: "[]",
  queue_status: "submitted",
  attempt_count: 0,
  max_attempts: 5,
  next_retry_at: null,
  server_job_id: JOB,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: "batch-transcription:test",
  created_at: NOW,
  updated_at: NOW,
  ...patch,
});

type RawRequest = ReturnType<typeof rawRequest>;

const receiptFor = (request: RawRequest): Readonly<ResultReceiptRow> =>
  encodeTranscriptionResultReceipt({
    schemaVersion: 1,
    kind: "result_reconciled",
    userId: request.user_id as string,
    workspaceId: request.workspace_id as string,
    sessionId: request.session_id as string,
    recordingId: request.recording_id as string,
    jobId: request.server_job_id as string,
    requestId: request.id as string,
    resultVersionId: VERSION,
    resultVersion: 1,
    contentChecksum: "a".repeat(64),
    expectedSegments: 1,
    reconciledAt: NOW,
  });

const fixture = (
  requests: RawRequest[],
  receipts: readonly Readonly<ResultReceiptRow>[] = [],
) => {
  const getAllAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM local_transcription_request_queue")) return requests;
    if (sql.includes("FROM local_sync_state")) {
      return receipts.filter((row) => params.includes(row.key));
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  mockedOpen.mockResolvedValue({ getAllAsync } as never);
  return getAllAsync;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("C2B.2 receipt-aware result eligibility", () => {
  it("selects a receiptless legacy completion for one authenticated re-read", async () => {
    const request = rawRequest();
    const getAllAsync = fixture([request]);

    await expect(
      getNextTranscriptionResultWorkItem(USER, NOW),
    ).resolves.toMatchObject({
      kind: "sync",
      request: {
        id: request.id,
        expected_spoken_languages: [],
        server_job_id: JOB,
      },
    });

    const queueSql = String(getAllAsync.mock.calls[0]?.[0] ?? "");
    expect(queueSql).not.toContain("local_processing_jobs");
    expect(queueSql).not.toContain("local_transcription_runs");
    expect(queueSql).not.toContain("local_transcript_versions");
    expect(queueSql).not.toContain("local_transcript_segments");
  });

  it("skips an exact valid receipt without checking local transcript availability", async () => {
    const request = rawRequest();
    const getAllAsync = fixture([request], [receiptFor(request)]);

    await expect(
      getNextTranscriptionResultWorkItem(USER, NOW),
    ).resolves.toBeNull();

    expect(
      getAllAsync.mock.calls.some(([sql]) =>
        /local_(?:processing_jobs|transcription_runs|transcript_versions|transcript_segments)/.test(
          String(sql),
        )),
    ).toBe(false);
  });

  it("continues to the next missing receipt in the same bounded batch", async () => {
    const completed = rawRequest({ id: "legacy-request-a" });
    const missing = rawRequest({ id: "legacy-request-b" });
    fixture([completed, missing], [receiptFor(completed)]);

    await expect(
      getNextTranscriptionResultWorkItem(USER, NOW),
    ).resolves.toMatchObject({
      kind: "sync",
      request: { id: "legacy-request-b" },
    });
  });

  it("scans past a full bounded batch of valid receipts", async () => {
    const firstBatch = Array.from({ length: 64 }, (_, index) =>
      rawRequest({ id: `legacy-request-${String(index).padStart(3, "0")}` }),
    );
    const missing = rawRequest({ id: "legacy-request-999" });
    const receipts = firstBatch.map(receiptFor);
    let queueRead = 0;
    const getAllAsync = jest.fn(
      async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM local_transcription_request_queue")) {
          queueRead += 1;
          return queueRead === 1 ? firstBatch : [missing];
        }
        if (sql.includes("FROM local_sync_state")) {
          return receipts.filter((row) => params.includes(row.key));
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    );
    mockedOpen.mockResolvedValue({ getAllAsync } as never);

    await expect(
      getNextTranscriptionResultWorkItem(USER, NOW),
    ).resolves.toMatchObject({
      kind: "sync",
      request: { id: missing.id },
    });
    expect(queueRead).toBe(2);
    expect(String(getAllAsync.mock.calls[2]?.[0] ?? "")).toContain(
      "request_row.id > ?",
    );
  });

  it("rejects a malformed exact receipt instead of performing a remote read", async () => {
    const request = rawRequest();
    const receipt = receiptFor(request);
    fixture([request], [{ ...receipt, value: "{}" }]);

    await expect(
      getNextTranscriptionResultWorkItem(USER, NOW),
    ).resolves.toMatchObject({
      kind: "reject",
      request: { id: request.id },
      errorCode: "TRANSCRIPTION_RESULT_RECEIPT_INVALID",
      safeError: "The local transcript completion receipt is invalid.",
    });
  });

  it("skips completed receipts when calculating the next durable wake", async () => {
    const completed = rawRequest({ id: "legacy-request-a" });
    const pending = rawRequest({
      id: "legacy-request-b",
      next_retry_at: FUTURE,
      updated_at: FUTURE,
    });
    fixture([completed, pending], [receiptFor(completed)]);

    await expect(
      getNextTranscriptionResultWakeAt(USER, NOW),
    ).resolves.toBe(FUTURE);
  });
});
