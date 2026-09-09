import { deepStrictEqual as equal, strictEqual as same, throws, ok, notStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAX_CACHE_MERGE_SEGMENTS, MAX_CACHE_MERGE_JSON_DEPTH, TranscriptCacheMergeError,
  normalizeTranscriptCacheInstant, normalizeTranscriptCacheUuid,
  planTranscriptCacheSegments, planTranscriptCacheVersion,
  type TranscriptCacheMergeErrorCode,
} from "@/src/services/transcription/cache-merge";
import type { SyncedTranscriptSegment, SyncedTranscriptVersionRecord } from "@/src/services/transcription/result-types";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTHOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-09-09T12:00:00.123456Z";
const LATER = "2026-09-09T12:00:00.123457Z";
const scope = { workspaceId: WORKSPACE, sessionId: SESSION };
const version = (patch: Partial<SyncedTranscriptVersionRecord> = {}): SyncedTranscriptVersionRecord => ({
  id: id(1), workspace_id: WORKSPACE, session_id: SESSION, transcription_run_id: RUN, created_by: AUTHOR,
  version: 1, version_origin: "provider", version_status: "final", parent_version_id: null,
  plain_text: "  Bahasa / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00  ", language_summary: { primaryLanguage: null, languages: ["id", "en"] },
  content_checksum_sha256: "a".repeat(64), is_current: true, created_at: NOW, updated_at: NOW, ...patch,
});
const segment = (n = 0, patch: Partial<SyncedTranscriptSegment> = {}): SyncedTranscriptSegment => ({
  id: id(100 + n), workspace_id: WORKSPACE, session_id: SESSION, transcript_version_id: id(1),
  segment_index: n, start_ms: n * 20, end_ms: n * 20 + 18, text: ` word ${n} `,
  language_code: "fr", speaker_label: " speaker ", confidence: 0.7, provider_segment_id: null,
  created_at: NOW, updated_at: NOW, ...patch,
});
const rejected = (task: () => unknown, code: TranscriptCacheMergeErrorCode = "CACHE_MERGE_INVALID") =>
  throws(task, (error: unknown) => error instanceof TranscriptCacheMergeError && error.code === code);

describe("C2A pure cache identity and timestamp contract", () => {
  it("normalizes UUID case without accepting missing or padded identifiers", () => {
    same(normalizeTranscriptCacheUuid(WORKSPACE.toUpperCase()), WORKSPACE);
    for (const value of [undefined, null, 42, ` ${WORKSPACE}`, `${WORKSPACE}\n`, "00000000-0000-0000-0000-000000000000"]) {
      rejected(() => normalizeTranscriptCacheUuid(value));
    }
  });
  it.each<[string, string]>([
    ["2026-09-09T19:00:00.123456+07:00", NOW],
    ["2026-09-09T11:00:00.123456-01:00", NOW],
    ["2026-09-09T12:00:00Z", "2026-09-09T12:00:00.000000Z"],
    ["2026-09-09T12:00:00.1+00:00", "2026-09-09T12:00:00.100000Z"],
    ["0099-01-01T00:00:00Z", "0099-01-01T00:00:00.000000Z"],
    ["1969-12-31T23:59:59.999999Z", "1969-12-31T23:59:59.999999Z"],
    ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000000Z"],
  ])("normalizes %s at microsecond precision", (input, expected) => same(normalizeTranscriptCacheInstant(input), expected));
  it("orders adjacent microseconds without millisecond rounding", () => {
    ok(normalizeTranscriptCacheInstant(NOW) < normalizeTranscriptCacheInstant(LATER));
    same(Date.parse(NOW), Date.parse(LATER));
  });
  it.each(["2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2026-09-31T00:00:00Z", "2026-00-01T00:00:00Z",
    "2026-09-09T24:00:00Z", "2026-09-09T00:60:00Z", "2026-09-09T00:00:60Z", "2026-09-09", "not a date",
    "2026-09-09T00:00:00", "2026-09-09T00:00:00.1234567Z", "2026-09-09T00:00:00Z\n",
    "2026-09-09T00:00:00+24:00", "2026-09-09T00:00:00+00:60", "2026-09-09T00:00:00-00:00",
    "0000-01-01T00:00:00Z", "0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00"])(
    "rejects invalid/unsupported timestamp %s without rounding", (value) => rejected(() => normalizeTranscriptCacheInstant(value)));
});

