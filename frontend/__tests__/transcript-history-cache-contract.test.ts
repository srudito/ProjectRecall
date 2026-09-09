import { createHash } from "node:crypto";
import * as Crypto from "expo-crypto";

import {
  consumeHistoryCacheCommand, prepareHistoryCacheCommand, revokeHistoryCacheCommand,
  reconcileCachedHistoryVersion, assertCachedHistorySegment, historyCacheError,
  MAX_HISTORY_CACHE_SEGMENTS, MAX_HISTORY_CACHE_BYTES,
} from "@/src/services/transcription/history-cache-types";
import { HISTORY_BUNDLE_SOURCE, type TranscriptHistoryBundleResult } from "@/src/services/transcription/history-bundle-types";
import type { TranscriptHistoryCloudVersion } from "@/src/services/transcription/history-cloud-types";
import type { SyncedTranscriptSegment } from "@/src/services/transcription/result-types";

jest.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: jest.fn() }));
const digest = Crypto.digestStringAsync as jest.MockedFunction<typeof Crypto.digestStringAsync>;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ARTIFACT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-09-09T10:00:00.123456Z";
const LATER = "2026-09-09T10:00:01.123456Z";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const version = (n: number): TranscriptHistoryCloudVersion => ({
  id: id(n), workspace_id: WORKSPACE, session_id: SESSION, version: n,
  version_origin: n === 1 ? "provider" : "user_edit", version_status: "final",
  parent_version_id: n === 1 ? null : id(n - 1), transcription_run_id: id(500), created_by: USER,
  plain_text: `  Bahasa / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00 ${n}  `,
  content_checksum_sha256: hash(`  Bahasa / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00 ${n}  `),
  language_summary: { primaryLanguage: null, detectedLanguages: ["en", "id"] },
  is_current: n === 2, created_at: NOW, updated_at: NOW,
});
const segment = (n: number): SyncedTranscriptSegment => ({
  id: id(1000 + n), workspace_id: WORKSPACE, session_id: SESSION, transcript_version_id: id(1),
  segment_index: n, start_ms: n * 10, end_ms: n * 10 + 8, text: ` word ${n} `,
  language_code: "en", speaker_label: null, confidence: 0.8,
  provider_segment_id: `${ARTIFACT}:word:${n}`, created_at: NOW, updated_at: NOW,
});
const ready = (): Extract<TranscriptHistoryBundleResult, { kind: "ready" }> => ({
  kind: "ready", source: HISTORY_BUNDLE_SOURCE, scope: { ...scope }, selectedVersionId: id(2),
  bundle: { completeness: "managed_provider_bundle", versions: [version(2), version(1)],
    segments: [segment(0), segment(1)], provider: { versionId: id(1), runId: id(500), jobId: id(501),
      recordingId: id(502), cleanupCompletedAt: LATER, expectedSegmentCount: 2 } },
});
const localVersion = (value = version(1)): Record<string, unknown> => ({ ...value,
  language_summary: JSON.stringify(value.language_summary), is_current: value.is_current ? 1 : 0 });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

beforeEach(() => { digest.mockReset(); digest.mockImplementation(async (_algorithm, value) => hash(value)); });

