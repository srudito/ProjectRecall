import { createHash } from "node:crypto";
import * as Crypto from "expo-crypto";

import { openLocalDb } from "@/src/services/sqlite/schema";
import { runSerializedLocalTransaction } from "@/src/services/sqlite/transaction";
import {
  persistCompletedTranscriptionResult,
  persistTranscriptionResultProgress,
} from "@/src/services/sqlite/repository";
import {
  encodeTranscriptionResultReceipt,
  type ResultReceiptRow,
} from "@/src/services/transcription/result-receipt";
import type {
  SyncedProcessingJob,
  SyncedTranscriptSegment,
  SyncedTranscriptVersionRecord,
  SyncedTranscriptionRun,
} from "@/src/services/transcription/result-types";

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: jest.fn(),
}));
jest.mock("@/src/services/sqlite/schema", () => ({ openLocalDb: jest.fn() }));
jest.mock("@/src/services/sqlite/transaction", () => {
  class LocalWriteRecoveryError extends Error {}
  return {
    LocalWriteRecoveryError,
    runSerializedLocalMutation: jest.fn(
      async (_db: unknown, operation: () => Promise<unknown>) => operation(),
    ),
    runSerializedLocalTransaction: jest.fn(
      async (
        db: { __snapshot?: () => unknown; __restore?: (value: unknown) => void },
        operation: () => Promise<unknown>,
      ) => {
        const snapshot = db.__snapshot?.();
        try {
          return await operation();
        } catch (failure) {
          if (snapshot !== undefined) db.__restore?.(snapshot);
          throw failure;
        }
      },
    ),
  };
});

const digest = Crypto.digestStringAsync as jest.MockedFunction<
  typeof Crypto.digestStringAsync
>;
const mockedOpen = openLocalDb as jest.MockedFunction<typeof openLocalDb>;
const mockedTransaction = runSerializedLocalTransaction as jest.MockedFunction<
  typeof runSerializedLocalTransaction
>;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RECORDING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RUN = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const VERSION = "11111111-1111-4111-8111-111111111111";
const SEGMENT_A = "22222222-2222-4222-8222-222222222222";
const SEGMENT_B = "33333333-3333-4333-8333-333333333333";
const QUEUE = "queue-request-A";
const NOW = "2026-09-10T12:00:00.123456Z";
const LATER = "2026-09-10T12:00:00.123457Z";
const TEXT = "hello world";
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const job: SyncedProcessingJob = {
  id: JOB,
  workspace_id: WORKSPACE,
  session_id: SESSION,
  recording_id: RECORDING,
  created_by: USER,
  job_type: "batch_transcription",
  status: "succeeded",
  idempotency_key: "batch-transcription:test",
  priority: 100,
  attempt_count: 1,
  max_attempts: 5,
  next_attempt_at: null,
  lease_owner: null,
  lease_expires_at: null,
  started_at: NOW,
  completed_at: NOW,
  cancelled_at: null,
  last_error_code: null,
  last_safe_error: null,
  request_payload: {},
  created_at: NOW,
  updated_at: NOW,
};
const run: SyncedTranscriptionRun = {
  id: RUN,
  processing_job_id: JOB,
  workspace_id: WORKSPACE,
  session_id: SESSION,
  recording_id: RECORDING,
  created_by: USER,
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
  started_at: NOW,
  completed_at: NOW,
  last_error_code: null,
  last_safe_error: null,
  created_at: NOW,
  updated_at: NOW,
};
const version = (
  patch: Partial<SyncedTranscriptVersionRecord> = {},
): SyncedTranscriptVersionRecord => ({
  id: VERSION,
  workspace_id: WORKSPACE,
  session_id: SESSION,
  transcription_run_id: RUN,
  created_by: USER,
  version: 1,
  version_origin: "provider",
  version_status: "final",
  parent_version_id: null,
  plain_text: TEXT,
  language_summary: { primaryLanguage: "en" },
  content_checksum_sha256: hash(TEXT),
  is_current: true,
  created_at: NOW,
  updated_at: NOW,
  ...patch,
});
const segment = (
  index: number,
  patch: Partial<SyncedTranscriptSegment> = {},
): SyncedTranscriptSegment => ({
  id: index === 0 ? SEGMENT_A : SEGMENT_B,
  workspace_id: WORKSPACE,
  session_id: SESSION,
  transcript_version_id: VERSION,
  segment_index: index,
  start_ms: index * 100,
  end_ms: index * 100 + 90,
  text: index === 0 ? "hello" : "world",
  language_code: "en",
  speaker_label: null,
  confidence: 0.9,
  provider_segment_id: null,
  created_at: NOW,
  updated_at: NOW,
  ...patch,
});
const request = {
  id: QUEUE,
  user_id: USER,
  workspace_id: WORKSPACE,
  session_id: SESSION,
  recording_id: RECORDING,
  server_job_id: JOB,
  queue_status: "submitted",
};
const resultInput = (
  patch: Partial<Parameters<typeof persistCompletedTranscriptionResult>[0]> = {},
): Parameters<typeof persistCompletedTranscriptionResult>[0] => ({
  userId: USER,
  queueId: QUEUE,
  job,
  run,
  version: version(),
  segments: [segment(0)],
  expectedSegmentCount: 1,
  reconciledAt: NOW,
  ...patch,
});

