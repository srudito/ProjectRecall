import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
  collectLocalAccountCleanupScope,
  deleteLocalAccountData,
  hardDeleteLocalSessionData,
} from "@/src/services/sqlite/repository";

jest.mock("@/src/services/sqlite/schema", () => ({
  openLocalDb: jest.fn(),
}));

jest.mock("@/src/services/sqlite/transaction", () => ({
  runSerializedLocalTransaction: jest.fn(
    async (_db: unknown, operation: () => Promise<void>) => operation(),
  ),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OWNED_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_OWNED_WORKSPACE_ID =
  "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const MEDIA_ID = "55555555-5555-4555-8555-555555555555";

const mockedOpenLocalDb = openLocalDb as jest.MockedFunction<
  typeof openLocalDb
>;
const mockedTransaction = runSerializedLocalTransaction as jest.MockedFunction<
  typeof runSerializedLocalTransaction
>;

describe("SQLite account cleanup scope", () => {
  const schemaSource = readFileSync(
    resolve(process.cwd(), "src/services/sqlite/schema.ts"),
    "utf8",
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("enables secure page deletion on the shared SQLite connection", () => {
    expect(schemaSource).toContain("PRAGMA secure_delete = ON;");
    expect(schemaSource.indexOf("PRAGMA secure_delete = ON;")).toBeLessThan(
      schemaSource.indexOf("await runMigrations(db)"),
    );
  });

  it("collects only owned workspace scopes and includes queued deletion file JSON", async () => {
    const getAllAsync = jest.fn(async (sql: string) => {
      if (sql.includes("FROM local_profiles")) {
        expect(sql).not.toContain("FROM local_notes WHERE created_by");
        return [{ value: OWNED_WORKSPACE_ID }];
      }
      if (sql.includes("SELECT id AS value") && sql.includes("local_sessions")) {
        expect(sql).not.toContain("created_by = ?");
        expect(sql).not.toContain("user_id = ?");
        return [{ value: SESSION_ID }];
      }
      if (sql.includes("SELECT id AS value") && sql.includes("local_media_assets")) {
        return [{ value: MEDIA_ID }];
      }
      if (sql.includes("SELECT local_file_uri AS value")) {
        return [
          { value: "file:///app/documents/sessions/original.m4a" },
          { value: "file:///app/cache/staged-upload.bin" },
        ];
      }
      if (sql.includes("SELECT local_file_uris AS value")) {
        return [
          {
            value: JSON.stringify([
              "file:///app/documents/sessions/pending-delete.m4a",
              "file:///app/documents/sessions/pending-delete.m4a",
            ]),
          },
          { value: "not-json" },
        ];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    mockedOpenLocalDb.mockResolvedValue({ getAllAsync } as never);

    await expect(
      collectLocalAccountCleanupScope(USER_ID, [
        SECOND_OWNED_WORKSPACE_ID,
      ]),
    ).resolves.toEqual({
      workspaceIds: [OWNED_WORKSPACE_ID, SECOND_OWNED_WORKSPACE_ID].sort(),
      sessionIds: [SESSION_ID],
      mediaAssetIds: [MEDIA_ID],
      localFileUris: [
        "file:///app/cache/staged-upload.bin",
        "file:///app/documents/sessions/original.m4a",
        "file:///app/documents/sessions/pending-delete.m4a",
      ],
    });

    const workspaceQuery = getAllAsync.mock.calls[0][0] as string;
    expect(workspaceQuery).toContain("FROM local_profiles");
    expect(workspaceQuery).not.toContain("local_projects");
    expect(workspaceQuery).not.toContain("local_notes");
  });

  it("deletes only rows owned by the user, owned workspaces, or owned sessions", async () => {
    const runAsync = jest.fn(
      async (_sql: string, _params?: readonly unknown[]): Promise<void> =>
        undefined,
    );
    const getFirstAsync = jest.fn(async () => ({
      busy: 0,
      log: 0,
      checkpointed: 0,
    }));
    const db = { runAsync, getFirstAsync };
    mockedOpenLocalDb.mockResolvedValue(db as never);

    await deleteLocalAccountData({
      userId: USER_ID,
      workspaceIds: [OWNED_WORKSPACE_ID],
      sessionIds: [SESSION_ID],
    });

    expect(mockedTransaction).toHaveBeenCalledWith(db, expect.any(Function));
    const sql = runAsync.mock.calls.map(([statement]) => statement).join("\n");

    for (const tableName of [
      "local_transcript_segments",
      "local_transcript_edit_queue",
      "local_transcript_edit_drafts",
      "local_transcript_versions",
      "local_transcription_runs",
      "local_processing_jobs",
      "local_transcription_request_queue",
      "local_metadata_sync_queue",
      "local_upload_queue",
      "local_session_deletion_queue",
      "local_session_user_preferences",
      "local_timeline_events",
      "local_notes",
      "local_bookmarks",
      "local_media_assets",
      "local_recordings",
      "local_sessions",
      "local_projects",
      "local_profiles",
    ]) {
      expect(sql).toContain(`DELETE FROM ${tableName}`);
    }

    expect(sql).toContain("WHERE created_by = ?");
    expect(
      runAsync.mock.calls.find(([statement]) =>
        statement.includes("DELETE FROM local_processing_jobs"),
      )?.[0],
    ).toContain("WHERE created_by = ?");
    expect(sql).toContain("WHERE added_by = ?");
    expect(sql).toContain("WHERE user_id = ?");

    const sessionDelete = runAsync.mock.calls.find(([statement]) =>
      statement.includes("DELETE FROM local_sessions"),
    )?.[0];
    const projectDelete = runAsync.mock.calls.find(([statement]) =>
      statement.includes("DELETE FROM local_projects"),
    )?.[0];
    expect(sessionDelete).not.toContain("created_by = ?");
    expect(projectDelete).not.toContain("created_by = ?");
    expect(getFirstAsync).toHaveBeenCalledWith(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    );

    expect(sql).not.toContain("DELETE FROM local_user_preferences");
    expect(sql).not.toContain("DELETE FROM local_sync_state");

    const deletesWholeLocalMetaTable = runAsync.mock.calls.some(
      ([statement]) =>
        /^\s*DELETE\s+FROM\s+local_meta(?:\s|$)/i.test(statement),
    );
    expect(deletesWholeLocalMetaTable).toBe(false);
  });

  it("removes local transcription rows before hard-deleting a session", async () => {
    const runAsync = jest.fn(
      async (_sql: string, _params?: readonly unknown[]): Promise<void> =>
        undefined,
    );
    const db = { runAsync };
    mockedOpenLocalDb.mockResolvedValue(db as never);

    await hardDeleteLocalSessionData(SESSION_ID);

    const sqlStatements = runAsync.mock.calls.map(([statement]) =>
      String(statement),
    );
    const joinedSql = sqlStatements.join("\n");

    for (const tableName of [
      "local_transcript_segments",
      "local_transcript_edit_queue",
      "local_transcript_edit_drafts",
      "local_transcript_versions",
      "local_transcription_runs",
      "local_processing_jobs",
      "local_transcription_request_queue",
    ]) {
      expect(joinedSql).toContain(`DELETE FROM ${tableName}`);
    }

    const sessionDeleteIndex = sqlStatements.findIndex((statement) =>
      statement.includes("DELETE FROM local_sessions"),
    );

    for (const tableName of [
      "local_transcript_segments",
      "local_transcript_edit_queue",
      "local_transcript_edit_drafts",
      "local_transcript_versions",
      "local_transcription_runs",
      "local_processing_jobs",
      "local_transcription_request_queue",
    ]) {
      expect(
        sqlStatements.findIndex((statement) =>
          statement.includes(`DELETE FROM ${tableName}`),
        ),
      ).toBeLessThan(sessionDeleteIndex);
    }
  });

  it("fails closed when the WAL cannot be truncated after scoped cleanup", async () => {
    const runAsync = jest.fn(
      async (_sql: string, _params?: readonly unknown[]): Promise<void> =>
        undefined,
    );
    const getFirstAsync = jest.fn(async () => ({
      busy: 1,
      log: 2,
      checkpointed: 1,
    }));
    mockedOpenLocalDb.mockResolvedValue({
      runAsync,
      getFirstAsync,
    } as never);

    await expect(
      deleteLocalAccountData({
        userId: USER_ID,
        workspaceIds: [OWNED_WORKSPACE_ID],
        sessionIds: [SESSION_ID],
      }),
    ).rejects.toThrow(
      "The local account cleanup WAL checkpoint did not finish.",
    );
  });
});
