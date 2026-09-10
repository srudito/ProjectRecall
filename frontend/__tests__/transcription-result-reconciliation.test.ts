import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Crypto from "expo-crypto";

import {
  MAX_RESULT_RECONCILIATION_SEGMENTS,
  MAX_RESULT_RECONCILIATION_TEXT_BYTES,
  TranscriptionResultReconciliationError,
  consumeTranscriptionResultReconciliationCommand,
  prepareTranscriptionResultReconciliationCommand,
  revokeTranscriptionResultReconciliationCommand,
  type TranscriptionResultReconciliationErrorCode,
  type TranscriptionResultReconciliationInput,
} from "@/src/services/transcription/result-reconciliation";
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

const digest = Crypto.digestStringAsync as jest.MockedFunction<
  typeof Crypto.digestStringAsync
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
const TEXT = "  Bahasa Indonesia / English\né 漢字 😀  ";
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const job = (): SyncedProcessingJob => ({
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
  request_payload: { contractVersion: 1, nested: { safe: true } },
  created_at: NOW,
  updated_at: NOW,
});
const run = (): SyncedTranscriptionRun => ({
  id: RUN,
  processing_job_id: JOB,
  workspace_id: WORKSPACE,
  session_id: SESSION,
  recording_id: RECORDING,
  created_by: USER,
  run_attempt: 1,
  provider_key: "assemblyai",
  provider_model: "universal-2",
  request_mode: "MULTILINGUAL",
  requested_languages: ["en", "id"],
  status: "succeeded",
  provider_artifact_present: true,
  provider_cleanup_status: "succeeded",
  detected_languages: ["en", "id"],
  primary_detected_language: null,
  language_detection_status: "USER_CONFIRMED",
  started_at: NOW,
  completed_at: NOW,
  last_error_code: null,
  last_safe_error: null,
  created_at: NOW,
  updated_at: NOW,
});
const version = (): SyncedTranscriptVersionRecord => ({
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
  language_summary: {
    primaryLanguage: null,
    detectedLanguages: ["en", "id"],
  },
  content_checksum_sha256: hash(TEXT),
  is_current: true,
  created_at: NOW,
  updated_at: NOW,
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
  text: ` word ${index} `,
  language_code: index === 0 ? "en" : "id",
  speaker_label: null,
  confidence: 0.9,
  provider_segment_id: `provider:word:${index}`,
  created_at: NOW,
  updated_at: NOW,
  ...patch,
});
const input = (): TranscriptionResultReconciliationInput => ({
  userId: USER,
  queueId: QUEUE,
  job: job(),
  run: run(),
  version: version(),
  segments: [segment(0), segment(1)],
  expectedSegmentCount: 2,
  reconciledAt: NOW,
});
const rejected = async (
  value: TranscriptionResultReconciliationInput,
  code: TranscriptionResultReconciliationErrorCode,
) => {
  await expect(
    prepareTranscriptionResultReconciliationCommand(value),
  ).rejects.toMatchObject({ code });
};

const incompleteProofCases: readonly (readonly [
  "job" | "run" | "version",
  Readonly<Record<string, unknown>>,
])[] = [
  ["job", { status: "processing" }],
  ["run", { status: "processing" }],
  ["run", { provider_cleanup_status: "pending" }],
  ["run", { provider_artifact_present: false }],
  ["version", { version_origin: "user_edit" }],
  ["version", { version_status: "draft" }],
  ["version", { parent_version_id: SEGMENT_A }],
  ["version", { plain_text: "   " }],
];

const scopeMismatchCases: readonly (readonly [
  "job" | "run" | "version",
  Readonly<Record<string, unknown>>,
])[] = [
  ["run", { processing_job_id: SEGMENT_A }],
  ["run", { workspace_id: SEGMENT_A }],
  ["run", { recording_id: SEGMENT_A }],
  ["version", { transcription_run_id: SEGMENT_A }],
  ["version", { session_id: SEGMENT_A }],
  ["job", { created_by: SEGMENT_A }],
];

beforeEach(() => {
  digest.mockReset();
  digest.mockImplementation(
    async (_algorithm: Crypto.CryptoDigestAlgorithm, value: string) =>
      hash(value),
  );
});