describe("guarded history cache command contract", () => {
  it("prepares detached, frozen, single-use data without discarding exact text or current observations", async () => {
    const input = ready(); const command = await prepareHistoryCacheCommand(input, () => {});
    const data = consumeHistoryCacheCommand(command);
    expect(data.scope).toEqual(scope); expect(data.versions[0].plain_text).toBe(version(2).plain_text);
    expect(data.versions[0].is_current).toBe(true);
    expect(Object.isFrozen(data.versions[0].language_summary)).toBe(true);
    expect(data.versions).not.toBe(input.bundle.versions);
    expect(digest).toHaveBeenCalledTimes(2);
    expect(() => consumeHistoryCacheCommand(command)).toThrow("The history cache request is invalid.");
  });
  it("does not accept a plain object, JSON copy, or revoked command as prepared evidence", async () => {
    expect(() => consumeHistoryCacheCommand({} as never)).toThrow();
    const command = await prepareHistoryCacheCommand(ready(), () => {});
    expect(() => consumeHistoryCacheCommand(clone(command))).toThrow();
    revokeHistoryCacheCommand(command); expect(() => consumeHistoryCacheCommand(command)).toThrow();
  });
  it("rechecks lifetime when consuming the prepared command", async () => {
    let active = true;
    const command = await prepareHistoryCacheCommand(ready(), () => {
      if (!active) throw historyCacheError("HISTORY_CACHE_CONTEXT_INACTIVE");
    });
    active = false;
    expect(() => consumeHistoryCacheCommand(command)).toThrow("This history cache operation is no longer active.");
  });
  it("copies all records before the first asynchronous hash", async () => {
    const input = ready(); let finish!: (value: string) => void;
    digest.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = prepareHistoryCacheCommand(input, () => {});
    (input.bundle.versions[0] as TranscriptHistoryCloudVersion).plain_text = "changed";
    (input.bundle.segments[0] as SyncedTranscriptSegment).text = "changed";
    finish(hash(version(2).plain_text));
    const data = consumeHistoryCacheCommand(await pending);
    expect(data.versions[0].plain_text).toBe(version(2).plain_text);
    expect(data.segments[0].text).toBe(segment(0).text);
  });
  it.each(["kind", "source", "selectedVersionId"] as const)("rejects mismatched %s", async (key) => {
    const input = { ...ready(), [key]: "wrong" };
    await expect(prepareHistoryCacheCommand(input as never, () => {})).rejects.toMatchObject({ code: "HISTORY_CACHE_BUNDLE_INVALID" });
  });
  it.each(["workspace_id", "session_id", "id", "version", "parent_version_id", "plain_text", "version_status", "version_origin"])(
    "rejects a malformed selected version %s", async (field) => {
      const input = ready(); (input.bundle.versions[0] as unknown as Record<string, unknown>)[field] = field === "plain_text" ? null : "invalid";
      await expect(prepareHistoryCacheCommand(input, () => {})).rejects.toMatchObject({ code: "HISTORY_CACHE_BUNDLE_INVALID" });
    });
  it.each(["runId", "versionId", "jobId", "recordingId", "cleanupCompletedAt", "expectedSegmentCount"])(
    "rejects invalid summary proof %s instead of inventing run/job records", async (field) => {
      const input = ready(); (input.bundle.provider as unknown as Record<string, unknown>)[field] = "invalid";
      await expect(prepareHistoryCacheCommand(input, () => {})).rejects.toMatchObject({ code: "HISTORY_CACHE_BUNDLE_INVALID" });
    });
  it.each(["missing", "duplicate", "gap", "scope", "extra", "artifact", "time", "null-id"])(
    "rejects incomplete or inconsistent segments: %s", async (kind) => {
      const input = ready(); const values = input.bundle.segments as SyncedTranscriptSegment[];
      if (kind === "missing") values.pop();
      if (kind === "duplicate") values[1].id = values[0].id;
      if (kind === "gap") values[1].segment_index = 2;
      if (kind === "scope") values[0].workspace_id = OTHER;
      if (kind === "extra") values.push(segment(2));
      if (kind === "artifact") values[1].provider_segment_id = `${OTHER}:word:1`;
      if (kind === "time") values[1].start_ms = -1;
      if (kind === "null-id") values[0].provider_segment_id = null;
      await expect(prepareHistoryCacheCommand(input, () => {})).rejects.toMatchObject({ code: "HISTORY_CACHE_BUNDLE_INVALID" });
    });
  it("rejects a partial record, foreign scope, null provider provenance, and broken ancestry", async () => {
    const inputs = [ready(), ready(), ready(), ready()];
    (inputs[0].bundle as { completeness: string }).completeness = "version_record_only";
    (inputs[1].scope as { workspaceId: string }).workspaceId = OTHER;
    (inputs[2].bundle.versions[1] as TranscriptHistoryCloudVersion).transcription_run_id = null;
    (inputs[3].bundle.versions[0] as TranscriptHistoryCloudVersion).parent_version_id = id(99);
    for (const input of inputs) await expect(prepareHistoryCacheCommand(input, () => {}))
      .rejects.toMatchObject({ code: "HISTORY_CACHE_BUNDLE_INVALID" });
  });
  it.each([0, 1])("rehashes every version and rejects checksum mismatch on index %s", async (index) => {
    const input = ready(); (input.bundle.versions[index] as TranscriptHistoryCloudVersion).content_checksum_sha256 = "0".repeat(64);
    await expect(prepareHistoryCacheCommand(input, () => {})).rejects.toMatchObject({ code: "HISTORY_CACHE_CHECKSUM_MISMATCH" });
  });
  it("preserves explicit resource limits and never truncates a large bundle", async () => {
    const input = ready(); (input.bundle as unknown as { segments: unknown[] }).segments = Array(MAX_HISTORY_CACHE_SEGMENTS + 1).fill(segment(0));
    await expect(prepareHistoryCacheCommand(input, () => {})).rejects.toMatchObject({ code: "HISTORY_CACHE_LIMIT_EXCEEDED" });
    const big = ready(); (big.bundle.versions[0] as TranscriptHistoryCloudVersion).plain_text = "x".repeat(MAX_HISTORY_CACHE_BYTES);
    await expect(prepareHistoryCacheCommand(big, () => {})).rejects.toMatchObject({ code: "HISTORY_CACHE_LIMIT_EXCEEDED" });
    expect(digest).not.toHaveBeenCalled();
  });
  it("distinguishes malformed cyclic data from an oversized payload", async () => {
    const input = ready();
    (input.bundle.versions[0].language_summary as Record<string, unknown>).cycle = input;
    await expect(prepareHistoryCacheCommand(input, () => {})).rejects.toMatchObject({ code: "HISTORY_CACHE_BUNDLE_INVALID" });
    expect(digest).not.toHaveBeenCalled();
  });
  it("sanitizes hash failures and checks cancellation after the digest", async () => {
    digest.mockRejectedValueOnce(new Error("PRIVATE HASH ERROR"));
    await expect(prepareHistoryCacheCommand(ready(), () => {})).rejects.toMatchObject({
      code: "HISTORY_CACHE_HASH_UNAVAILABLE", message: "History checksum verification is unavailable.",
    });
    let active = true; digest.mockImplementationOnce(async (_algorithm, value) => { active = false; return hash(value); });
    await expect(prepareHistoryCacheCommand(ready(), () => {
      if (!active) throw historyCacheError("HISTORY_CACHE_CANCELLED");
    })).rejects.toMatchObject({ code: "HISTORY_CACHE_CANCELLED" });
  });
});

