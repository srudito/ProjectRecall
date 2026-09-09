import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
  preserveTranscriptEditorContinuityDraft,
  canSubmitTranscriptEditQueue,
  deferTranscriptEditQueue,
  getNextEligibleTranscriptEditQueue,
  getNextTranscriptEditWakeAt,
  markTranscriptEditQueueCancelled,
  markTranscriptEditQueueConflict,
  rescheduleTranscriptEditQueue,
  type TranscriptEditQueueGuard,
  discardGuardedTranscriptEditDraft,
  enqueueGuardedTranscriptEditSnapshot,
  loadTranscriptEditorState,
  saveGuardedTranscriptEditDraft,
  type TranscriptEditDraftRow,
  claimTranscriptEditQueue,
  completeTranscriptEditQueueSuccess,
  enqueueTranscriptEditSnapshot,
  markTranscriptEditQueueFailed,
  resetSubmittingTranscriptEditQueue,
  saveTranscriptEditDraft,
  type TranscriptEditQueueRow,
} from "@/src/services/sqlite/repository";

import { TranscriptEditorError } from "@/src/services/transcription/editor-types";

jest.mock("@/src/services/sqlite/schema", () => ({
  openLocalDb: jest.fn(),
}));

jest.mock("@/src/services/sqlite/transaction", () => ({
  runSerializedLocalMutation: jest.fn(
    async (_db: unknown, operation: () => Promise<unknown>) => operation(),
  ),
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

describe("3D.2B2 live draft continuity", () => {
  const NOW = "2026-09-08T00:00:00.000Z";
  const NEW_ID = "66666666-6666-4666-8666-666666666666";
  const scope = { userId: USER_ID, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
  const base = { id: BASE_VERSION_ID, workspace_id: WORKSPACE_ID, session_id: SESSION_ID,
    version: 1, version_origin: "provider" as const, version_status: "final" as const,
    parent_version_id: null, plain_text: "Original", content_checksum_sha256: null,
    created_by: USER_ID, created_at: NOW, transcription_run_id: null };
  const command = () => ({ scope, assertActive: jest.fn(), plainText: "Continuation",
    proof: { kind: "observed_base" as const, base: { ...base } } });
  const succeeded = (): TranscriptEditQueueRow => ({
    id: CLIENT_VERSION_ID, user_id: USER_ID, workspace_id: WORKSPACE_ID, session_id: SESSION_ID,
    expected_current_version_id: BASE_VERSION_ID, plain_text: "Saved A", queue_status: "succeeded",
    attempt_count: 1, max_attempts: 5, next_retry_at: null, last_error_code: null, last_safe_error: null,
    created_at: NOW, updated_at: NOW,
  });
  const completionCommand = () => ({ ...command(), proof: { kind: "completed_save" as const,
    base: { ...base }, operationId: CLIENT_VERSION_ID, savedPlainText: "Saved A" } });
  const fixture = () => {
    const state = { draft: null as TranscriptEditDraftRow | null, queue: [] as TranscriptEditQueueRow[],
      base: { ...base, is_current: 0, language_summary: "{}", updated_at: NOW } as Record<string, unknown> | null,
      current: { ...base, id: NEW_ID, version: 2, is_current: 1, language_summary: "{}", updated_at: NOW },
      deleted: false, failWrite: false };
    const writes: { sql: string; params: unknown[] }[] = [];
    const db = {
      getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("local_sessions")) return { id: SESSION_ID, workspace_id: WORKSPACE_ID,
          status: "recorded", deleted_at: state.deleted ? NOW : null };
        if (sql.includes("local_session_deletion_queue")) return null;
        if (sql.includes("local_transcript_edit_drafts")) return state.draft;
        if (sql.includes("local_transcript_edit_queue")) return state.queue.find((q) => q.id === params[0]) ?? null;
        if (sql.includes("local_transcript_versions")) return sql.includes("is_current = 1") ? state.current : state.base;
        throw new Error("Unexpected query");
      }),
      getAllAsync: jest.fn(async (_sql: string, _params?: unknown[]) => state.queue.map((row) => ({ ...row }))),
      runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (state.failWrite) throw new Error("Injected write failure");
        writes.push({ sql, params });
        if (sql.includes("INSERT INTO local_transcript_edit_drafts")) {
          state.draft = { user_id: String(params[0]), workspace_id: String(params[1]), session_id: String(params[2]),
            base_version_id: String(params[3]), plain_text: String(params[4]), created_at: String(params[5]), updated_at: String(params[6]) };
        } else if (sql.includes("INSERT INTO local_transcript_edit_queue")) {
          state.queue.push({ ...succeeded(), id: String(params[0]), plain_text: String(params[5]), queue_status: "pending" });
        } else throw new Error("Unexpected write");
        return { changes: 1 };
      }),
    };
    mockedOpenLocalDb.mockResolvedValue(db as never);
    mockedTransaction.mockImplementation(async (_db, task) => {
      const before = state.draft && { ...state.draft };
      try { return await task(); } catch (error) { state.draft = before; throw error; }
    });
    return { db, state, writes };
  };
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => { mockedTransaction.mockImplementation(async (_db, task) => task()); });

  it("preserves the observed historical base without writing versions, evidence or an outbox", async () => {
    const { state, writes } = fixture(); await preserveTranscriptEditorContinuityDraft(command());
    expect(state.draft).toMatchObject({ base_version_id: BASE_VERSION_ID, plain_text: "Continuation" });
    expect(writes).toHaveLength(1); expect(writes[0].sql).toContain("local_transcript_edit_drafts");
    expect(state.queue).toEqual([]);
  });
  it("allows a blank newer draft after a confirmed Save, without reviving the saved text", async () => {
    const { state } = fixture(); state.queue = [succeeded()];
    await preserveTranscriptEditorContinuityDraft({ ...completionCommand(), plainText: "" });
    expect(state.draft?.plain_text).toBe(""); expect(state.draft?.base_version_id).toBe(BASE_VERSION_ID);
    expect(state.queue[0].queue_status).toBe("succeeded");
  });
  it("requires a real succeeded operation, not just absence of the draft", async () => {
    const { writes } = fixture();
    await expect(preserveTranscriptEditorContinuityDraft(completionCommand())).rejects.toMatchObject({ code: "EDITOR_RECOVERY_REJECTED" });
    expect(writes).toEqual([]);
  });
  it.each(["pending", "failed", "conflict", "cancelled"] as const)("does not recover from a %s operation", async (status) => {
    const { state, writes } = fixture(); state.queue = [{ ...succeeded(), queue_status: status }];
    await expect(preserveTranscriptEditorContinuityDraft(completionCommand())).rejects.toBeInstanceOf(TranscriptEditorError);
    expect(writes).toEqual([]);
  });
  it("does not recreate the identical already-saved text", async () => {
    const { state } = fixture(); state.queue = [succeeded()];
    await expect(preserveTranscriptEditorContinuityDraft({ ...completionCommand(), plainText: "Saved A" }))
      .rejects.toMatchObject({ code: "EDITOR_RECOVERY_REJECTED" });
    expect(state.draft).toBeNull();
  });
  it("never uses first-autosave observation to bypass a prior outbound operation", async () => {
    const { state } = fixture(); state.queue = [succeeded()];
    await expect(preserveTranscriptEditorContinuityDraft(command())).rejects.toMatchObject({ code: "EDITOR_RECOVERY_REJECTED" });
  });
  it("requires the same immutable saved payload and operation ID", async () => {
    const { state } = fixture(); state.queue = [{ ...succeeded(), plain_text: "Different" }];
    await expect(preserveTranscriptEditorContinuityDraft(completionCommand())).rejects.toMatchObject({ code: "EDITOR_RECOVERY_REJECTED" });
  });
  it("does not overwrite even an identical replacement draft", async () => {
    const { state, writes } = fixture(); state.draft = { user_id: USER_ID, workspace_id: WORKSPACE_ID, session_id: SESSION_ID,
      base_version_id: BASE_VERSION_ID, plain_text: "Continuation", created_at: NOW, updated_at: NOW };
    await expect(preserveTranscriptEditorContinuityDraft(command())).rejects.toMatchObject({ code: "EDITOR_DRAFT_CHANGED" });
    expect(writes).toEqual([]);
  });
  it.each(["plain_text", "version", "parent_version_id", "content_checksum_sha256", "created_by"])("rejects an observation with changed immutable %s", async (field) => {
    const { state } = fixture(); state.base![field] = field === "version" ? 7 : "changed";
    await expect(preserveTranscriptEditorContinuityDraft(command())).rejects.toMatchObject({ code: "EDITOR_RECOVERY_REJECTED" });
  });
  it("rejects a missing base instead of guessing the latest provider", async () => {
    const { state } = fixture(); state.base = null;
    await expect(preserveTranscriptEditorContinuityDraft(command())).rejects.toMatchObject({ code: "EDITOR_RECOVERY_REJECTED" });
  });
  it("uses the existing deleted-session guard on recovery", async () => {
    const { state } = fixture(); state.deleted = true;
    await expect(preserveTranscriptEditorContinuityDraft(command())).rejects.toMatchObject({ code: "EDITOR_SESSION_UNAVAILABLE" });
    expect(state.draft).toBeNull();
  });
  it("rolls back recovery when ownership is invalidated during a write", async () => {
    const { state, writes } = fixture();
    await expect(preserveTranscriptEditorContinuityDraft({ ...command(), assertActive: () => {
      if (writes.length > 0) throw new TranscriptEditorError("EDITOR_CONTEXT_INACTIVE");
    } })).rejects.toMatchObject({ code: "EDITOR_CONTEXT_INACTIVE" });
    expect(state.draft).toBeNull();
  });
  it("fails explicitly without SQLite and preserves the original input", async () => {
    mockedOpenLocalDb.mockResolvedValue(null);
    await expect(preserveTranscriptEditorContinuityDraft(command())).rejects.toMatchObject({ code: "EDITOR_LOCAL_STORAGE_UNAVAILABLE" });
  });
  it("rejects invalid text before opening SQLite", async () => {
    await expect(preserveTranscriptEditorContinuityDraft({ ...command(), plainText: "a\u0000b" }))
      .rejects.toMatchObject({ code: "EDITOR_INPUT_INVALID" });
    expect(mockedOpenLocalDb).not.toHaveBeenCalled();
  });
  it("enqueues an older frozen Save without overwriting its already-durable newer draft", async () => {
    const { state, writes } = fixture(); state.current = { ...state.current, id: BASE_VERSION_ID, version: 1 };
    state.draft = { user_id: USER_ID, workspace_id: WORKSPACE_ID, session_id: SESSION_ID,
      base_version_id: BASE_VERSION_ID, plain_text: "New B", created_at: NOW, updated_at: NOW };
    const result = await enqueueGuardedTranscriptEditSnapshot({ scope, assertActive: jest.fn(),
      baseVersionId: BASE_VERSION_ID, clientVersionId: CLIENT_VERSION_ID, plainText: "Old A",
      expectedDraft: { ...state.draft }, preserveNewerDraft: true });
    expect(result.draft?.plain_text).toBe("New B"); expect(result.operation.plain_text).toBe("Old A");
    expect(writes).toHaveLength(1); expect(writes[0].sql).toContain("INSERT INTO local_transcript_edit_queue");
  });
  it("retains CAS enforcement when newer-draft preservation is requested", async () => {
    const { state } = fixture(); state.current = { ...state.current, id: BASE_VERSION_ID, version: 1 };
    state.draft = { user_id: USER_ID, workspace_id: WORKSPACE_ID, session_id: SESSION_ID,
      base_version_id: BASE_VERSION_ID, plain_text: "New B", created_at: NOW, updated_at: NOW };
    await expect(enqueueGuardedTranscriptEditSnapshot({ scope, assertActive: jest.fn(),
      baseVersionId: BASE_VERSION_ID, clientVersionId: CLIENT_VERSION_ID, plainText: "Old A",
      expectedDraft: null, preserveNewerDraft: true })).rejects.toMatchObject({ code: "EDITOR_DRAFT_CHANGED" });
    expect(state.queue).toEqual([]);
  });
});

