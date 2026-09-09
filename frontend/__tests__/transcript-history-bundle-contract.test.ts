import { createHash } from "node:crypto";
import * as Crypto from "expo-crypto";

import {
  assessHistoryBundleProof,
  historyBundleInstant, HISTORY_BUNDLE_RUN_COLUMNS,
  MAX_HISTORY_BUNDLE_SEGMENTS,
  parseHistoryBundleJob,
  parseHistoryBundleRun,
  reconcileHistoryBundleVersion,
  validateTranscriptHistoryBundle,
} from "@/src/services/transcription/history-bundle-types";
import { parseHistoryCloudVersion } from "@/src/services/transcription/history-cloud-types";

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: jest.fn(),
}));
const digest = Crypto.digestStringAsync as jest.MockedFunction<typeof Crypto.digestStringAsync>;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ARTIFACT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const NOW = "2026-09-08T17:00:00.123456Z";
const CLEANUP = "2026-09-08T17:00:01.123456Z";
const TEXT = "  Bahasa Indonesia / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00  ";
const version = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(n), workspace_id: WORKSPACE, session_id: SESSION, version: n,
  version_origin: n === 1 ? "provider" : "user_edit", version_status: "final",
  parent_version_id: n === 1 ? null : id(n - 1), created_by: USER, transcription_run_id: id(500),
  content_checksum_sha256: hash(TEXT + n), plain_text: TEXT + n,
  language_summary: { primaryLanguage: null, detectedLanguages: ["en", "id"] },
  created_at: NOW, updated_at: NOW, is_current: n === 2, ...extra,
});
const run = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(500), processing_job_id: id(501), workspace_id: WORKSPACE, session_id: SESSION, recording_id: id(502),
  status: "succeeded",
  provider_job_id: ARTIFACT, provider_cleanup_status: "succeeded", provider_cleanup_completed_at: CLEANUP,
  completed_at: NOW, word_count: 2, ...extra,
});
const job = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(501), workspace_id: WORKSPACE, session_id: SESSION, recording_id: id(502), status: "succeeded", completed_at: NOW, ...extra,
});
const segment = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(1000 + n), workspace_id: WORKSPACE, session_id: SESSION, transcript_version_id: id(1), segment_index: n,
  start_ms: n * 10, end_ms: n * 10 + 8, text: ` word ${n} `, confidence: 0.9,
  language_code: n % 2 ? "id" : "en", speaker_label: null, provider_segment_id: `${ARTIFACT}:word:${n}`,
  created_at: NOW, updated_at: NOW, ...extra,
});
const material = () => ({ scope: { ...scope }, selectedVersionId: id(2), versions: [version(2), version(1)],
  run: run(), job: job(), segments: [segment(0), segment(1)] });
const proof = (changes: Record<string, unknown> = {}, jobChanges: Record<string, unknown> = {}) =>
  assessHistoryBundleProof(parseHistoryCloudVersion(version(1), scope), parseHistoryBundleRun(run(changes)), parseHistoryBundleJob(job(jobChanges)));
beforeEach(() => { jest.clearAllMocks(); digest.mockImplementation(async (_algorithm, text) => hash(text)); });
afterEach(() => jest.restoreAllMocks());