describe("immutable local equality and monotonic provenance", () => {
  it("accepts reordered JSON and equivalent microsecond instants without changing local current or updated_at", () => {
    const row = localVersion(); row.is_current = 1;
    row.language_summary = '{"detectedLanguages":["en","id"],"primaryLanguage":null}';
    const incoming = { ...version(1), created_at: "2026-09-09T17:00:00.123456+07:00", updated_at: LATER };
    expect(reconcileCachedHistoryVersion(row, incoming, scope)).toEqual({ createdBy: USER, runId: id(500), updatedAt: NOW, changed: false });
    expect(row.is_current).toBe(1);
  });
  it.each(["plain_text", "version", "parent_version_id", "content_checksum_sha256", "created_at", "language_summary", "is_current"])(
    "rejects corrupted/changed local %s", (field) => {
      const row = localVersion(); row[field] = "different";
      expect(() => reconcileCachedHistoryVersion(row, version(1), scope)).toThrow("The history conflicts with the existing local cache.");
    });
  it.each(["created_by", "transcription_run_id"] as const)("never revives cleared %s", (field) => {
    const row = localVersion(); row[field] = null;
    const merged = reconcileCachedHistoryVersion(row, version(1), scope);
    expect(field === "created_by" ? merged.createdBy : merged.runId).toBeNull(); expect(merged.changed).toBe(false);
  });
  it("accepts reference clearing but never regresses updated_at or overwrites another UUID", () => {
    const row = localVersion(); row.updated_at = LATER;
    const incoming = { ...version(1), created_by: null };
    expect(reconcileCachedHistoryVersion(row, incoming, scope)).toMatchObject({ createdBy: null, changed: true, updatedAt: LATER });
    expect(() => reconcileCachedHistoryVersion(row, { ...version(1), created_by: OTHER }, scope)).toThrow();
    expect(() => reconcileCachedHistoryVersion(row, { ...version(1), transcription_run_id: OTHER }, scope)).toThrow();
  });
  it("compares timestamp microseconds rather than Date.parse milliseconds", () => {
    expect(() => reconcileCachedHistoryVersion(localVersion(), { ...version(1), created_at: NOW.replace("123456", "123457") }, scope)).toThrow();
    expect(() => assertCachedHistorySegment({ ...segment(0), updated_at: NOW.replace("123456", "123457") }, segment(0))).toThrow();
  });
  it.each(["text", "start_ms", "end_ms", "id", "transcript_version_id", "confidence", "provider_segment_id"])(
    "rejects changed segment %s rather than deleting evidence", (field) => {
      expect(() => assertCachedHistorySegment({ ...segment(0), [field]: "changed" }, segment(0))).toThrow();
    });
});