describe("C2A shared immutable version merge", () => {
  it("plans insertion as non-current without mutating cloud observations or exact text", () => {
    const input = version(); const before = JSON.stringify(input);
    const result = planTranscriptCacheVersion(null, input, scope);
    same(result.kind, "insert"); same(result.version.is_current, false); same(result.version.plain_text, input.plain_text);
    same(JSON.stringify(input), before); ok(Object.isFrozen(result.version)); ok(Object.isFrozen(result.version.language_summary));
    notStrictEqual(result.version.language_summary, input.language_summary);
  });
  it("keeps current and timestamps on replay and ignores a different incoming current flag", () => {
    const local = version(); const next = version({ is_current: false, updated_at: LATER });
    const result = planTranscriptCacheVersion(local, next, scope);
    same(result.kind, "unchanged"); same(result.version.is_current, true); same(result.version.updated_at, NOW);
    same(planTranscriptCacheVersion(version({ is_current: false }), version(), scope).version.is_current, false);
  });
  it("compares equivalent UUID/checksum casing, JSON key order and timestamp offsets", () => {
    const a = version({ language_summary: { z: [{ a: 1, b: true }], a: null } });
    const b = version({ id: a.id.toUpperCase(), workspace_id: WORKSPACE.toUpperCase(),
      content_checksum_sha256: "A".repeat(64), created_at: "2026-09-09T19:00:00.123456+07:00",
      language_summary: { a: null, z: [{ b: true, a: 1 }] } });
    same(planTranscriptCacheVersion(a, b, scope).kind, "unchanged");
  });
  it.each(["created_by", "transcription_run_id"] as const)("clears %s monotonically and never restores it", (key) => {
    const local = version(); const newer = version({ [key]: null, updated_at: LATER });
    const cleared = planTranscriptCacheVersion(local, newer, scope);
    same(cleared.kind, "clear_provenance"); equal(cleared.cleared, [key]); same(cleared.version[key], null);
    same(cleared.version.updated_at, LATER);
    const replay = planTranscriptCacheVersion(cleared.version, local, scope);
    same(replay.kind, "unchanged"); same(replay.version[key], null); same(replay.version.updated_at, LATER);
    rejected(() => planTranscriptCacheVersion(local, version({ [key]: OTHER }), scope), "CACHE_MERGE_CONFLICT");
  });
  it("clears both nullable fields without moving an existing timestamp backwards", () => {
    const result = planTranscriptCacheVersion(version({ updated_at: LATER }), version({ created_by: null, transcription_run_id: null }), scope);
    same(result.version.updated_at, LATER); same(result.version.created_by, null); same(result.version.transcription_run_id, null);
    equal(result.cleared, ["created_by", "transcription_run_id"]);
  });
  it.each<[string, unknown]>([
    ["id", id(2)], ["workspace_id", OTHER], ["session_id", OTHER], ["version", 2], ["version_origin", "import"],
    ["version_status", "draft"], ["parent_version_id", id(2)], ["plain_text", "different"],
    ["content_checksum_sha256", "b".repeat(64)], ["created_at", LATER], ["language_summary", { languages: ["en", "id"] }],
  ])("rejects immutable change: %s", (field, value) => {
    rejected(() => planTranscriptCacheVersion(version(), { ...version(), [field as string]: value }, scope), "CACHE_MERGE_CONFLICT");
  });
  it("does not equate whitespace or canonically equivalent Unicode text", () => {
    for (const next of [version().plain_text.trim(), version().plain_text.replace("\u00e9", "e\u0301"), version().plain_text.replace("\n", "\r\n")]) {
      rejected(() => planTranscriptCacheVersion(version(), version({ plain_text: next }), scope), "CACHE_MERGE_CONFLICT");
    }
  });
  it("supports import/draft records and optional checksums without provider-specific admission", () => {
    const imported = version({ version_origin: "import", version_status: "draft", transcription_run_id: null,
      created_by: null, parent_version_id: null, content_checksum_sha256: null, plain_text: "", is_current: false });
    same(planTranscriptCacheVersion(null, imported, scope).kind, "insert");
    same(planTranscriptCacheVersion(imported, imported, scope).kind, "unchanged");
  });
  it("validates a final parented user edit without requiring run provenance", () => {
    const edit = version({ id: id(2), version: 2, version_origin: "user_edit", parent_version_id: id(1), transcription_run_id: null });
    same(planTranscriptCacheVersion(null, edit, scope).kind, "insert");
    for (const patch of [{ parent_version_id: null }, { version_status: "draft" }, { content_checksum_sha256: null }, { plain_text: "   " }]) {
      rejected(() => planTranscriptCacheVersion(null, { ...edit, ...patch }, scope));
    }
  });
  it.each([undefined, null, "1", 0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects invalid version number %s", (value) => {
    rejected(() => planTranscriptCacheVersion(null, { ...version(), version: value }, scope));
  });
  it.each(["created_by", "transcription_run_id", "content_checksum_sha256", "parent_version_id"])("requires explicit nullable %s", (key) => {
    const input: Record<string, unknown> = { ...version() }; delete input[key];
    rejected(() => planTranscriptCacheVersion(null, input, scope));
  });
  it("rejects raw database rows, extra fields, bad dates and self ancestry", () => {
    for (const input of [{ ...version(), is_current: 1 }, { ...version(), language_summary: "{}" },
      { ...version(), secret: "PRIVATE" }, { ...version(), created_at: "yesterday" }, version({ parent_version_id: id(1) }),
      version({ plain_text: "\ud800" }), version({ plain_text: "text\0suffix" })]) rejected(() => planTranscriptCacheVersion(null, input, scope));
  });
  it("rejects accessors without invoking them and redacts arbitrary input failures", () => {
    let called = false; const input = version();
    Object.defineProperty(input, "plain_text", { enumerable: true, get: () => { called = true; throw new Error("PRIVATE"); } });
    rejected(() => planTranscriptCacheVersion(null, input, scope)); same(called, false);
    rejected(() => planTranscriptCacheVersion(null, new Proxy({}, { ownKeys() { throw new Error("PRIVATE"); } }), scope));
  });
  it("does not prototype-pollute through JSON keys and freezes detached metadata", () => {
    const metadata = JSON.parse('{"__proto__":{"polluted":true},"nested":{"constructor":"data"}}') as Record<string, unknown>;
    const result = planTranscriptCacheVersion(null, version({ language_summary: metadata }), scope);
    same(({} as Record<string, unknown>).polluted, undefined);
    same((result.version.language_summary.__proto__ as Record<string, unknown>).polluted, true);
    ok(Object.isFrozen(result.version.language_summary.nested)); notStrictEqual(result.version.language_summary.nested, metadata.nested);
  });
  it("rejects non-JSON metadata, cycles, sparse arrays, accessor values and excessive depth", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const accessor = Object.defineProperty({}, "x", { enumerable: true, get: () => "PRIVATE" });
    for (const value of [{ x: undefined }, { x: NaN }, { x: Infinity }, { x: new Date(0) },
      { x: () => 1 }, { x: BigInt(1) }, { x: new Array(2) }, cycle, accessor]) {
      rejected(() => planTranscriptCacheVersion(null, version({ language_summary: value }), scope));
    }
    let nested: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_CACHE_MERGE_JSON_DEPTH; i += 1) nested = { next: nested };
    rejected(() => planTranscriptCacheVersion(null, version({ language_summary: nested }), scope), "CACHE_MERGE_LIMIT_EXCEEDED");
  });
});

