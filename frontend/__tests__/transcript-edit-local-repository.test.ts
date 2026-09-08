import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
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