describe("3D.2B serialized edit-queue admission", () => {
  const NOW = "2026-09-08T00:00:00.000Z";
  const row: TranscriptEditQueueRow = {
    id: CLIENT_VERSION_ID, user_id: USER_ID, workspace_id: WORKSPACE_ID,
    session_id: SESSION_ID, expected_current_version_id: BASE_VERSION_ID,
    plain_text: "unchanged snapshot", queue_status: "submitting", attempt_count: 1,
    max_attempts: 5, next_retry_at: null, last_error_code: null, last_safe_error: null,
    created_at: NOW, updated_at: NOW,
  };
  const guard = (): TranscriptEditQueueGuard => ({ userId: USER_ID, assertActive: jest.fn() });
  const completion = { queueId: row.id, userId: USER_ID, workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID, expectedCurrentVersionId: BASE_VERSION_ID, plainText: row.plain_text };
  const actual = jest.requireActual<typeof import("@/src/services/sqlite/transaction")>(
    "@/src/services/sqlite/transaction",
  );
  const fixture = () => {
    const events: string[] = [];
    const db = {
      getFirstAsync: jest.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => ({ ...row })),
      runAsync: jest.fn(async (_sql: string, _params?: unknown[]) => ({ changes: 1 })),
      withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
        events.push("begin");
        try { await task(); events.push("commit"); }
        catch (error) { events.push("rollback"); throw error; }
      }),
    };
    mockedOpenLocalDb.mockResolvedValue(db as never);
    return { db, events };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    actual.__resetSerializedLocalTransactionsForTests();
    mockedTransaction.mockImplementation(actual.runSerializedLocalTransaction);
  });
  afterEach(() => {
    mockedTransaction.mockImplementation(async (_db, task) => task());
  });

  it("uses live session and identical attempt-budget gates for eligibility and wake time", async () => {
    const { db, events } = fixture(); const context = guard();
    await getNextEligibleTranscriptEditQueue(USER_ID, NOW, 3, context);
    db.getFirstAsync.mockResolvedValueOnce({ wake_at: NOW });
    await expect(getNextTranscriptEditWakeAt(USER_ID, NOW, 3, context)).resolves.toBe(NOW);
    for (const [sql] of db.getFirstAsync.mock.calls) {
      expect(sql).toContain("edit_session.workspace_id = local_transcript_edit_queue.workspace_id");
      expect(sql).toContain("edit_session.deleted_at IS NULL");
      expect(sql).toContain("NOT IN ('deleting','deleted')");
      expect(sql).toContain("local_session_deletion_queue");
      expect(sql).toContain("attempt_count < max_attempts AND attempt_count < ?");
    }
    expect(db.getFirstAsync.mock.calls[0][1]).toEqual([USER_ID, 3, NOW]);
    expect(db.getFirstAsync.mock.calls[1][1]).toEqual([NOW, USER_ID, 3]);
    expect(events).toEqual(["begin", "commit", "begin", "commit"]);
  });

  it("checks due-time, user and deletion state again inside the claim UPDATE", async () => {
    const { db, events } = fixture(); const context = guard();
    await expect(claimTranscriptEditQueue(row.id, context, 3)).resolves.toEqual(row);
    const [sql, params] = db.runAsync.mock.calls[0];
    expect(sql).toContain("next_retry_at IS NULL OR next_retry_at <= ?");
    expect(sql).toContain("(? IS NULL OR user_id = ?)");
    expect(sql).toContain("local_session_deletion_queue");
    expect(params).toEqual([expect.any(String), row.id, 3, expect.any(String), USER_ID, USER_ID]);
    expect(events).toEqual(["begin", "commit"]);
  });

  it("does not resolve claim until COMMIT has actually returned", async () => {
    const { db } = fixture(); let release!: () => void; let reached!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const atCommit = new Promise<void>((resolve) => { reached = resolve; });
    db.withTransactionAsync.mockImplementation(async (task) => {
      await task(); reached(); await blocked;
    });
    let completed = false;
    const pending = claimTranscriptEditQueue(row.id, guard()).then((value) => { completed = true; return value; });
    await atCommit; expect(completed).toBe(false); release();
    await expect(pending).resolves.toEqual(row);
  });

  it("queues claim behind an existing editor transaction without overlapping BEGIN", async () => {
    const { db, events } = fixture(); let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const editor = actual.runSerializedLocalTransaction(db, async () => { entered(); await blocked; });
    await ready;
    const claim = claimTranscriptEditQueue(row.id, guard());
    await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual(["begin"]); expect(db.runAsync).not.toHaveBeenCalled();
    release(); await editor; await claim;
    expect(events).toEqual(["begin", "commit", "begin", "commit"]);
  });

  it("propagates COMMIT failure instead of returning a durable claim", async () => {
    const { db } = fixture();
    db.withTransactionAsync.mockImplementation(async (task) => { await task(); throw new Error("Commit failed"); });
    await expect(claimTranscriptEditQueue(row.id, guard())).rejects.toThrow("Commit failed");
  });

  it("returns no claim when another operation or deletion made it ineligible", async () => {
    const { db } = fixture(); db.runAsync.mockResolvedValue({ changes: 0 });
    await expect(claimTranscriptEditQueue(row.id, guard())).resolves.toBeNull();
    expect(db.getFirstAsync).not.toHaveBeenCalled();
  });

  it("rechecks the exact claimed payload and live session before submission", async () => {
    const { db } = fixture();
    db.getFirstAsync.mockResolvedValueOnce(null);
    await expect(canSubmitTranscriptEditQueue(row, guard())).resolves.toBe(false);
    db.getFirstAsync.mockResolvedValueOnce({ id: row.id });
    await expect(canSubmitTranscriptEditQueue(row, guard())).resolves.toBe(true);
    expect(db.getFirstAsync).toHaveBeenCalledWith(expect.stringContaining("local_session_deletion_queue"),
      [row.id, USER_ID, WORKSPACE_ID, SESSION_ID, BASE_VERSION_ID, row.plain_text]);
    expect(db.runAsync).not.toHaveBeenCalled();
  });

  it("rolls back an operation when its run guard is invalidated during SQL", async () => {
    const { db, events } = fixture(); let active = true;
    db.runAsync.mockImplementation(async () => { active = false; return { changes: 1 }; });
    await expect(claimTranscriptEditQueue(row.id, { userId: USER_ID, assertActive: () => {
      if (!active) throw new Error("Stopped");
    } })).rejects.toThrow("Stopped");
    expect(events).toEqual(["begin", "rollback"]);
  });

  it("rejects a mismatched explicit user before opening the database", async () => {
    const context = { ...guard(), userId: WORKSPACE_ID };
    await expect(getNextEligibleTranscriptEditQueue(USER_ID, NOW, 5, context)).rejects.toThrow("user changed");
    await expect(resetSubmittingTranscriptEditQueue(USER_ID, context)).rejects.toThrow("user changed");
    await expect(canSubmitTranscriptEditQueue(row, context)).rejects.toThrow("user changed");
    await expect(completeTranscriptEditQueueSuccess(completion, context)).rejects.toThrow("user changed");
    expect(mockedOpenLocalDb).not.toHaveBeenCalled();
  });

  const guardedOperations: { name: string; run: (context: TranscriptEditQueueGuard) => Promise<unknown> }[] = [
    { name: "eligible", run: (g) => getNextEligibleTranscriptEditQueue(USER_ID, NOW, 5, g) },
    { name: "wake", run: (g) => getNextTranscriptEditWakeAt(USER_ID, NOW, 5, g) },
    { name: "claim", run: (g) => claimTranscriptEditQueue(row.id, g) },
    { name: "submit-check", run: (g) => canSubmitTranscriptEditQueue(row, g) },
    { name: "reset", run: (g) => resetSubmittingTranscriptEditQueue(USER_ID, g) },
    { name: "complete", run: (g) => completeTranscriptEditQueueSuccess(completion, g) },
    { name: "defer", run: (g) => deferTranscriptEditQueue(row.id, NOW, "AUTH", "Wait.", g) },
    { name: "retry", run: (g) => rescheduleTranscriptEditQueue(row.id, NOW, "NETWORK", "Wait.", g) },
    { name: "conflict", run: (g) => markTranscriptEditQueueConflict(row.id, "CONFLICT", "Changed.", g) },
    { name: "failed", run: (g) => markTranscriptEditQueueFailed(row.id, "FAILED", "Failed.", g) },
    { name: "cancelled", run: (g) => markTranscriptEditQueueCancelled(row.id, "DELETED", "Deleted.", g) },
  ];
  it.each(guardedOperations)("fails closed when SQLite is unavailable for $name", async ({ run }) => {
    mockedOpenLocalDb.mockResolvedValue(null);
    await expect(run(guard())).rejects.toThrow("queue storage is unavailable");
  });

  it.each(guardedOperations)("rejects a stopped run before database access for $name", async ({ run }) => {
    await expect(run({ userId: USER_ID, assertActive: () => { throw new Error("Stopped"); } })).rejects.toThrow("Stopped");
    expect(mockedOpenLocalDb).not.toHaveBeenCalled();
  });

  it("serializes all status transitions and scopes each to the running user", async () => {
    const { db, events } = fixture(); const context = guard();
    await deferTranscriptEditQueue(row.id, NOW, "AUTH", "Wait.", context);
    await rescheduleTranscriptEditQueue(row.id, NOW, "NETWORK", "Wait.", context);
    await markTranscriptEditQueueConflict(row.id, "CONFLICT", "Changed.", context);
    await markTranscriptEditQueueFailed(row.id, "FAILED", "Failed.", context);
    await markTranscriptEditQueueCancelled(row.id, "DELETED", "Deleted.", context);
    expect(events).toEqual(Array.from({ length: 5 }, () => ["begin", "commit"]).flat());
    for (const [sql, params] of db.runAsync.mock.calls) {
      expect(sql).toContain("queue_status = 'submitting'");
      expect(sql).toContain("user_id = ?"); expect(params).toContain(USER_ID);
      expect(sql).not.toContain("INSERT"); expect(sql).not.toContain("SET plain_text");
    }
  });

  it("does not report a completed transition or delete a draft when the row vanished", async () => {
    const { db } = fixture(); db.runAsync.mockResolvedValue({ changes: 0 });
    await expect(completeTranscriptEditQueueSuccess(completion, guard())).rejects.toThrow("no longer matches");
    expect(db.runAsync).toHaveBeenCalledTimes(1);
    await expect(rescheduleTranscriptEditQueue(row.id, NOW, "NETWORK", "Wait.", guard())).rejects.toThrow("no longer available");
    expect(db.runAsync.mock.calls.every(([sql]) => !sql.includes("INSERT"))).toBe(true);
  });

  it("completes and deletes only the exact matching draft within one transaction", async () => {
    const { db, events } = fixture();
    await completeTranscriptEditQueueSuccess(completion, guard());
    expect(events).toEqual(["begin", "commit"]);
    expect(db.runAsync.mock.calls[0][0]).toContain("local_session_deletion_queue");
    expect(db.runAsync.mock.calls[1][1]).toEqual([USER_ID, WORKSPACE_ID, SESSION_ID, BASE_VERSION_ID, row.plain_text]);
  });

  it("recovery skips unavailable sessions and never changes failed rows or immutable payloads", async () => {
    const { db } = fixture();
    await resetSubmittingTranscriptEditQueue(USER_ID, guard());
    const [sql, params] = db.runAsync.mock.calls[0];
    expect(sql).toContain("user_id = ? AND queue_status = 'submitting'");
    expect(sql).toContain("local_session_deletion_queue");
    expect(sql).not.toContain("plain_text ="); expect(sql).not.toContain("expected_current_version_id =");
    expect(params).toEqual([expect.any(String), USER_ID]);
  });
});

