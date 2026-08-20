import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
  listTranscriptCurrentVersionSyncTargets,
  persistCurrentTranscriptVersionSnapshot,
} from "@/src/services/sqlite/repository";
import type {
  CurrentTranscriptVersionSnapshot,
  SyncedTranscriptSegment,
  SyncedTranscriptVersion,
  SyncedTranscriptVersionRecord,
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

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const PROVIDER_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const EDIT_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const SEGMENT_ID = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-08-19T00:00:00.000Z";

const currentVersion: SyncedTranscriptVersion = {
  id: EDIT_VERSION_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcription_run_id: RUN_ID,
  created_by: USER_ID,
  version: 2,
  version_origin: "user_edit",
  version_status: "final",
  parent_version_id: PROVIDER_VERSION_ID,
  plain_text: "corrected transcript",
  language_summary: { primaryLanguage: "en" },
  content_checksum_sha256: "b".repeat(64),
  is_current: true,
  created_at: NOW,
  updated_at: NOW,
};

const evidenceVersion: SyncedTranscriptVersionRecord = {
  id: PROVIDER_VERSION_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcription_run_id: RUN_ID,
  created_by: USER_ID,
  version: 1,
  version_origin: "provider",
  version_status: "final",
  parent_version_id: null,
  plain_text: "source transcript",
  language_summary: { primaryLanguage: "en" },
  content_checksum_sha256: "a".repeat(64),
  is_current: false,
  created_at: NOW,
  updated_at: NOW,
};

const evidenceSegment: SyncedTranscriptSegment = {
  id: SEGMENT_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcript_version_id: PROVIDER_VERSION_ID,
  segment_index: 0,
  start_ms: 0,
  end_ms: 1_000,
  text: "source transcript",
  language_code: "en",
  speaker_label: null,
  confidence: 0.9,
  provider_segment_id: null,
  created_at: NOW,
  updated_at: NOW,
};

const readySnapshot = (
  overrides: Partial<
    Extract<CurrentTranscriptVersionSnapshot, { kind: "ready" }>
  > = {},
): Extract<CurrentTranscriptVersionSnapshot, { kind: "ready" }> => ({
  kind: "ready",
  currentVersion,
  currentSegments: [],
  evidenceVersion,
  evidenceSegments: [evidenceSegment],
  ...overrides,
});

describe("generic current transcript SQLite persistence", () => {
  beforeEach(() => jest.clearAllMocks());

  it("discovers non-deleted local sessions for current-version pull", async () => {
    const getAllAsync = jest.fn(async () => [
      { workspace_id: WORKSPACE_ID, session_id: SESSION_ID },
    ]);
    mockedOpen.mockResolvedValue({ getAllAsync } as never);

    await expect(listTranscriptCurrentVersionSyncTargets()).resolves.toEqual([
      { workspace_id: WORKSPACE_ID, session_id: SESSION_ID },
    ]);
    expect(getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining("deleted_at IS NULL"),
    );
    expect(getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining("id AS session_id"),
    );
  });

  it("atomically switches current Full Text while preserving provider evidence", async () => {
    const calls: { sql: string; params: unknown }[] = [];
    const db = {
      getFirstAsync: jest.fn(async () => null),
      runAsync: jest.fn(async (sql: string, params?: unknown) => {
        calls.push({ sql, params });
        return { changes: 1 };
      }),
    };
    mockedOpen.mockResolvedValue(db as never);

    await persistCurrentTranscriptVersionSnapshot(readySnapshot());

    expect(mockedTransaction).toHaveBeenCalledWith(db, expect.any(Function));
    const sql = calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("INSERT INTO local_transcript_versions");
    expect(sql).toContain("SET is_current = 0");
    expect(sql).toContain("INSERT INTO local_transcript_segments");
    expect(sql).not.toContain("DELETE FROM local_transcript_versions");

    const versionInserts = calls.filter((call) =>
      call.sql.includes("INSERT INTO local_transcript_versions"),
    );
    expect(versionInserts).toHaveLength(2);
    expect(versionInserts[0].params).toEqual(
      expect.arrayContaining([PROVIDER_VERSION_ID, 0]),
    );
    expect(versionInserts[1].params).toEqual(
      expect.arrayContaining([EDIT_VERSION_ID, 1]),
    );

    const segmentDeletes = calls.filter((call) =>
      call.sql.includes(
        "DELETE FROM local_transcript_segments WHERE transcript_version_id",
      ),
    );
    expect(segmentDeletes).toHaveLength(2);
    expect(segmentDeletes.map((call) => call.params)).toEqual([
      [PROVIDER_VERSION_ID],
      [EDIT_VERSION_ID],
    ]);
  });

  it("does not downgrade a newer local immutable current version", async () => {
    const runAsync = jest.fn(async (_sql: string, _params?: unknown) => ({
      changes: 1,
    }));
    const getFirstAsync = jest.fn(async () => ({
      id: "88888888-8888-4888-8888-888888888888",
      version: 3,
    }));
    const db = { runAsync, getFirstAsync };
    mockedOpen.mockResolvedValue(db as never);

    await persistCurrentTranscriptVersionSnapshot(readySnapshot());

    expect(getFirstAsync).toHaveBeenCalledTimes(1);
    expect(runAsync).not.toHaveBeenCalled();
  });

  it("fails closed when one session/version number maps to a different local UUID", async () => {
    const runAsync = jest.fn(async (_sql: string, _params?: unknown) => ({
      changes: 1,
    }));
    const getFirstAsync = jest.fn(async () => ({
      id: "88888888-8888-4888-8888-888888888888",
      version: currentVersion.version,
    }));
    const db = { runAsync, getFirstAsync };
    mockedOpen.mockResolvedValue(db as never);

    await expect(
      persistCurrentTranscriptVersionSnapshot(readySnapshot()),
    ).rejects.toThrow(
      "The current transcript version identity conflicts with local history.",
    );

    expect(runAsync).not.toHaveBeenCalled();
  });

  it("never attaches provider timestamp segments to edited Full Text", async () => {
    mockedOpen.mockResolvedValue(null);

    await expect(
      persistCurrentTranscriptVersionSnapshot(
        readySnapshot({
          currentSegments: [
            { ...evidenceSegment, transcript_version_id: EDIT_VERSION_ID },
          ],
        }),
      ),
    ).rejects.toThrow("The current transcript snapshot is invalid.");
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("does not use transcription run equality as evidence ancestry validation", async () => {
    mockedOpen.mockResolvedValue(null);

    await expect(
      persistCurrentTranscriptVersionSnapshot(
        readySnapshot({
          evidenceVersion: {
            ...evidenceVersion,
            transcription_run_id: "88888888-8888-4888-8888-888888888888",
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("accepts provider evidence when current and evidence provenance are null", async () => {
    mockedOpen.mockResolvedValue(null);

    await expect(
      persistCurrentTranscriptVersionSnapshot(
        readySnapshot({
          currentVersion: { ...currentVersion, transcription_run_id: null },
          evidenceVersion: { ...evidenceVersion, transcription_run_id: null },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("persists a nullable-provenance current version without fabricating evidence", async () => {
    const calls: string[] = [];
    const db = {
      getFirstAsync: jest.fn(async () => null),
      runAsync: jest.fn(async (sql: string) => {
        calls.push(sql);
        return { changes: 1 };
      }),
    };
    mockedOpen.mockResolvedValue(db as never);

    await persistCurrentTranscriptVersionSnapshot(
      readySnapshot({
        currentVersion: {
          ...currentVersion,
          transcription_run_id: null,
          version_origin: "import",
        },
        evidenceVersion: null,
        evidenceSegments: [],
      }),
    );

    expect(
      calls.filter((sql) =>
        sql.includes("INSERT INTO local_transcript_versions"),
      ),
    ).toHaveLength(1);
    expect(
      calls.some((sql) =>
        sql.includes("INSERT INTO local_transcript_segments"),
      ),
    ).toBe(false);
  });
});
