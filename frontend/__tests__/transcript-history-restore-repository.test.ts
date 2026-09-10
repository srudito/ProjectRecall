import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
  prepareGuardedTranscriptHistoryRestoreDraft,
  type TranscriptEditDraftRow,
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
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";
const CURRENT_ID = "55555555-5555-4555-8555-555555555555";
const OLD_ID = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-09-11T00:00:00.000Z";
const SOURCE_TEXT = "  exact historical Full Text  ";
const SOURCE_CHECKSUM = "a".repeat(64);
const scope = { userId: USER_ID, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

const version = (
  id: string,
  versionNumber: number,
  plainText: string,
  current: boolean,
): Record<string, unknown> => ({
  id,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcription_run_id: null,
  created_by: USER_ID,
  version: versionNumber,
  version_origin: versionNumber === 1 ? "provider" : "user_edit",
  version_status: "final",
  parent_version_id: versionNumber === 1 ? null : OLD_ID,
  plain_text: plainText,
  language_summary: "{}",
  content_checksum_sha256: id === SOURCE_ID ? SOURCE_CHECKSUM : "b".repeat(64),
  is_current: current ? 1 : 0,
  created_at: NOW,
  updated_at: NOW,
});

const queueRow = (status: TranscriptEditQueueRow["queue_status"]): TranscriptEditQueueRow => ({
  id: OLD_ID,
  user_id: USER_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  expected_current_version_id: CURRENT_ID,
  plain_text: "Earlier outbound save",
  queue_status: status,
  attempt_count: status === "failed" ? 5 : 1,
  max_attempts: 5,
  next_retry_at: null,
  last_error_code: null,
  last_safe_error: null,
  created_at: NOW,
  updated_at: NOW,
});

const mockedOpenLocalDb = openLocalDb as jest.MockedFunction<typeof openLocalDb>;
const mockedTransaction = runSerializedLocalTransaction as jest.MockedFunction<
  typeof runSerializedLocalTransaction
>;

const command = () => ({
  scope,
  assertActive: jest.fn(),
  sourceVersionId: SOURCE_ID,
  sourceVersionNumber: 2,
  sourcePlainText: SOURCE_TEXT,
  sourceContentChecksumSha256: SOURCE_CHECKSUM,
});

const fixture = () => {
  const state = {
    current: version(CURRENT_ID, 3, "Current Full Text", true),
    source: version(SOURCE_ID, 2, SOURCE_TEXT, false) as Record<string, unknown> | null,
    draft: null as TranscriptEditDraftRow | null,
    queue: [] as TranscriptEditQueueRow[],
    deleted: false,
  };
  const writes: { sql: string; params: unknown[] }[] = [];
  const db = {
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM local_sessions")) {
        return {
          id: SESSION_ID,
          workspace_id: WORKSPACE_ID,
          status: "recorded",
          deleted_at: state.deleted ? NOW : null,
        };
      }
      if (sql.includes("FROM local_session_deletion_queue")) return null;
      if (sql.includes("FROM local_transcript_edit_drafts")) return state.draft;
      if (sql.includes("FROM local_transcript_versions")) {
        if (sql.includes("is_current = 1")) return state.current;
        if (sql.includes("id = ?") && params.at(-1) === state.source?.id) return state.source;
        return null;
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    getAllAsync: jest.fn(async (sql: string) => {
      if (sql.includes("FROM local_transcript_edit_queue")) {
        return state.queue.map((row) => ({ ...row }));
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      if (!sql.includes("INSERT INTO local_transcript_edit_drafts")) {
        throw new Error(`Unexpected write: ${sql}`);
      }
      state.draft = {
        user_id: String(params[0]),
        workspace_id: String(params[1]),
        session_id: String(params[2]),
        base_version_id: String(params[3]),
        plain_text: String(params[4]),
        created_at: String(params[5]),
        updated_at: String(params[6]),
      };
      return { changes: 1 };
    }),
  };
  mockedOpenLocalDb.mockResolvedValue(db as never);
  mockedTransaction.mockImplementation(async (_db, operation) => {
    const priorDraft = state.draft ? { ...state.draft } : null;
    const priorWrites = writes.length;
    try {
      return await operation();
    } catch (error) {
      state.draft = priorDraft;
      writes.splice(priorWrites);
      throw error;
    }
  });
  return { state, writes, db };
};

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(() => {
  mockedTransaction.mockImplementation(async (_db, operation) => operation());
});

describe("C2F.1 atomic historical restore draft repository", () => {
  it("creates one exact local draft based on the current version", async () => {
    const { state, writes } = fixture();

    const result = await prepareGuardedTranscriptHistoryRestoreDraft(command());

    expect(result).toEqual({
      kind: "draft_created",
      sourceVersionId: SOURCE_ID,
      baseVersionId: CURRENT_ID,
      draft: state.draft,
    });
    expect(state.draft).toMatchObject({
      base_version_id: CURRENT_ID,
      plain_text: SOURCE_TEXT,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain("INSERT INTO local_transcript_edit_drafts");
    expect(writes[0].sql).not.toContain("local_transcript_versions");
    expect(writes[0].sql).not.toContain("local_transcript_edit_queue");
  });

  it("re-reads and locks the selected source identity, text, and checksum", async () => {
    for (const kind of ["version", "text", "checksum"] as const) {
      const { state, writes } = fixture();
      if (kind === "version") state.source!.version = 9;
      if (kind === "text") state.source!.plain_text = "Changed historical text";
      if (kind === "checksum") state.source!.content_checksum_sha256 = "c".repeat(64);

      await expect(
        prepareGuardedTranscriptHistoryRestoreDraft(command()),
      ).rejects.toMatchObject({ code: "HISTORY_RESTORE_SOURCE_CHANGED" });
      expect(writes).toEqual([]);
    }
  });

  it.each([
    "self-parent",
    "invalid-created-at",
    "missing-user-edit-checksum",
    "malformed-checksum",
  ] as const)(
    "rejects malformed selected source shape: %s",
    async (
      kind:
        | "self-parent"
        | "invalid-created-at"
        | "missing-user-edit-checksum"
        | "malformed-checksum",
    ) => {
      const { state, writes } = fixture();
      if (kind === "self-parent") state.source!.parent_version_id = SOURCE_ID;
      if (kind === "invalid-created-at") state.source!.created_at = "invalid";
      if (kind === "missing-user-edit-checksum") {
        state.source!.content_checksum_sha256 = null;
      }
      if (kind === "malformed-checksum") {
        state.source!.content_checksum_sha256 = "invalid";
      }

      await expect(
        prepareGuardedTranscriptHistoryRestoreDraft(command()),
      ).rejects.toMatchObject({ code: "HISTORY_RESTORE_SOURCE_CHANGED" });
      expect(writes).toEqual([]);
    },
  );

  it("rejects a selected version that is no longer locally available", async () => {
    const { state, writes } = fixture();
    state.source = null;

    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft(command()),
    ).rejects.toMatchObject({ code: "HISTORY_RESTORE_SOURCE_UNAVAILABLE" });
    expect(writes).toEqual([]);
  });

  it("never overwrites an existing draft, even when its text is identical", async () => {
    const { state, writes } = fixture();
    state.draft = {
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      base_version_id: CURRENT_ID,
      plain_text: SOURCE_TEXT,
      created_at: NOW,
      updated_at: NOW,
    };

    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft(command()),
    ).rejects.toMatchObject({ code: "HISTORY_RESTORE_DRAFT_EXISTS" });
    expect(writes).toEqual([]);
  });

  it.each(["pending", "submitting"] as const)(
    "does not prepare a restore draft while a %s Save is unresolved",
    async (status: "pending" | "submitting") => {
      const { state, writes } = fixture();
      state.queue = [queueRow(status)];

      await expect(
        prepareGuardedTranscriptHistoryRestoreDraft(command()),
      ).rejects.toMatchObject({ code: "HISTORY_RESTORE_OPERATION_PENDING" });
      expect(writes).toEqual([]);
    },
  );

  it("preserves an exhausted ambiguous Save instead of replacing it", async () => {
    const { state, writes } = fixture();
    state.queue = [queueRow("failed")];

    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft(command()),
    ).rejects.toMatchObject({ code: "HISTORY_RESTORE_OUTCOME_UNCONFIRMED" });
    expect(writes).toEqual([]);
  });

  it.each(["succeeded", "conflict"] as const)(
    "requires a current-version refresh after a %s result on the cached base",
    async (status: "succeeded" | "conflict") => {
      const { state, writes } = fixture();
      state.queue = [queueRow(status)];

      await expect(
        prepareGuardedTranscriptHistoryRestoreDraft(command()),
      ).rejects.toMatchObject({ code: "HISTORY_RESTORE_REFRESH_REQUIRED" });
      expect(writes).toEqual([]);
    },
  );

  it("allows an unrelated completed operation from an older base", async () => {
    const { state } = fixture();
    state.queue = [{
      ...queueRow("succeeded"),
      expected_current_version_id: OLD_ID,
    }];

    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft(command()),
    ).resolves.toMatchObject({ kind: "draft_created", baseVersionId: CURRENT_ID });
  });

  it("rejects restoring the current or byte-identical content", async () => {
    const currentSelection = fixture();
    currentSelection.state.source = currentSelection.state.current;
    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft({
        ...command(),
        sourceVersionId: CURRENT_ID,
        sourceVersionNumber: 3,
        sourcePlainText: "Current Full Text",
        sourceContentChecksumSha256: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "HISTORY_RESTORE_UNCHANGED" });
    expect(currentSelection.writes).toEqual([]);

    const sameText = fixture();
    sameText.state.current.plain_text = SOURCE_TEXT;
    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft(command()),
    ).rejects.toMatchObject({ code: "HISTORY_RESTORE_UNCHANGED" });
    expect(sameText.writes).toEqual([]);
  });

  it("rolls the draft back when ownership becomes inactive before commit", async () => {
    const { state, writes } = fixture();
    const input = command();
    input.assertActive.mockImplementation(() => {
      if (writes.length > 0) {
        throw new TranscriptEditorError("EDITOR_CONTEXT_INACTIVE");
      }
    });

    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft(input),
    ).rejects.toMatchObject({ code: "HISTORY_RESTORE_CONTEXT_INACTIVE" });
    expect(state.draft).toBeNull();
    expect(writes).toEqual([]);
  });

  it("fails explicitly without SQLite and validates input before opening it", async () => {
    mockedOpenLocalDb.mockResolvedValueOnce(null);
    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft(command()),
    ).rejects.toMatchObject({ code: "HISTORY_RESTORE_STORAGE_UNAVAILABLE" });

    jest.clearAllMocks();
    await expect(
      prepareGuardedTranscriptHistoryRestoreDraft({
        ...command(),
        sourceVersionId: "invalid",
      }),
    ).rejects.toMatchObject({ code: "HISTORY_RESTORE_INPUT_INVALID" });
    expect(mockedOpenLocalDb).not.toHaveBeenCalled();
  });

  it("contains no current promotion, version mutation, segment write, or outbox insert", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/services/sqlite/repository.ts"),
      "utf8",
    );
    const start = source.indexOf(
      "export const prepareGuardedTranscriptHistoryRestoreDraft =",
    );
    const end = source.indexOf(
      "export const enqueueGuardedTranscriptEditSnapshot =",
      start,
    );
    const body = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("writeEditorDraftOnDb(");
    expect(body).not.toContain("UPDATE local_transcript_versions");
    expect(body).not.toContain("INSERT INTO local_transcript_versions");
    expect(body).not.toContain("local_transcript_segments");
    expect(body).not.toContain("INSERT INTO local_transcript_edit_queue");
  });
});
