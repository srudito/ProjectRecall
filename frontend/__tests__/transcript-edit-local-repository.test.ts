import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
  claimTranscriptEditQueue,
  completeTranscriptEditQueueSuccess,
  enqueueTranscriptEditSnapshot,
  markTranscriptEditQueueFailed,
  resetSubmittingTranscriptEditQueue,
  saveTranscriptEditDraft,
  type TranscriptEditQueueRow,
} from "@/src/services/sqlite/repository";

jest.mock("@/src/services/sqlite/schema", () => ({
  openLocalDb: jest.fn(),
}));

jest.mock("@/src/services/sqlite/transaction", () => ({
  runSerializedLocalTransaction: jest.fn(
    async (_db: unknown, operation: () => Promise<unknown>) => operation(),
  ),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BASE_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_VERSION_ID = "55555555-5555-4555-8555-555555555555";

const mockedOpenLocalDb = openLocalDb as jest.MockedFunction<
  typeof openLocalDb
>;
const mockedTransaction = runSerializedLocalTransaction as jest.MockedFunction<
  typeof runSerializedLocalTransaction
>;

describe("local transcript edit repository", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stores draft text separately from immutable transcript versions", async () => {
    const runAsync = jest.fn(async (_statement: string) => ({ changes: 1 }));
    const getFirstAsync = jest.fn(async () => ({
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      base_version_id: BASE_VERSION_ID,
      plain_text: "draft text",
      created_at: "2026-08-19T00:00:00.000Z",
      updated_at: "2026-08-19T00:00:00.000Z",
    }));
    mockedOpenLocalDb.mockResolvedValue({ runAsync, getFirstAsync } as never);

    await saveTranscriptEditDraft({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      baseVersionId: BASE_VERSION_ID,
      plainText: "draft text",
    });

    const sql = runAsync.mock.calls
      .map(([statement]) => String(statement))
      .join("\n");
    expect(sql).toContain("INSERT INTO local_transcript_edit_drafts");
    expect(sql).not.toContain("base_version_id = excluded.base_version_id");
    expect(sql).not.toContain("local_transcript_versions");
    expect(sql).not.toContain("local_transcript_segments");
  });

  it("creates an immutable pending outbox snapshot keyed by client version id", async () => {
    const runAsync = jest.fn(async (_statement: string) => ({ changes: 1 }));
    const getFirstAsync = jest.fn(async () => null);
    const db = { runAsync, getFirstAsync };
    mockedOpenLocalDb.mockResolvedValue(db as never);

    const result = await enqueueTranscriptEditSnapshot({
      clientVersionId: CLIENT_VERSION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      expectedCurrentVersionId: BASE_VERSION_ID,
      plainText: "corrected transcript",
    });

    expect(mockedTransaction).toHaveBeenCalledWith(db, expect.any(Function));
    expect(result).toMatchObject({
      id: CLIENT_VERSION_ID,
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      expected_current_version_id: BASE_VERSION_ID,
      plain_text: "corrected transcript",
      queue_status: "pending",
      attempt_count: 0,
      max_attempts: 5,
    });
    const sql = runAsync.mock.calls
      .map(([statement]) => String(statement))
      .join("\n");
    expect(sql).toContain("INSERT INTO local_transcript_edit_queue");
    expect(sql).not.toContain("local_transcript_versions");
  });

  it("treats an identical stable client-version replay as idempotent", async () => {
    const existing: TranscriptEditQueueRow = {
      id: CLIENT_VERSION_ID,
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      expected_current_version_id: BASE_VERSION_ID,
      plain_text: "corrected transcript",
      queue_status: "failed",
      attempt_count: 1,
      max_attempts: 5,
      next_retry_at: null,
      last_error_code: "NETWORK_UNAVAILABLE",
      last_safe_error: "Retry later.",
      created_at: "2026-08-19T00:00:00.000Z",
      updated_at: "2026-08-19T00:01:00.000Z",
    };
    const runAsync = jest.fn(async (_statement: string) => ({ changes: 1 }));
    const getFirstAsync = jest.fn(async () => existing);
    mockedOpenLocalDb.mockResolvedValue({ runAsync, getFirstAsync } as never);

    await expect(
      enqueueTranscriptEditSnapshot({
        clientVersionId: CLIENT_VERSION_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        expectedCurrentVersionId: BASE_VERSION_ID,
        plainText: "corrected transcript",
      }),
    ).resolves.toEqual(existing);
    expect(runAsync).not.toHaveBeenCalled();
  });

  it("rejects reuse of a client version id with different transcript content", async () => {
    const existing: TranscriptEditQueueRow = {
      id: CLIENT_VERSION_ID,
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      expected_current_version_id: BASE_VERSION_ID,
      plain_text: "first payload",
      queue_status: "pending",
      attempt_count: 0,
      max_attempts: 5,
      next_retry_at: null,
      last_error_code: null,
      last_safe_error: null,
      created_at: "2026-08-19T00:00:00.000Z",
      updated_at: "2026-08-19T00:00:00.000Z",
    };
    const runAsync = jest.fn(async (_statement: string) => ({ changes: 1 }));
    const getFirstAsync = jest.fn(async () => existing);
    mockedOpenLocalDb.mockResolvedValue({ runAsync, getFirstAsync } as never);

    await expect(
      enqueueTranscriptEditSnapshot({
        clientVersionId: CLIENT_VERSION_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        expectedCurrentVersionId: BASE_VERSION_ID,
        plainText: "different payload",
      }),
    ).rejects.toThrow(
      "Transcript edit client version id was reused with different content.",
    );
    expect(runAsync).not.toHaveBeenCalled();
  });

  it("does not queue blank transcript content", async () => {
    mockedOpenLocalDb.mockResolvedValue(null);

    await expect(
      enqueueTranscriptEditSnapshot({
        clientVersionId: CLIENT_VERSION_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        expectedCurrentVersionId: BASE_VERSION_ID,
        plainText: "   ",
      }),
    ).rejects.toThrow("Transcript edit text must not be blank.");
  });

  it("claims pending or retryable failed edits by incrementing the attempt", async () => {
    const submitting: TranscriptEditQueueRow = {
      id: CLIENT_VERSION_ID,
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      expected_current_version_id: BASE_VERSION_ID,
      plain_text: "corrected transcript",
      queue_status: "submitting",
      attempt_count: 1,
      max_attempts: 5,
      next_retry_at: null,
      last_error_code: null,
      last_safe_error: null,
      created_at: "2026-08-19T00:00:00.000Z",
      updated_at: "2026-08-19T00:01:00.000Z",
    };
    const runAsync = jest.fn(async (_statement: string) => ({ changes: 1 }));
    const getFirstAsync = jest.fn(async () => submitting);
    mockedOpenLocalDb.mockResolvedValue({ runAsync, getFirstAsync } as never);

    await expect(claimTranscriptEditQueue(CLIENT_VERSION_ID)).resolves.toEqual(
      submitting,
    );

    const sql = String(runAsync.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("queue_status = 'submitting'");
    expect(sql).toContain("attempt_count = attempt_count + 1");
    expect(sql).toContain("queue_status IN ('pending','failed')");
    expect(sql).toContain("attempt_count < max_attempts");
    expect(sql).toContain("next_retry_at IS NULL OR next_retry_at <= ?");
  });

  it("completes one outbox row and deletes only an exact matching draft snapshot", async () => {
    const runAsync = jest.fn(async (_statement: string) => ({ changes: 1 }));
    const db = { runAsync };
    mockedOpenLocalDb.mockResolvedValue(db as never);

    await completeTranscriptEditQueueSuccess({
      queueId: CLIENT_VERSION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      expectedCurrentVersionId: BASE_VERSION_ID,
      plainText: "corrected transcript",
    });

    expect(mockedTransaction).toHaveBeenCalledWith(db, expect.any(Function));
    const statements = runAsync.mock.calls.map(([statement]) => String(statement));
    expect(statements[0]).toContain("queue_status = 'succeeded'");
    expect(statements[0]).toContain("expected_current_version_id = ?");
    expect(statements[0]).toContain("plain_text = ?");
    expect(statements[1]).toContain("DELETE FROM local_transcript_edit_drafts");
    expect(statements[1]).toContain("base_version_id = ?");
    expect(statements[1]).toContain("plain_text = ?");
  });

  it("does not delete a draft when completion no longer matches the claimed snapshot", async () => {
    const runAsync = jest.fn(async (_statement: string) => ({ changes: 0 }));
    const db = { runAsync };
    mockedOpenLocalDb.mockResolvedValue(db as never);

    await expect(
      completeTranscriptEditQueueSuccess({
        queueId: CLIENT_VERSION_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        expectedCurrentVersionId: BASE_VERSION_ID,
        plainText: "corrected transcript",
      }),
    ).rejects.toThrow(
      "Transcript edit queue completion no longer matches the claimed snapshot.",
    );

    expect(runAsync).toHaveBeenCalledTimes(1);
  });

  it("makes terminal failed rows ineligible by exhausting their local attempt budget", async () => {
    const runAsync = jest.fn(
      async (_statement: string, _params?: unknown) => ({ changes: 1 }),
    );
    mockedOpenLocalDb.mockResolvedValue({ runAsync } as never);

    await markTranscriptEditQueueFailed(
      CLIENT_VERSION_ID,
      "TRANSCRIPT_EDIT_INPUT_INVALID",
      "The transcript edit is not valid.",
    );

    const sql = String(runAsync.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("queue_status = ?");
    expect(sql).toContain("THEN max_attempts");
    expect(sql).toContain("queue_status = 'submitting'");
    expect(runAsync.mock.calls[0]?.[1]).toEqual([
      "failed",
      "failed",
      "TRANSCRIPT_EDIT_INPUT_INVALID",
      "The transcript edit is not valid.",
      expect.any(String),
      CLIENT_VERSION_ID,
    ]);
  });

  it("recovers interrupted submitting rows without consuming retry budget", async () => {
    const runAsync = jest.fn(async (_statement: string) => ({ changes: 2 }));
    mockedOpenLocalDb.mockResolvedValue({ runAsync } as never);

    await expect(resetSubmittingTranscriptEditQueue(USER_ID)).resolves.toBe(2);

    const sql = String(runAsync.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("queue_status = 'pending'");
    expect(sql).toContain("attempt_count > 0 THEN attempt_count - 1");
    expect(sql).toContain("queue_status = 'submitting'");
  });
});