type StoredVersion = Omit<SyncedTranscriptVersionRecord, "language_summary" | "is_current"> & {
  language_summary: string;
  is_current: number;
};
interface State {
  versions: StoredVersion[];
  segments: SyncedTranscriptSegment[];
  receipts: ResultReceiptRow[];
}
const storedVersion = (
  value: SyncedTranscriptVersionRecord,
  isCurrent = value.is_current,
): StoredVersion => ({
  ...value,
  language_summary: JSON.stringify(value.language_summary),
  is_current: isCurrent ? 1 : 0,
});
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const fixture = (initial: Partial<State> = {}) => {
  let state: State = {
    versions: clone(initial.versions ?? []),
    segments: clone(initial.segments ?? []),
    receipts: clone(initial.receipts ?? []),
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  const control = { failReceiptInsert: false };
  const db = {
    __snapshot: () => clone(state),
    __restore: (value: unknown) => {
      state = clone(value as State);
    },
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM local_sessions")) {
        return { id: SESSION, workspace_id: WORKSPACE, status: "recorded", deleted_at: null };
      }
      if (sql.includes("FROM local_session_deletion_queue")) return null;
      if (sql.includes("FROM local_transcription_request_queue")) return { ...request };
      if (sql.includes("FROM local_sync_state")) {
        return clone(state.receipts.find((row) => row.key === params[0]) ?? null);
      }
      throw new Error(`Unexpected getFirstAsync SQL: ${sql}`);
    }),
    getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM local_transcript_versions") && sql.includes("is_current = 1")) {
        return clone(state.versions
          .filter((row) => row.session_id === params[0] && row.is_current === 1)
          .map((row) => ({ id: row.id, workspace_id: row.workspace_id, version: row.version })));
      }
      if (sql.includes("FROM local_transcript_versions")) {
        return clone(state.versions.filter(
          (row) => row.id === params[0] ||
            (row.session_id === params[1] && row.version === params[2]),
        ));
      }
      if (sql.includes("WHERE id IN")) {
        return clone(state.segments
          .filter((row) => params.includes(row.id))
          .map((row) => ({ id: row.id })));
      }
      if (sql.includes("FROM local_transcript_segments")) {
        return clone(state.segments.filter((row) => row.transcript_version_id === params[0]));
      }
      throw new Error(`Unexpected getAllAsync SQL: ${sql}`);
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params: clone(params) });
      if (control.failReceiptInsert && sql.startsWith("INSERT INTO local_sync_state")) {
        throw new Error("PRIVATE RECEIPT WRITE FAILURE");
      }
      if (sql.startsWith("INSERT INTO local_processing_jobs") ||
          sql.startsWith("INSERT INTO local_transcription_runs")) {
        return { changes: 1 };
      }
      if (sql.startsWith("INSERT INTO local_transcript_versions")) {
        const columns = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")\n")).split(",").map((value) => value.trim());
        state.versions.push(Object.fromEntries(columns.map((key, index) => [key, params[index]])) as StoredVersion);
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE local_transcript_versions") && sql.includes("created_by = ?")) {
        const row = state.versions.find((value) =>
          value.id === params[3] && value.workspace_id === params[4] && value.session_id === params[5]);
        if (!row) return { changes: 0 };
        row.created_by = params[0] as string | null;
        row.transcription_run_id = params[1] as string | null;
        row.updated_at = params[2] as string;
        return { changes: 1 };
      }
      if (sql.startsWith("INSERT INTO local_transcript_segments")) {
        const columns = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")\n")).split(",").map((value) => value.trim());
        state.segments.push(
          Object.fromEntries(
            columns.map((key, index) => [key, params[index]]),
          ) as unknown as SyncedTranscriptSegment,
        );
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE local_transcript_versions SET is_current = 0")) {
        const row = state.versions.find((value) =>
          value.id === params[0] && value.workspace_id === params[1] &&
          value.session_id === params[2] && value.is_current === 1);
        if (!row) return { changes: 0 };
        row.is_current = 0;
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE local_transcript_versions SET is_current = 1")) {
        const row = state.versions.find((value) =>
          value.id === params[0] && value.workspace_id === params[1] &&
          value.session_id === params[2] && value.is_current === 0);
        if (!row) return { changes: 0 };
        row.is_current = 1;
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE local_transcription_request_queue")) {
        return { changes: 1 };
      }
      if (sql.startsWith("INSERT INTO local_sync_state")) {
        state.receipts.push({
          key: params[0] as string,
          value: params[1] as string,
          updated_at: params[2] as string,
        });
        return { changes: 1 };
      }
      throw new Error(`Unexpected runAsync SQL: ${sql}`);
    }),
  };
  mockedOpen.mockResolvedValue(db as never);
  return { db, calls, control, state: () => state };
};