describe("3D.2 guarded editor persistence", () => {
  const NOW = "2026-09-08T00:00:00.000Z";
  const SECOND_ID = "66666666-6666-4666-8666-666666666666";
  const scope = { userId: USER_ID, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
  const base = { id: BASE_VERSION_ID, workspace_id: WORKSPACE_ID, session_id: SESSION_ID,
    version: 1, version_status: "final", version_origin: "provider", is_current: 1,
    plain_text: "  Original text.\n", language_summary: "{}" };
  const context = () => ({ scope, assertActive: jest.fn(() => undefined) });
  const command = () => ({ ...context(), expectedDraft: null,
    baseVersionId: BASE_VERSION_ID, plainText: "  Corrected text.\n", clientVersionId: CLIENT_VERSION_ID });
  const draftRow = (): TranscriptEditDraftRow => ({ user_id: USER_ID, workspace_id: WORKSPACE_ID,
    session_id: SESSION_ID, base_version_id: BASE_VERSION_ID, plain_text: "draft",
    created_at: NOW, updated_at: NOW });
  const queueRow = (): TranscriptEditQueueRow => ({ id: CLIENT_VERSION_ID, user_id: USER_ID,
    workspace_id: WORKSPACE_ID, session_id: SESSION_ID, expected_current_version_id: BASE_VERSION_ID,
    plain_text: "  Corrected text.\n", queue_status: "pending", attempt_count: 0, max_attempts: 5,
    next_retry_at: null, last_error_code: null, last_safe_error: null, created_at: NOW, updated_at: NOW });

  // Behavioral fixture, not a replacement for native/real-SQLite transaction tests.
  const setup = () => {
    const state = { draft: null as TranscriptEditDraftRow | null, queue: [] as TranscriptEditQueueRow[],
      current: { ...base } as typeof base | null, historical: { ...base, is_current: 0 } as typeof base | null,
      session: { id: SESSION_ID, workspace_id: WORKSPACE_ID, deleted_at: null as string | null, status: "recorded" },
      deleting: false, failQueueWrite: false };
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("local_session_deletion_queue")) return state.deleting ? { id: "delete" } : null;
        if (sql.includes("local_sessions")) return state.session;
        if (sql.includes("local_transcript_versions")) return sql.includes("is_current = 1") ? state.current : state.historical;
        if (sql.includes("local_transcript_edit_drafts")) return state.draft && { ...state.draft };
        if (sql.includes("local_transcript_edit_queue")) return state.queue.find((row) => row.id === params[0]) ?? null;
        throw new Error("Unexpected query");
      }),
      getAllAsync: jest.fn(async (_sql: string, _params?: unknown[]) => state.queue.map((row) => ({ ...row }))),
      runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO local_transcript_edit_drafts")) {
          if (state.draft) throw new Error("Duplicate draft");
          state.draft = { user_id: String(params[0]), workspace_id: String(params[1]),
            session_id: String(params[2]), base_version_id: String(params[3]), plain_text: String(params[4]),
            created_at: String(params[5]), updated_at: String(params[6]) };
        } else if (sql.includes("UPDATE local_transcript_edit_drafts")) {
          if (!state.draft || state.draft.plain_text !== params[6] || state.draft.updated_at !== params[8]) return { changes: 0 };
          state.draft = { ...state.draft, plain_text: String(params[0]), updated_at: String(params[1]) };
        } else if (sql.includes("DELETE FROM local_transcript_edit_drafts")) {
          if (!state.draft || state.draft.plain_text !== params[4] || state.draft.updated_at !== params[6]) return { changes: 0 };
          state.draft = null;
        } else if (sql.includes("INSERT INTO local_transcript_edit_queue")) {
          if (state.failQueueWrite) throw new Error("Injected database failure");
          state.queue.push({ ...queueRow(), id: String(params[0]), plain_text: String(params[5]),
            expected_current_version_id: String(params[4]), created_at: String(params[6]), updated_at: String(params[7]) });
        } else throw new Error("Unexpected write");
        return { changes: 1 };
      }),
    };
    let tail = Promise.resolve();
    mockedTransaction.mockImplementation(async (_db, task) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const before = { draft: state.draft && { ...state.draft }, queue: state.queue.map((row) => ({ ...row })) };
      try { return await task(); } catch (error) {
        state.draft = before.draft;
        state.queue = before.queue;
        throw error;
      } finally { release(); }
    });
    mockedOpenLocalDb.mockResolvedValue(db as never);
    return { state, db, calls };
  };

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    mockedTransaction.mockImplementation(async (_db, task) => task());
  });

  it("loads exact stored text without creating a draft or touching evidence", async () => {
    const { calls } = setup();
    const value = await loadTranscriptEditorState(context());
    expect(value.currentVersion?.plain_text).toBe("  Original text.\n");
    expect(value.draft).toBeNull();
    expect(value.queue).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("restores a draft even when its cached historical base is missing", async () => {
    const { state } = setup();
    state.draft = draftRow(); state.current = null; state.historical = null;
    const value = await loadTranscriptEditorState(context());
    expect(value.draft).toEqual(state.draft);
    expect(value.baseVersion).toBeNull();
  });

  it.each(["load", "draft", "save", "discard"])("fails closed without SQLite for %s", async (action) => {
    mockedOpenLocalDb.mockResolvedValue(null);
    const request = action === "load" ? loadTranscriptEditorState(context()) : action === "draft"
      ? saveGuardedTranscriptEditDraft(command()) : action === "save"
        ? enqueueGuardedTranscriptEditSnapshot(command())
        : discardGuardedTranscriptEditDraft({ ...context(), expectedDraft: null });
    await expect(request).rejects.toMatchObject({ code: "EDITOR_LOCAL_STORAGE_UNAVAILABLE" });
  });

  it.each(["deleted", "deleting", "deletion_queue", "workspace"])("blocks unavailable session: %s", async (reason) => {
    const { state, calls } = setup();
    if (reason === "deleted") state.session.deleted_at = NOW;
    if (reason === "deleting") state.session.status = "deleting";
    if (reason === "deletion_queue") state.deleting = true;
    if (reason === "workspace") state.session.workspace_id = SECOND_ID;
    await expect(saveGuardedTranscriptEditDraft(command())).rejects.toMatchObject({ code: "EDITOR_SESSION_UNAVAILABLE" });
    expect(calls).toEqual([]);
  });

  it("rejects a wrong-workspace persisted draft instead of silently rescoping it", async () => {
    const { state } = setup(); state.draft = { ...draftRow(), workspace_id: SECOND_ID };
    await expect(loadTranscriptEditorState(context())).rejects.toMatchObject({ code: "EDITOR_CACHE_INVALID" });
  });

  it("preserves empty draft text and advances the CAS token for rapid updates", async () => {
    const { state } = setup();
    const first = await saveGuardedTranscriptEditDraft({ ...command(), plainText: "" });
    const second = await saveGuardedTranscriptEditDraft({ ...command(), expectedDraft: first, plainText: "next" });
    expect(first.plain_text).toBe("");
    expect(second.created_at).toBe(first.created_at);
    expect(Date.parse(second.updated_at)).toBeGreaterThan(Date.parse(first.updated_at));
    expect(state.draft).toEqual(second);
    expect(state.queue).toEqual([]);
  });

  it("does not change the token or issue SQL writes for identical draft autosave", async () => {
    const { state, calls } = setup(); state.draft = draftRow();
    const saved = await saveGuardedTranscriptEditDraft({ ...command(), expectedDraft: state.draft, plainText: state.draft.plain_text });
    expect(saved).toEqual(state.draft); expect(calls).toEqual([]);
  });

  it("rejects stale autosave and stale discard without overwriting the newer draft", async () => {
    const { state } = setup(); const old = draftRow(); state.draft = { ...old, plain_text: "newer" };
    await expect(saveGuardedTranscriptEditDraft({ ...command(), expectedDraft: old })).rejects.toMatchObject({ code: "EDITOR_DRAFT_CHANGED" });
    await expect(discardGuardedTranscriptEditDraft({ ...context(), expectedDraft: old })).rejects.toMatchObject({ code: "EDITOR_DRAFT_CHANGED" });
    expect(state.draft?.plain_text).toBe("newer");
  });

  it("pins an existing base but allows autosave of a stale draft", async () => {
    const { state } = setup(); state.draft = draftRow(); state.current = { ...base, id: SECOND_ID, version: 2 };
    await expect(saveGuardedTranscriptEditDraft({ ...command(), baseVersionId: SECOND_ID, expectedDraft: state.draft }))
      .rejects.toMatchObject({ code: "EDITOR_BASE_PINNED" });
    const saved = await saveGuardedTranscriptEditDraft({ ...command(), expectedDraft: state.draft });
    expect(saved.base_version_id).toBe(BASE_VERSION_ID);
    await expect(enqueueGuardedTranscriptEditSnapshot({ ...command(), expectedDraft: saved }))
      .rejects.toMatchObject({ code: "EDITOR_BASE_CHANGED" });
  });

  it("commits exact draft and immutable snapshot together, without changing transcript versions", async () => {
    const { state, calls } = setup();
    const result = await enqueueGuardedTranscriptEditSnapshot(command());
    expect(result.kind).toBe("queued");
    expect(result.operation).toMatchObject({ id: CLIENT_VERSION_ID, plain_text: "  Corrected text.\n", queue_status: "pending" });
    expect(state.draft?.plain_text).toBe(result.operation.plain_text);
    expect(calls).toHaveLength(2);
    expect(calls.every(({ sql }) => !sql.includes("local_transcript_versions") && !sql.includes("local_transcript_segments"))).toBe(true);
  });

  it("rolls draft back if outbox insertion fails", async () => {
    const { state } = setup(); state.failQueueWrite = true;
    await expect(enqueueGuardedTranscriptEditSnapshot(command())).rejects.toThrow("Injected database failure");
    expect(state.draft).toBeNull(); expect(state.queue).toEqual([]);
  });

  it("coalesces concurrent identical Saves even when callers generated different UUIDs", async () => {
    const { state } = setup();
    const results = await Promise.all([enqueueGuardedTranscriptEditSnapshot(command()),
      enqueueGuardedTranscriptEditSnapshot({ ...command(), clientVersionId: SECOND_ID })]);
    expect(results.map((value) => value.kind)).toEqual(["queued", "existing"]);
    expect(results[1].operation.id).toBe(CLIENT_VERSION_ID); expect(state.queue).toHaveLength(1);
  });

  it("blocks a second different Save without altering the first snapshot", async () => {
    const { state } = setup(); const saved = await enqueueGuardedTranscriptEditSnapshot(command());
    await expect(enqueueGuardedTranscriptEditSnapshot({ ...command(), expectedDraft: saved.draft,
      clientVersionId: SECOND_ID, plainText: "different" })).rejects.toMatchObject({ code: "EDITOR_OPERATION_PENDING" });
    expect(state.queue).toHaveLength(1); expect(state.queue[0].plain_text).toBe(saved.operation.plain_text);
  });

  it("rejects UUID reuse with changed text", async () => {
    setup(); await enqueueGuardedTranscriptEditSnapshot(command());
    await expect(enqueueGuardedTranscriptEditSnapshot({ ...command(), plainText: "different" }))
      .rejects.toMatchObject({ code: "EDITOR_IDEMPOTENCY_CONFLICT" });
  });

  it("allows late replay after success without resurrecting a consumed draft", async () => {
    const { state, calls } = setup(); state.queue = [{ ...queueRow(), queue_status: "succeeded" }];
    state.current = { ...base, id: SECOND_ID, version: 3 };
    const result = await enqueueGuardedTranscriptEditSnapshot(command());
    expect(result.kind).toBe("existing"); expect(result.operation.queue_status).toBe("succeeded");
    expect(state.draft).toBeNull(); expect(calls).toEqual([]);
  });

  it("keeps newer typing when an older Save is replayed", async () => {
    const { state } = setup(); state.queue = [queueRow()]; state.draft = { ...draftRow(), plain_text: "new typing" };
    const result = await enqueueGuardedTranscriptEditSnapshot(command());
    expect(result.draft?.plain_text).toBe("new typing"); expect(state.queue[0].plain_text).toBe("  Corrected text.\n");
  });

  it.each(["succeeded", "conflict"] as const)("requires refresh after %s against the cached base", async (queueStatus) => {
    const { state } = setup(); state.queue = [{ ...queueRow(), queue_status: queueStatus }];
    await expect(saveGuardedTranscriptEditDraft(command())).rejects.toMatchObject({ code: "EDITOR_REFRESH_REQUIRED" });
    await expect(enqueueGuardedTranscriptEditSnapshot({ ...command(), clientVersionId: SECOND_ID, plainText: "different" }))
      .rejects.toMatchObject({ code: "EDITOR_REFRESH_REQUIRED" });
    expect(state.draft).toBeNull();
  });

  it("retains an exhausted ambiguous operation and blocks replacement/discard", async () => {
    const { state } = setup(); state.queue = [{ ...queueRow(), queue_status: "failed", attempt_count: 5,
      last_error_code: "NETWORK_UNAVAILABLE" }]; state.draft = draftRow();
    await expect(enqueueGuardedTranscriptEditSnapshot({ ...command(), clientVersionId: SECOND_ID,
      expectedDraft: state.draft, plainText: "different" })).rejects.toMatchObject({ code: "EDITOR_OUTCOME_UNCONFIRMED" });
    await expect(discardGuardedTranscriptEditDraft({ ...context(), expectedDraft: state.draft }))
      .rejects.toMatchObject({ code: "EDITOR_OUTCOME_UNCONFIRMED" });
    expect(state.queue[0].attempt_count).toBe(5); expect(state.draft).not.toBeNull();
  });

  it("discards only a matching conflict draft and preserves the terminal outbox record", async () => {
    const { state } = setup(); state.draft = draftRow(); state.queue = [{ ...queueRow(), queue_status: "conflict" }];
    await discardGuardedTranscriptEditDraft({ ...context(), expectedDraft: state.draft });
    expect(state.draft).toBeNull(); expect(state.queue[0].queue_status).toBe("conflict");
  });

  it("blocks discard while a snapshot is pending", async () => {
    const { state } = setup(); state.draft = draftRow(); state.queue = [queueRow()];
    await expect(discardGuardedTranscriptEditDraft({ ...context(), expectedDraft: state.draft }))
      .rejects.toMatchObject({ code: "EDITOR_OPERATION_PENDING" });
    expect(state.draft).not.toBeNull();
  });

  it("rolls back when a lifecycle guard changes after writes", async () => {
    const { state, calls } = setup();
    const assertActive = jest.fn(() => {
      if (calls.length > 0) throw new TranscriptEditorError("EDITOR_CONTEXT_INACTIVE");
    });
    await expect(enqueueGuardedTranscriptEditSnapshot({ ...command(), assertActive }))
      .rejects.toMatchObject({ code: "EDITOR_CONTEXT_INACTIVE" });
    expect(state.queue).toEqual([]); expect(state.draft).toBeNull();
  });

  it.each(["blank", "unchanged", "same_id"])("rejects invalid new Save: %s", async (reason) => {
    const { calls } = setup(); const input = command();
    if (reason === "blank") input.plainText = "   ";
    if (reason === "unchanged") input.plainText = base.plain_text;
    if (reason === "same_id") input.clientVersionId = BASE_VERSION_ID;
    await expect(enqueueGuardedTranscriptEditSnapshot(input)).rejects.toBeInstanceOf(TranscriptEditorError);
    expect(calls).toEqual([]);
  });
});

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