describe("C2B.1 detached result reconciliation command", () => {
  it("prepares frozen, single-use evidence and one exact result receipt", async () => {
    const source = input();
    const command = await prepareTranscriptionResultReconciliationCommand(source);
    const data = consumeTranscriptionResultReconciliationCommand(command);

    expect(data).toMatchObject({
      userId: USER,
      queueId: QUEUE,
      remoteCurrent: true,
      expectedSegmentCount: 2,
      reconciledAt: NOW,
      receipt: {
        userId: USER,
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        recordingId: RECORDING,
        jobId: JOB,
        requestId: QUEUE,
        resultVersionId: VERSION,
        resultVersion: 1,
        contentChecksum: hash(TEXT),
        expectedSegments: 2,
        reconciledAt: NOW,
      },
    });
    expect(data.version.is_current).toBe(false);
    expect(data.version.plain_text).toBe(TEXT);
    expect(data.segments.map((value) => value.segment_index)).toEqual([0, 1]);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.job.request_payload)).toBe(true);
    expect(Object.isFrozen(data.version.language_summary)).toBe(true);
    expect(Object.isFrozen(data.segments)).toBe(true);
    expect(source.version).not.toBe(data.version);
    expect(source.segments).not.toBe(data.segments);
    expect(() => consumeTranscriptionResultReconciliationCommand(command)).toThrow(
      "The completed transcript result is invalid.",
    );
  });

  it("copies every record before the asynchronous checksum operation", async () => {
    const source = input();
    let release!: (value: string) => void;
    digest.mockImplementationOnce(
      () => new Promise<string>((resolveDigest) => { release = resolveDigest; }),
    );
    const pending = prepareTranscriptionResultReconciliationCommand(source);
    source.version.plain_text = "changed after admission";
    source.segments[0].text = "changed after admission";
    source.job.request_payload.nested = { private: "changed" };
    release(hash(TEXT));

    const data = consumeTranscriptionResultReconciliationCommand(await pending);
    expect(data.version.plain_text).toBe(TEXT);
    expect(data.segments[0].text).toBe(" word 0 ");
    expect(data.job.request_payload).toEqual({
      contractVersion: 1,
      nested: { safe: true },
    });
  });

  it("rejects forged, reused, JSON-copied, and explicitly revoked commands", async () => {
    expect(() =>
      consumeTranscriptionResultReconciliationCommand({} as never),
    ).toThrow();
    const first = await prepareTranscriptionResultReconciliationCommand(input());
    expect(() =>
      consumeTranscriptionResultReconciliationCommand(
        JSON.parse(JSON.stringify(first)) as never,
      )
    ).toThrow();
    revokeTranscriptionResultReconciliationCommand(first);
    expect(() =>
      consumeTranscriptionResultReconciliationCommand(first),
    ).toThrow();
  });

  it.each(incompleteProofCases)(
    "rejects incomplete proof in %s",
    async (
      target: "job" | "run" | "version",
      patch: Readonly<Record<string, unknown>>,
    ) => {
      const value = input();
      Object.assign(value[target], patch);
      await rejected(value, "RESULT_RECONCILIATION_INPUT_INVALID");
    },
  );

  it.each(scopeMismatchCases)(
    "rejects a mismatched %s identity",
    async (
      target: "job" | "run" | "version",
      patch: Readonly<Record<string, unknown>>,
    ) => {
      const value = input();
      Object.assign(value[target], patch);
      await expect(
        prepareTranscriptionResultReconciliationCommand(value),
      ).rejects.toMatchObject({
        code: "RESULT_RECONCILIATION_SCOPE_MISMATCH",
      });
    },
  );

  it.each(["zero", "missing", "extra", "gap", "duplicate-id", "duplicate-index"])(
    "rejects incomplete segment coverage: %s",
    async (kind: string) => {
      const value = input();
      if (kind === "zero") {
        value.expectedSegmentCount = 0;
        value.segments = [];
      }
      if (kind === "missing") value.segments = value.segments.slice(0, 1);
      if (kind === "extra") value.expectedSegmentCount = 1;
      if (kind === "gap") value.segments[1].segment_index = 2;
      if (kind === "duplicate-id") value.segments[1].id = value.segments[0].id;
      if (kind === "duplicate-index") value.segments[1].segment_index = 0;
      await expect(
        prepareTranscriptionResultReconciliationCommand(value),
      ).rejects.toBeInstanceOf(TranscriptionResultReconciliationError);
    },
  );

  it("distinguishes checksum mismatch and unavailable hashing", async () => {
    const changed = input();
    changed.version.content_checksum_sha256 = "0".repeat(64);
    await rejected(changed, "RESULT_RECONCILIATION_CHECKSUM_MISMATCH");

    digest.mockRejectedValueOnce(new Error("PRIVATE HASH FAILURE"));
    await rejected(input(), "RESULT_RECONCILIATION_HASH_UNAVAILABLE");
  });

  it("enforces the independent count and byte budgets without truncation", async () => {
    const tooMany = input();
    tooMany.expectedSegmentCount = MAX_RESULT_RECONCILIATION_SEGMENTS + 1;
    await rejected(tooMany, "RESULT_RECONCILIATION_LIMIT_EXCEEDED");

    const tooLarge = input();
    tooLarge.version.plain_text = "x".repeat(
      MAX_RESULT_RECONCILIATION_TEXT_BYTES + 1,
    );
    tooLarge.version.content_checksum_sha256 = hash(tooLarge.version.plain_text);
    await rejected(tooLarge, "RESULT_RECONCILIATION_LIMIT_EXCEEDED");

    expect(digest).not.toHaveBeenCalled();
  });

  it("has no SQLite, Supabase, network, clock, or queue side effects", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/services/transcription/result-reconciliation.ts"),
      "utf8",
    );
    expect(source).not.toContain("openLocalDb(");
    expect(source).not.toContain("getSupabase(");
    expect(source).not.toContain(".rpc(");
    expect(source).not.toContain("Date.now(");
    expect(source).not.toContain("Math.random(");
    expect(source).not.toContain("console.");
    expect(source).not.toContain("local_transcription_request_queue");
  });
});