describe("3E.2B1 complete managed-provider bundle validation", () => {
  it("validates edit ancestry, exact text and all digests without promoting flags or moving segments", async () => {
    const input = material(); const original = JSON.stringify(input);
    const result = await validateTranscriptHistoryBundle(input);
    expect(result.completeness).toBe("managed_provider_bundle");
    expect(result.versions.map((v) => v.id)).toEqual([id(2), id(1)]);
    expect(result.versions[0].plain_text).toBe(TEXT + 2);
    expect(result.versions.map((v) => v.is_current)).toEqual([true, false]);
    expect(result.segments.every((s) => s.transcript_version_id === id(1))).toBe(true);
    expect(result.segments[0].text).toBe(" word 0 ");
    expect(result.provider).toMatchObject({ runId: id(500), jobId: id(501), recordingId: id(502), expectedSegmentCount: 2 });
    expect(result.provider).not.toHaveProperty("provider_job_id"); expect(result).not.toHaveProperty("run");
    expect(result).not.toHaveProperty("provider_metadata"); expect(JSON.stringify(input)).toBe(original);
    expect(digest).toHaveBeenCalledTimes(2); expect(digest).toHaveBeenNthCalledWith(1, "SHA-256", TEXT + 2);
  });
  it("accepts a directly selected provider using only server-normalized proof fields", async () => {
    const input = material(); input.selectedVersionId = id(1); input.versions = [version(1, { is_current: true })];
    const result = await validateTranscriptHistoryBundle(input);
    expect(result.provider).toMatchObject({ versionId: id(1), runId: id(500), jobId: id(501), expectedSegmentCount: 2 });
  });
  it("uses parent identity, not equal nullable run/creator references, for user-edit ancestry", async () => {
    const input = material(); input.versions[0].transcription_run_id = null; input.versions[0].created_by = null;
    const result = await validateTranscriptHistoryBundle(input); expect(result.versions[0].transcription_run_id).toBeNull();
  });
  it("detaches and deeply freezes results before callers can mutate later evidence", async () => {
    const input = material(); const result = await validateTranscriptHistoryBundle(input);
    input.segments[0].text = "changed"; input.versions[0].plain_text = "changed";
    expect(result.segments[0].text).toBe(" word 0 "); expect(result.versions[0].plain_text).toBe(TEXT + 2);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.segments[0])).toBe(true);
    expect(Object.isFrozen(result.versions[0].language_summary)).toBe(true);
  });
  it.each(["pending", "leased"])("does not mistake cleanup %s for a complete provider result", (provider_cleanup_status) => {
    expect(proof({ provider_cleanup_status, provider_cleanup_completed_at: null })).toEqual({ kind: "not_ready", reason: "cleanup_pending" });
  });
  it("returns an explicit manual-review outcome", () => {
    expect(proof({ provider_cleanup_status: "manual_review", provider_cleanup_completed_at: null }))
      .toEqual({ kind: "unavailable", reason: "cleanup_manual_review" });
  });
  it.each(["queued", "submitting", "processing"])("does not treat a %s run as completed", (status) => {
    expect(proof({ status })).toEqual({ kind: "not_ready", reason: "processing_incomplete" });
  });
  it.each(["queued", "leased", "processing"])("does not treat a %s job as completed", (status) => {
    expect(proof({}, { status })).toEqual({ kind: "not_ready", reason: "processing_incomplete" });
  });
  it.each(["failed", "cancelled"])("does not admit terminal unsuccessful results: %s", (status) => {
    expect(proof({ status })).toEqual({ kind: "unavailable", reason: "provider_terminal" });
    expect(proof({}, { status })).toEqual({ kind: "unavailable", reason: "provider_terminal" });
  });
  it("keeps provider-vendor profile fields out of the mobile proof contract", () => {
    expect(HISTORY_BUNDLE_RUN_COLUMNS).not.toEqual(expect.arrayContaining(["provider_key", "provider_model", "provider_region"]));
  });
  it.each(["id", "processing_job_id", "workspace_id", "session_id", "recording_id"])("rejects mismatched run proof %s", (field) => {
    expect(() => proof({ [field]: OTHER })).toThrow();
  });
  it.each(["id", "workspace_id", "session_id", "recording_id"])("rejects mismatched job proof %s", (field) => {
    expect(() => proof({}, { [field]: OTHER })).toThrow();
  });
  it.each(["provider_job_id", "word_count", "completed_at", "provider_cleanup_completed_at"])("requires succeeded-run proof field %s", (field) => {
    expect(() => proof({ [field]: null })).toThrow();
    const value = run(); delete value[field]; expect(() => parseHistoryBundleRun(value)).toThrow();
  });
  it("does not accept not-required cleanup for a succeeded managed run", () => {
    expect(() => proof({ provider_cleanup_status: "not_required", provider_cleanup_completed_at: null })).toThrow();
    expect(() => proof({ provider_cleanup_completed_at: "2026-09-08T16:59:59Z" })).toThrow();
  });
  it.each([0, -1, 1.5, "2", 200_001, NaN])("rejects malformed expected word count %s", (word_count) => {
    expect(() => parseHistoryBundleRun(run({ word_count }))).toThrow();
  });
  it("reports the explicit mobile segment cap without pretending a larger server result is corrupt", () => {
    expect(() => proof({ word_count: MAX_HISTORY_BUNDLE_SEGMENTS + 1 })).toThrow(expect.objectContaining({ code: "HISTORY_BUNDLE_LIMIT_EXCEEDED" }));
    expect(proof({ word_count: MAX_HISTORY_BUNDLE_SEGMENTS })).toMatchObject({ kind: "eligible" });
  });
  it("will not let a caller bypass eligibility by directly invoking the validator", async () => {
    const input = material(); input.run.provider_cleanup_status = "pending";
    await expect(validateTranscriptHistoryBundle(input)).rejects.toMatchObject({ code: "HISTORY_BUNDLE_NOT_ELIGIBLE" });
    expect(digest).not.toHaveBeenCalled();
  });
  it.each(["missing", "extra", "gap", "order", "duplicate_id", "wrong_owner", "decreasing_time"])("rejects incomplete/inconsistent segments: %s", async (kind) => {
    const input = material();
    if (kind === "missing") input.segments.pop();
    if (kind === "extra") input.segments.push(segment(2));
    if (kind === "gap") input.segments[1] = segment(2);
    if (kind === "order") input.segments.reverse();
    if (kind === "duplicate_id") input.segments[1].id = input.segments[0].id;
    if (kind === "wrong_owner") input.segments[0].transcript_version_id = id(2);
    if (kind === "decreasing_time") { input.segments[0].start_ms = 15; input.segments[0].end_ms = 18; }
    await expect(validateTranscriptHistoryBundle(input)).rejects.toThrow(); expect(digest).not.toHaveBeenCalled();
  });
  it.each<[string, unknown]>([
    ["id", "bad"], ["workspace_id", OTHER], ["session_id", OTHER], ["provider_segment_id", "other:word:0"],
    ["segment_index", -1], ["segment_index", 0.2], ["start_ms", -1], ["end_ms", -1],
    ["end_ms", Number.MAX_SAFE_INTEGER + 1], ["confidence", 1.1], ["confidence", NaN],
    ["text", "  "], ["text", "bad\0text"], ["text", "\ud800"], ["language_code", "fr"],
    ["speaker_label", " "], ["speaker_label", "speaker\nname"], ["created_at", "bad"], ["updated_at", null],
  ])("rejects malformed segment %s=%s", async (field, value) => {
    const input = material(); input.segments[0][String(field)] = value;
    await expect(validateTranscriptHistoryBundle(input)).rejects.toThrow();
  });
  it("accepts null confidence/language/speaker and preserves exact timestamp labels' source values", async () => {
    const input = material(); input.segments[0] = segment(0, { language_code: null, confidence: null, speaker_label: null });
    expect((await validateTranscriptHistoryBundle(input)).segments[0]).toMatchObject({ confidence: null, start_ms: 0, end_ms: 8 });
  });
  it.each(["wrong_selection", "missing_parent", "same_version", "cycle", "provider_mid_chain", "incomplete_leaf"])("rejects invalid ancestry: %s", async (kind) => {
    const input = material();
    if (kind === "wrong_selection") input.selectedVersionId = OTHER;
    if (kind === "missing_parent") input.versions[0].parent_version_id = OTHER;
    if (kind === "same_version") input.versions[1].version = 2;
    if (kind === "cycle") input.versions.push(version(2));
    if (kind === "provider_mid_chain") input.versions[0] = version(2, { version_origin: "provider" });
    if (kind === "incomplete_leaf") input.versions.pop();
    await expect(validateTranscriptHistoryBundle(input)).rejects.toThrow();
  });
  it("enforces the shared 64-link ancestry cap", async () => {
    const input = material(); input.versions = Array.from({ length: 66 }, (_, i) => version(66 - i)); input.selectedVersionId = id(66);
    await expect(validateTranscriptHistoryBundle(input)).rejects.toMatchObject({ code: "HISTORY_BUNDLE_LIMIT_EXCEEDED" });
  });
  it("verifies each text digest including edits, not just the provider", async () => {
    const input = material(); input.versions[0].plain_text = "changed after checksum";
    await expect(validateTranscriptHistoryBundle(input)).rejects.toMatchObject({ code: "HISTORY_BUNDLE_CHECKSUM_MISMATCH" });
  });
  it("does not synthesize a checksum for a provider with missing provenance", async () => {
    const input = material(); input.versions[1].content_checksum_sha256 = null;
    await expect(validateTranscriptHistoryBundle(input)).rejects.toThrow(); expect(digest).not.toHaveBeenCalled();
  });
  it.each(["failure", "invalid_digest"])("sanitizes native digest %s", async (kind) => {
    if (kind === "failure") digest.mockRejectedValueOnce(new Error("PRIVATE TRANSCRIPT"));
    else digest.mockResolvedValueOnce("bad-digest");
    await expect(validateTranscriptHistoryBundle(material())).rejects.toMatchObject({ code: "HISTORY_BUNDLE_HASH_UNAVAILABLE" });
  });
  it("checks lifetime after an awaited digest and suppresses a late result", async () => {
    let active = true; const guard = () => { if (!active) throw new Error("TEST_INACTIVE"); };
    digest.mockImplementationOnce(async (_algorithm, text) => { active = false; return hash(text); });
    await expect(validateTranscriptHistoryBundle(material(), guard)).rejects.toThrow("TEST_INACTIVE");
  });
  it("captures detached content before awaiting a digest", async () => {
    const input = material(); digest.mockImplementationOnce(async (_algorithm, text) => {
      input.versions[1].plain_text = "mutated"; input.segments[0].text = "mutated"; return hash(text);
    });
    const result = await validateTranscriptHistoryBundle(input); expect(result.versions[1].plain_text).toBe(TEXT + 1);
    expect(result.segments[0].text).toBe(" word 0 ");
  });
});