describe("C2A append-only segment merge", () => {
  it("appends missing segments in index order and never mutates caller arrays", () => {
    const incoming = [segment(2), segment(0), segment(1)]; const before = JSON.stringify(incoming);
    const plan = planTranscriptCacheSegments(version(), [segment(1)], incoming, { kind: "complete", expectedSegmentCount: 3 }, scope);
    equal(plan.segmentsToInsert.map((row) => row.segment_index), [0, 2]); same(plan.coverage, "declared_complete");
    same(JSON.stringify(incoming), before); ok(Object.isFrozen(plan)); ok(Object.isFrozen(plan.segmentsToInsert[0]));
  });
  it("keeps a partial response partial even when all supplied segments are already local", () => {
    const plan = planTranscriptCacheSegments(version(), [segment(0), segment(1)], [segment(0)], { kind: "partial" }, scope);
    same(plan.kind, "unchanged"); same(plan.coverage, "not_proven"); equal(plan.segmentsToInsert, []);
  });
  it("does not permit a complete subset or empty response to erase existing evidence", () => {
    rejected(() => planTranscriptCacheSegments(version(), [segment(0), segment(1)], [segment(0)],
      { kind: "complete", expectedSegmentCount: 1 }, scope), "CACHE_MERGE_CONFLICT");
    rejected(() => planTranscriptCacheSegments(version(), [segment()], [], { kind: "complete", expectedSegmentCount: 0 }, scope), "CACHE_MERGE_CONFLICT");
  });
  it("distinguishes count/gap failures from partial coverage", () => {
    rejected(() => planTranscriptCacheSegments(version(), [], [segment()], { kind: "complete", expectedSegmentCount: 2 }, scope), "CACHE_MERGE_INCOMPLETE");
    rejected(() => planTranscriptCacheSegments(version(), [], [segment(1)], { kind: "complete", expectedSegmentCount: 1 }, scope), "CACHE_MERGE_INCOMPLETE");
    same(planTranscriptCacheSegments(version(), [], [segment(9)], { kind: "partial" }, scope).coverage, "not_proven");
  });
  it.each(["id", "workspace_id", "session_id", "transcript_version_id", "segment_index", "start_ms", "end_ms",
    "text", "language_code", "speaker_label", "confidence", "provider_segment_id", "created_at", "updated_at"])(
    "rejects changed segment field %s rather than overwriting", (key) => {
      const next: Record<string, unknown> = { ...segment() };
      const replacements: Record<string, unknown> = { id: OTHER, workspace_id: OTHER, session_id: OTHER,
        transcript_version_id: OTHER, segment_index: 1, start_ms: 1, end_ms: 19, text: "changed", language_code: "id",
        speaker_label: "new", confidence: 0.9, provider_segment_id: "other", created_at: LATER, updated_at: LATER };
      next[key] = replacements[key];
      rejected(() => planTranscriptCacheSegments(version(), [segment()], [next], { kind: "partial" }, scope), "CACHE_MERGE_CONFLICT");
    });
  it("rejects duplicate IDs/indexes both locally and remotely", () => {
    for (const values of [[segment(), segment()], [segment(), segment(1, { id: segment().id })]]) {
      rejected(() => planTranscriptCacheSegments(version(), values, [], { kind: "partial" }, scope), "CACHE_MERGE_CONFLICT");
      rejected(() => planTranscriptCacheSegments(version(), [], values, { kind: "partial" }, scope), "CACHE_MERGE_CONFLICT");
    }
  });
  it("compares equivalent timestamp instants and retains nullable/generic provider fields", () => {
    const a = segment(0, { provider_segment_id: "opaque:from-import", language_code: "ja" });
    const b = { ...a, created_at: "2026-09-09T19:00:00.123456+07:00" };
    same(planTranscriptCacheSegments(version(), [a], [b], { kind: "complete", expectedSegmentCount: 1 }, scope).kind, "unchanged");
  });
  it("allows explicitly empty imported/user-edit coverage without claiming provider cleanup proof", () => {
    const imported = version({ version_origin: "import" });
    same(planTranscriptCacheSegments(imported, [], [], { kind: "complete", expectedSegmentCount: 0 }, scope).coverage, "declared_complete");
    const edit = version({ id: id(2), version: 2, version_origin: "user_edit", parent_version_id: id(1) });
    same(planTranscriptCacheSegments(edit, [], [], { kind: "complete", expectedSegmentCount: 0 }, scope).kind, "unchanged");
    rejected(() => planTranscriptCacheSegments(edit, [segment(0, { transcript_version_id: id(2) })], [], { kind: "partial" }, scope), "CACHE_MERGE_CONFLICT");
  });
  it.each([{ confidence: NaN }, { confidence: 2 }, { start_ms: -1 }, { end_ms: -1 }, { text: "   " },
    { language_code: undefined }, { segment_index: 1.2 }, { updated_at: "invalid" }])("rejects malformed segment %j", (patch) => {
    rejected(() => planTranscriptCacheSegments(version(), [], [{ ...segment(), ...patch }], { kind: "partial" }, scope));
  });
  it("does not inherit the history writer's 5,000-segment admission cap", () => {
    const values = Array.from({ length: 5001 }, (_, index) => segment(index));
    same(planTranscriptCacheSegments(version(), [], values, { kind: "complete", expectedSegmentCount: values.length }, scope).segmentsToInsert.length, 5001);
    rejected(() => planTranscriptCacheSegments(version(), [], new Array(MAX_CACHE_MERGE_SEGMENTS + 1), { kind: "partial" }, scope), "CACHE_MERGE_LIMIT_EXCEEDED");
  });
  it("rejects sparse arrays, forged coverage and extra completeness flags", () => {
    rejected(() => planTranscriptCacheSegments(version(), [], new Array(1), { kind: "partial" }, scope));
    rejected(() => planTranscriptCacheSegments(version(), [], [], { kind: "partial", expectedSegmentCount: 0 } as never, scope));
    rejected(() => planTranscriptCacheSegments(version(), [], [], {} as never, scope));
  });
  it("contains only a type import and no active storage, auth, crypto or runtime caller", () => {
    const source = readFileSync(resolve(process.cwd(), "src/services/transcription/cache-merge.ts"), "utf8");
    equal(source.match(/^import[^;]+;/gm), ['import type { SyncedTranscriptSegment, SyncedTranscriptVersionRecord } from "./result-types";']);
    for (const forbidden of ["Date.now(", "Math.random(", "getSupabase(", "console.", ".rpc(", "openLocalDb(", "digestStringAsync("])
      same(source.includes(forbidden), false);
  });
});
