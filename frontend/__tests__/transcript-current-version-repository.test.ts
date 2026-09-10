import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
  getTranscriptVersionByIdForSession,
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
): Extract<CurrentTranscriptVersionSnapshot, { kind: "ready" }> => {
  const snapshot: Extract<
    CurrentTranscriptVersionSnapshot,
    { kind: "ready" }
  > = {
    kind: "ready",
    currentVersion,
    currentSegments: [],
    currentExpectedSegmentCount: 0,
    intermediateVersions: [],
    evidenceVersion,
    evidenceSegments: [evidenceSegment],
    evidenceExpectedSegmentCount: 1,
    ...overrides,
  };
  return {
    ...snapshot,
    currentExpectedSegmentCount:
      overrides.currentExpectedSegmentCount ?? snapshot.currentSegments.length,
    evidenceExpectedSegmentCount: Object.prototype.hasOwnProperty.call(
      overrides,
      "evidenceExpectedSegmentCount",
    )
      ? (overrides.evidenceExpectedSegmentCount ?? null)
      : snapshot.evidenceVersion
        ? snapshot.evidenceSegments.length
        : null,
  };
};

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
      getAllAsync: jest.fn(async () => []),
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
    expect(sql).toContain("SET is_current = 1");
    expect(sql).not.toContain("SET is_current = 0");
    expect(sql).toContain("INSERT INTO local_transcript_segments");
    expect(sql).not.toContain("DELETE FROM local_transcript_segments");
    expect(sql).not.toContain("ON CONFLICT");

    const versionInserts = calls.filter((call) =>
      call.sql.includes("INSERT INTO local_transcript_versions"),
    );
    expect(versionInserts).toHaveLength(2);
    expect(versionInserts[0].params).toEqual(
      expect.arrayContaining([PROVIDER_VERSION_ID, 0]),
    );
    expect(versionInserts[1].params).toEqual(
      expect.arrayContaining([EDIT_VERSION_ID, 0]),
    );

    const segmentInserts = calls.filter((call) =>
      call.sql.includes("INSERT INTO local_transcript_segments"),
    );
    expect(segmentInserts).toHaveLength(1);
    expect(segmentInserts[0].params).toEqual(
      expect.arrayContaining([SEGMENT_ID, PROVIDER_VERSION_ID]),
    );
  });

  it("appends only missing provider segments on an exact replay", async () => {
    const secondSegment: SyncedTranscriptSegment = {
      ...evidenceSegment,
      id: "99999999-9999-4999-8999-999999999999",
      segment_index: 1,
      start_ms: 1_001,
      end_ms: 2_000,
      text: "continued",
    };
    const stored = (version: SyncedTranscriptVersionRecord) => ({
      ...version,
      language_summary: JSON.stringify(version.language_summary),
      is_current: version.is_current ? 1 : 0,
    });
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      getFirstAsync: jest.fn(async () => ({
        id: EDIT_VERSION_ID,
        workspace_id: WORKSPACE_ID,
        version: currentVersion.version,
      })),
      getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("WHERE id IN")) return [];
        if (sql.includes("FROM local_transcript_versions")) {
          if (params[0] === PROVIDER_VERSION_ID) return [stored(evidenceVersion)];
          if (params[0] === EDIT_VERSION_ID) return [stored(currentVersion)];
        }
        if (sql.includes("FROM local_transcript_segments")) {
          return params[0] === PROVIDER_VERSION_ID ? [evidenceSegment] : [];
        }
        return [];
      }),
      runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { changes: 1 };
      }),
    };
    mockedOpen.mockResolvedValue(db as never);

    await persistCurrentTranscriptVersionSnapshot(
      readySnapshot({ evidenceSegments: [evidenceSegment, secondSegment] }),
    );

    const segmentInserts = calls.filter((call) =>
      call.sql.includes("INSERT INTO local_transcript_segments"),
    );
    expect(segmentInserts).toHaveLength(1);
    expect(segmentInserts[0].params[0]).toBe(secondSegment.id);
    expect(calls.some((call) => call.sql.includes("ON CONFLICT"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("DELETE FROM"))).toBe(false);
  });

  it("rejects changed immutable provider evidence before any write", async () => {
    const runAsync = jest.fn();
    const db = {
      getFirstAsync: jest.fn(async () => ({
        id: EDIT_VERSION_ID,
        workspace_id: WORKSPACE_ID,
        version: currentVersion.version,
      })),
      getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (
          sql.includes("FROM local_transcript_versions") &&
          params[0] === PROVIDER_VERSION_ID
        ) {
          return [
            {
              ...evidenceVersion,
              plain_text: "changed evidence",
              language_summary: JSON.stringify(
                evidenceVersion.language_summary,
              ),
              is_current: 0,
            },
          ];
        }
        return [];
      }),
      runAsync,
    };
    mockedOpen.mockResolvedValue(db as never);

    await expect(
      persistCurrentTranscriptVersionSnapshot(readySnapshot()),
    ).rejects.toThrow("The current transcript conflicts with local history.");
    expect(runAsync).not.toHaveBeenCalled();
  });

  it("does not downgrade a newer local immutable current version", async () => {
    const runAsync = jest.fn(async (_sql: string, _params?: unknown) => ({
      changes: 1,
    }));
    const getFirstAsync = jest.fn(async () => ({
      id: "88888888-8888-4888-8888-888888888888",
      workspace_id: WORKSPACE_ID,
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
      workspace_id: WORKSPACE_ID,
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
      getAllAsync: jest.fn(async () => []),
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
          parent_version_id: null,
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

describe("3D.1 complete local transcript ancestry", () => {
  const EDIT3_ID = "88888888-8888-4888-8888-888888888888";
  const intermediate: SyncedTranscriptVersionRecord = { ...currentVersion, is_current: false };
  const chain = (): Extract<CurrentTranscriptVersionSnapshot, { kind: "ready" }> => readySnapshot({
    currentVersion: { ...currentVersion, id: EDIT3_ID, version: 3, parent_version_id: EDIT_VERSION_ID },
    intermediateVersions: [intermediate],
  });

  beforeEach(() => jest.clearAllMocks());

  it("persists an unseen intermediate parent in the same snapshot transaction", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      getFirstAsync: jest.fn(async (_sql: string, _params?: unknown[]) => null),
      getAllAsync: jest.fn(async () => []),
      runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { changes: 1 };
      }),
    };
    mockedOpen.mockResolvedValue(db as never);
    const snapshot = chain();
    await persistCurrentTranscriptVersionSnapshot(snapshot);

    expect(mockedTransaction).toHaveBeenCalledTimes(1);
    expect(mockedTransaction).toHaveBeenCalledWith(db, expect.any(Function));
    const inserts = calls.filter((call) => call.sql.includes("INSERT INTO local_transcript_versions"));
    expect(inserts.map((call) => [call.params[0], call.params[12]])).toEqual([
      [PROVIDER_VERSION_ID, 0], [EDIT_VERSION_ID, 0], [EDIT3_ID, 0],
    ]);
    expect(inserts[1].params[8]).toBe(PROVIDER_VERSION_ID);
    expect(snapshot.intermediateVersions).toEqual([intermediate]);
    const segmentInserts = calls.filter((call) => call.sql.includes("INSERT INTO local_transcript_segments"));
    expect(segmentInserts).toHaveLength(1);
    expect(segmentInserts[0].params[3]).toBe(PROVIDER_VERSION_ID);
  });

  it("does not erase timestamp rows of an intermediate import it did not fetch", async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    mockedOpen.mockResolvedValue({
      getFirstAsync: jest.fn(async () => null),
      getAllAsync: jest.fn(async () => []),
      runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        return { changes: 1 };
      }),
    } as never);
    await persistCurrentTranscriptVersionSnapshot({
      ...chain(), intermediateVersions: [{ ...intermediate, version_origin: "import" }],
    });
    const sql = statements.map((call) => call.sql).join("\n");
    expect(sql).not.toContain("DELETE FROM local_transcript_segments");
    expect(sql).not.toContain("ON CONFLICT");
  });

  it("accepts a complete terminal-import path without provider evidence", async () => {
    const runAsync = jest.fn(async (_sql: string, _params?: unknown[]) => ({ changes: 1 }));
    mockedOpen.mockResolvedValue({
      getFirstAsync: jest.fn(async () => null),
      getAllAsync: jest.fn(async () => []),
      runAsync,
    } as never);
    await expect(persistCurrentTranscriptVersionSnapshot({
      ...chain(),
      intermediateVersions: [{ ...intermediate, version_origin: "import", parent_version_id: null }],
      evidenceVersion: null,
      evidenceSegments: [],
      evidenceExpectedSegmentCount: null,
    })).resolves.toBeUndefined();
    expect(runAsync).toHaveBeenCalled();
  });

  const badParents: { label: string; patch: Partial<SyncedTranscriptVersionRecord> }[] = [
    { label: "identity", patch: { id: SEGMENT_ID } },
    { label: "workspace", patch: { workspace_id: RUN_ID } },
    { label: "session", patch: { session_id: RUN_ID } },
    { label: "current marker", patch: { is_current: true } },
    { label: "draft", patch: { version_status: "draft" } },
    { label: "equal version", patch: { version: 3 } },
    { label: "noninteger version", patch: { version: 1.5 } },
    { label: "provider in intermediates", patch: { version_origin: "provider" } },
    { label: "self parent", patch: { parent_version_id: EDIT_VERSION_ID } },
  ];
  it.each(badParents)("rejects the intermediate $label before opening SQLite", async ({ patch }) => {
    await expect(persistCurrentTranscriptVersionSnapshot({
      ...chain(), intermediateVersions: [{ ...intermediate, ...patch }],
    })).rejects.toThrow("The transcript ancestry snapshot is invalid.");
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("rejects a missing intermediate instead of treating the provider as a direct parent", async () => {
    await expect(persistCurrentTranscriptVersionSnapshot({
      ...chain(), intermediateVersions: [],
    })).rejects.toThrow("The transcript ancestry snapshot is invalid.");
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it("rejects a truncated no-evidence snapshot and a repeated ancestor", async () => {
    await expect(persistCurrentTranscriptVersionSnapshot({
      ...chain(), evidenceVersion: null, evidenceSegments: [],
      evidenceExpectedSegmentCount: null,
    })).rejects.toThrow("The transcript ancestry snapshot is invalid.");
    await expect(persistCurrentTranscriptVersionSnapshot({
      ...chain(), intermediateVersions: [intermediate, intermediate],
    })).rejects.toThrow("The transcript ancestry snapshot is invalid.");
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it("enforces the same 64-link cap as remote pull and local evidence reads", async () => {
    const id = (index: number) =>
      `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`;
    const parents = Array.from({ length: 64 }, (_, index) => ({
      ...intermediate, id: id(index + 1), version: 65 - index,
      parent_version_id: index === 63 ? PROVIDER_VERSION_ID : id(index + 2),
    }));
    await expect(persistCurrentTranscriptVersionSnapshot({
      ...chain(),
      currentVersion: { ...chain().currentVersion, version: 66, parent_version_id: id(1) },
      intermediateVersions: parents,
    })).rejects.toThrow("The transcript ancestry snapshot is invalid.");
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it("backfills intermediate parents when the same current version is already cached", async () => {
    const snapshot = chain();
    const runAsync = jest.fn(async (_sql: string, _params?: unknown[]) => ({ changes: 1 }));
    const getAllAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM local_transcript_versions") && params[0] === EDIT3_ID) {
        return [{
          ...snapshot.currentVersion,
          language_summary: JSON.stringify(snapshot.currentVersion.language_summary),
          is_current: 1,
        }];
      }
      return [];
    });
    mockedOpen.mockResolvedValue({
      getFirstAsync: jest.fn(async () => ({
        id: EDIT3_ID,
        workspace_id: WORKSPACE_ID,
        version: 3,
      })),
      getAllAsync,
      runAsync,
    } as never);
    await persistCurrentTranscriptVersionSnapshot(snapshot);
    const parentInsert = runAsync.mock.calls.find(([sql, params]) =>
      sql.includes("INSERT INTO local_transcript_versions") && params?.[0] === EDIT_VERSION_ID,
    );
    expect(parentInsert?.[1]?.[12]).toBe(0);
    expect(parentInsert?.[1]?.[8]).toBe(PROVIDER_VERSION_ID);
  });

  it("preserves the stale-snapshot guard before all ancestor writes", async () => {
    const runAsync = jest.fn();
    mockedOpen.mockResolvedValue({
      getFirstAsync: jest.fn(async () => ({
        id: SEGMENT_ID,
        workspace_id: WORKSPACE_ID,
        version: 4,
      })),
      runAsync,
    } as never);
    await persistCurrentTranscriptVersionSnapshot(chain());
    expect(runAsync).not.toHaveBeenCalled();
  });

  it("reads an exact scoped non-current row without fabricating a true marker", async () => {
    const getFirstAsync = jest.fn(async (_sql: string, _params?: unknown[]) => ({
      ...intermediate,
      transcription_run_id: null,
      created_by: null,
      language_summary: JSON.stringify(intermediate.language_summary),
      is_current: 0,
    }));
    mockedOpen.mockResolvedValue({ getFirstAsync } as never);
    const input = { versionId: EDIT_VERSION_ID, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
    await expect(getTranscriptVersionByIdForSession(input)).resolves.toEqual({
      ...intermediate, transcription_run_id: null, created_by: null,
    });
    expect(getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = ? AND workspace_id = ? AND session_id = ?"),
      [EDIT_VERSION_ID, WORKSPACE_ID, SESSION_ID],
    );
  });

  it("returns null for a missing scoped row and rejects a scope/malformed-marker response", async () => {
    const input = { versionId: EDIT_VERSION_ID, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
    const getFirstAsync = jest.fn(async (_sql: string, _params?: unknown[]) => null as unknown);
    mockedOpen.mockResolvedValue({ getFirstAsync } as never);
    await expect(getTranscriptVersionByIdForSession(input)).resolves.toBeNull();
    getFirstAsync.mockResolvedValue({ ...intermediate, workspace_id: RUN_ID, is_current: 0 });
    await expect(getTranscriptVersionByIdForSession(input)).rejects.toThrow("The cached transcript version scope is invalid.");
    getFirstAsync.mockResolvedValue({ ...intermediate, is_current: 2 });
    await expect(getTranscriptVersionByIdForSession(input)).rejects.toThrow("The cached transcript version scope is invalid.");
  });
});