describe("3E.2B1 immutable re-observation contract", () => {
  const parsed = (extra: Record<string, unknown> = {}) => parseHistoryCloudVersion(version(2, extra), scope);
  it("accepts reference clearing and marker changes without rewriting them", () => {
    const latest = parsed({ created_by: null, transcription_run_id: null, is_current: false, updated_at: CLEANUP });
    expect(reconcileHistoryBundleVersion(parsed(), latest)).toBe(latest);
  });
  it("compares JSON semantically and created instants to microsecond precision", () => {
    const latest = parsed({ language_summary: { detectedLanguages: ["en", "id"], primaryLanguage: null }, created_at: "2026-09-09T00:00:00.123456+07:00" });
    expect(reconcileHistoryBundleVersion(parsed(), latest)).toBe(latest);
    expect(() => reconcileHistoryBundleVersion(parsed(), parsed({ created_at: "2026-09-08T17:00:00.123457Z" }))).toThrow();
  });
  it.each(["created_by", "transcription_run_id"])("rejects cleared %s resurrection and non-null replacement", (field) => {
    expect(() => reconcileHistoryBundleVersion(parsed({ [field]: null }), parsed())).toThrow();
    expect(() => reconcileHistoryBundleVersion(parsed(), parsed({ [field]: OTHER }))).toThrow();
  });
  it.each(["id", "version", "plain_text", "content_checksum_sha256", "parent_version_id", "language_summary"])("rejects changed immutable %s", (field) => {
    const old = parsed(); const changed = { ...old, [field]: field === "version" ? 8 : "changed" };
    expect(() => reconcileHistoryBundleVersion(old, changed as typeof old)).toThrow();
  });
  it.each(["2026-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "2026-09-08", "2026-01-01T00:00:00+00:60", "2026-01-01T00:00:00+24:00"])("rejects invalid timestamp %s", (value) => {
    expect(() => historyBundleInstant(value)).toThrow();
  });
});