beforeEach(() => {
  jest.clearAllMocks();
  digest.mockReset();
  digest.mockImplementation(
    async (_algorithm: Crypto.CryptoDigestAlgorithm, value: string) =>
      hash(value),
  );
});

describe("C2B.1 atomic SQLite result reconciliation", () => {
  it("commits immutable evidence, current authority, diagnostics, and receipt together", async () => {
    const f = fixture();
    await persistCompletedTranscriptionResult(resultInput());

    expect(mockedTransaction).toHaveBeenCalledWith(f.db, expect.any(Function));
    expect(f.state().versions).toHaveLength(1);
    expect(f.state().versions[0]).toMatchObject({
      id: VERSION,
      plain_text: TEXT,
      is_current: 1,
    });
    expect(f.state().segments).toEqual([segment(0)]);
    expect(f.state().receipts).toHaveLength(1);
    expect(JSON.parse(f.state().receipts[0].value)).toMatchObject({
      userId: USER,
      requestId: QUEUE,
      resultVersionId: VERSION,
      expectedSegments: 1,
    });

    const evidenceSql = f.calls
      .filter(({ sql }) => /local_transcript_(?:versions|segments)/.test(sql))
      .map(({ sql }) => sql)
      .join("\n");
    expect(evidenceSql).not.toContain("DELETE FROM local_transcript_segments");
    expect(evidenceSql).not.toContain("ON CONFLICT");
    expect(f.calls.map(({ sql }) => sql).join("\n")).toContain(
      "INSERT INTO local_sync_state",
    );
  });

  it("replays without rewriting evidence or replacing the first receipt time", async () => {
    const f = fixture();
    await persistCompletedTranscriptionResult(resultInput());
    const firstReceipt = clone(f.state().receipts[0]);
    const evidenceWritesBefore = f.calls.filter(({ sql }) =>
      sql.startsWith("INSERT INTO local_transcript_versions") ||
      sql.startsWith("INSERT INTO local_transcript_segments"));

    await persistCompletedTranscriptionResult(resultInput({ reconciledAt: LATER }));

    const evidenceWritesAfter = f.calls.filter(({ sql }) =>
      sql.startsWith("INSERT INTO local_transcript_versions") ||
      sql.startsWith("INSERT INTO local_transcript_segments"));
    expect(evidenceWritesAfter).toHaveLength(evidenceWritesBefore.length);
    expect(f.state().receipts).toEqual([firstReceipt]);
    expect(f.state().receipts[0].updated_at).toBe(NOW);
  });

  it("appends only missing exact segments", async () => {
    const base = version({ is_current: false });
    const f = fixture({
      versions: [storedVersion(base, false)],
      segments: [segment(0)],
    });
    await persistCompletedTranscriptionResult(resultInput({
      version: base,
      segments: [segment(0), segment(1)],
      expectedSegmentCount: 2,
    }));

    expect(f.state().segments).toEqual([segment(0), segment(1)]);
    const inserts = f.calls.filter(({ sql }) =>
      sql.startsWith("INSERT INTO local_transcript_segments"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[0]).toBe(SEGMENT_B);
  });

  it("rejects changed immutable evidence before the first write", async () => {
    const f = fixture({
      versions: [storedVersion(version(), true)],
      segments: [segment(0, { text: "different" })],
    });
    await expect(
      persistCompletedTranscriptionResult(resultInput()),
    ).rejects.toMatchObject({ code: "RESULT_RECONCILIATION_CONFLICT" });
    expect(f.calls).toEqual([]);
  });

  it("never lets an older provider result demote a newer local edit", async () => {
    const edit = version({
      id: "99999999-9999-4999-8999-999999999999",
      transcription_run_id: null,
      created_by: USER,
      version: 2,
      version_origin: "user_edit",
      parent_version_id: VERSION,
      plain_text: "edited",
      content_checksum_sha256: hash("edited"),
      is_current: true,
    });
    const f = fixture({ versions: [storedVersion(edit, true)] });
    await persistCompletedTranscriptionResult(resultInput());

    expect(f.state().versions.find((value) => value.id === edit.id)?.is_current).toBe(1);
    expect(f.state().versions.find((value) => value.id === VERSION)?.is_current).toBe(0);
    expect(f.calls.some(({ sql }) => sql.includes("SET is_current = 0"))).toBe(false);
  });

  it("stores a remotely non-current provider result without moving local current", async () => {
    const current = version({
      id: "99999999-9999-4999-8999-999999999999",
      transcription_run_id: null,
      version: 2,
      version_origin: "import",
      parent_version_id: null,
      plain_text: "imported",
      content_checksum_sha256: null,
      is_current: true,
    });
    const f = fixture({ versions: [storedVersion(current, true)] });
    await persistCompletedTranscriptionResult(resultInput({
      version: version({ is_current: false }),
    }));

    expect(f.state().versions.find((value) => value.id === current.id)?.is_current).toBe(1);
    expect(f.state().versions.find((value) => value.id === VERSION)?.is_current).toBe(0);
  });

  it("plans receipt conflicts before any operational or evidence write", async () => {
    const receipt = encodeTranscriptionResultReceipt({
      schemaVersion: 1,
      kind: "result_reconciled",
      userId: USER,
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      recordingId: RECORDING,
      jobId: JOB,
      requestId: QUEUE,
      resultVersionId: VERSION,
      resultVersion: 1,
      contentChecksum: "0".repeat(64),
      expectedSegments: 1,
      reconciledAt: NOW,
    });
    const f = fixture({
      versions: [storedVersion(version(), true)],
      segments: [segment(0)],
      receipts: [receipt],
    });
    await expect(
      persistCompletedTranscriptionResult(resultInput()),
    ).rejects.toMatchObject({ code: "RESULT_RECONCILIATION_CONFLICT" });
    expect(f.calls).toEqual([]);
  });

  it("rolls back evidence and diagnostics when the atomic receipt write fails", async () => {
    const f = fixture();
    f.control.failReceiptInsert = true;
    await expect(
      persistCompletedTranscriptionResult(resultInput()),
    ).rejects.toMatchObject({
      code: "RESULT_RECONCILIATION_WRITE_FAILED",
      retryable: true,
    });
    expect(f.state()).toEqual({ versions: [], segments: [], receipts: [] });
  });

  it("continues to persist nonterminal job/run progress without transcript rows", async () => {
    const statements: string[] = [];
    const db = {
      getFirstAsync: jest.fn(async () => ({ id: QUEUE })),
      runAsync: jest.fn(async (sql: string) => {
        statements.push(sql);
        return { changes: 1 };
      }),
    };
    mockedOpen.mockResolvedValue(db as never);
    await persistTranscriptionResultProgress({
      queueId: QUEUE,
      job: { ...job, status: "processing" },
      run: { ...run, status: "processing" },
      nextRetryAt: LATER,
      errorCode: "TRANSCRIPTION_RESULT_PROCESSING",
      safeError: "processing",
    });
    const sql = statements.join("\n");
    expect(sql).toContain("INSERT INTO local_processing_jobs");
    expect(sql).toContain("INSERT INTO local_transcription_runs");
    expect(sql).not.toContain("INSERT INTO local_transcript_versions");
  });
});
