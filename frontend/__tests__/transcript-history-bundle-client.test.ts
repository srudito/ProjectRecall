import { createHash } from "node:crypto";
import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";
import * as Crypto from "expo-crypto";

import { fetchTranscriptHistoryBundle } from "@/src/services/transcription/history-bundle-client";
import {
  HISTORY_BUNDLE_RUN_COLUMNS, HISTORY_BUNDLE_SEGMENT_COLUMNS, MAX_HISTORY_BUNDLE_REQUESTS,
} from "@/src/services/transcription/history-bundle-types";
import { HISTORY_CLOUD_DETAIL_COLUMNS, MAX_HISTORY_CLOUD_TEXT_BYTES } from "@/src/services/transcription/history-cloud-types";

let mockDeleting = false;
let mockClient: SupabaseClient | null = null;
jest.mock("@/src/services/account-deletion/state", () => ({ isAccountDeletionLocallyPending: () => mockDeleting }));
jest.mock("@/src/services/supabase/client", () => ({ getSupabase: () => mockClient }));
jest.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: jest.fn() }));
const digest = Crypto.digestStringAsync as jest.MockedFunction<typeof Crypto.digestStringAsync>;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ARTIFACT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-09-08T17:00:00.123456Z";
const CLEANUP = "2026-09-08T17:00:01.123456Z";
const TEXT = "  Bahasa / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00  ";
const version = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(n), workspace_id: WORKSPACE, session_id: SESSION, version: n,
  version_origin: n === 1 ? "provider" : "user_edit", version_status: "final", parent_version_id: n === 1 ? null : id(n - 1),
  created_by: USER, transcription_run_id: id(500), plain_text: TEXT + n, content_checksum_sha256: hash(TEXT + n),
  language_summary: { primaryLanguage: null, detectedLanguages: ["en", "id"] }, created_at: NOW, updated_at: NOW, is_current: n === 2, ...extra,
});
const run = (): Record<string, unknown> => ({ id: id(500), processing_job_id: id(501), workspace_id: WORKSPACE, session_id: SESSION,
  recording_id: id(502), status: "succeeded",
  provider_job_id: ARTIFACT, provider_cleanup_status: "succeeded", provider_cleanup_completed_at: CLEANUP, completed_at: NOW, word_count: 2 });
const job = (): Record<string, unknown> => ({ id: id(501), workspace_id: WORKSPACE, session_id: SESSION, recording_id: id(502), status: "succeeded", completed_at: NOW });
const segment = (n: number): Record<string, unknown> => ({ id: id(1000 + n), workspace_id: WORKSPACE, session_id: SESSION,
  transcript_version_id: id(1), segment_index: n, start_ms: n * 10, end_ms: n * 10 + 8, text: ` word ${n} `,
  confidence: 0.8, language_code: "en", speaker_label: null, provider_segment_id: `${ARTIFACT}:word:${n}`, created_at: NOW, updated_at: NOW });
type Reply = { data: unknown; error: unknown; status: number };
const ok = (data: unknown): Reply => ({ data, error: null, status: 200 });
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

/** Only SELECT-shaped methods exist. Any RPC/mutation would fail the executed tests. */
class Query implements PromiseLike<Reply> {
  columns = ""; filters = new Map<string, unknown>(); after = -1; take = 0;
  signal?: AbortSignal; ascending?: boolean;
  constructor(readonly table: string, private readonly execute: (query: Query) => Reply | Promise<Reply>) {}
  select(columns: string) { this.columns = columns; return this; }
  eq(column: string, value: unknown) { this.filters.set(column, value); return this; }
  gt(column: string, value: number) { if (column !== "segment_index") throw new Error("Unexpected keyset"); this.after = value; return this; }
  order(column: string, options: { ascending: boolean }) { if (column !== "segment_index") throw new Error("Unexpected order"); this.ascending = options.ascending; return this; }
  limit(take: number) { this.take = take; return this; }
  abortSignal(signal: AbortSignal) { this.signal = signal; return this; }
  then<T = Reply, R = never>(yes?: ((value: Reply) => T | PromiseLike<T>) | null, no?: ((reason: unknown) => R | PromiseLike<R>) | null): PromiseLike<T | R> {
    return Promise.resolve().then(() => this.execute(this)).then(yes, no);
  }
}
const fixture = () => {
  const state = { versions: [version(2), version(1)], run: run() as Record<string, unknown> | null,
    job: job() as Record<string, unknown> | null, segments: [segment(0), segment(1)], cap: 500, user: USER as string | null,
    override: null as null | ((query: Query) => Reply | Promise<Reply> | undefined) };
  const listeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>();
  const session = () => state.user ? { access_token: "unit-test-token", user: { id: state.user } } as Session : null;
  const queries: Query[] = []; const unsubscribe = jest.fn();
  const answer = (q: Query): Reply => {
    if (q.table === "transcript_versions") return ok(state.versions.filter((v) => v.id === q.filters.get("id")));
    if (q.table === "transcription_runs") return ok(state.run ? [state.run] : []);
    if (q.table === "processing_jobs") return ok(state.job ? [state.job] : []);
    if (q.table === "transcript_segments") return ok(state.segments.filter((s) => s.transcript_version_id === q.filters.get("transcript_version_id") && Number(s.segment_index) > q.after).slice(0, Math.min(q.take, state.cap)));
    throw new Error("Unexpected table");
  };
  const execute = (q: Query): Reply | Promise<Reply> => state.override?.(q) ?? answer(q);
  const port = { auth: {
    getSession: jest.fn(async () => ({ data: { session: session() }, error: null as unknown })),
    onAuthStateChange: jest.fn((listener: (event: AuthChangeEvent, session: Session | null) => void) => {
      listeners.add(listener); return { data: { subscription: { unsubscribe: () => { listeners.delete(listener); unsubscribe(); } } } };
    }),
  }, from: jest.fn((table: string) => { const q = new Query(table, execute); queries.push(q); return q; }) };
  const client = port as unknown as SupabaseClient;
  const emit = (user: string | null, event: AuthChangeEvent = "SIGNED_IN") => {
    state.user = user; for (const listener of [...listeners]) listener(event, session());
  };
  const collect = () => fetchTranscriptHistoryBundle({ scope, versionId: id(2) }, client);
  return { state, port, client, queries, listeners, unsubscribe, emit, collect, answer };
};
beforeEach(() => { jest.clearAllMocks(); mockDeleting = false; mockClient = null; digest.mockImplementation(async (_a, text) => hash(text)); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe("3E.2B1 authenticated complete-bundle collector", () => {
  it("reads only the four scoped tables, verifies exact digests, and never makes a current-switch command", async () => {
    const f = fixture(); const result = await f.collect(); expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected ready");
    expect(result.bundle.versions.map((v) => v.plain_text)).toEqual([TEXT + 2, TEXT + 1]);
    expect(result.bundle.versions.map((v) => v.is_current)).toEqual([true, false]);
    expect(result.bundle.provider).not.toHaveProperty("provider_job_id"); expect(result).not.toHaveProperty("cached");
    expect(new Set(f.queries.map((q) => q.table))).toEqual(new Set(["transcript_versions", "transcription_runs", "processing_jobs", "transcript_segments"]));
    for (const q of f.queries) {
      expect(q.filters.get("workspace_id")).toBe(WORKSPACE); expect(q.filters.get("session_id")).toBe(SESSION);
      expect(q.signal).toBeDefined(); expect(q.columns).not.toBe("*");
      if (q.table === "transcript_versions") { expect(q.columns).toBe(HISTORY_CLOUD_DETAIL_COLUMNS.join(",")); expect(q.filters.get("version_status")).toBe("final"); }
    }
    expect(f.queries.find((q) => q.table === "transcription_runs")?.columns).toBe(HISTORY_BUNDLE_RUN_COLUMNS.join(","));
    expect(f.listeners.size).toBe(0); expect(f.unsubscribe).toHaveBeenCalledTimes(1); expect(digest).toHaveBeenCalledTimes(2);
  });
  it("collects a directly selected non-current provider without inventing an edit or current flag", async () => {
    const f = fixture(); const result = await fetchTranscriptHistoryBundle({ scope, versionId: id(1) }, f.client);
    if (result.kind !== "ready") throw new Error("Expected ready");
    expect(result.bundle.versions).toHaveLength(1); expect(result.bundle.versions[0].is_current).toBe(false);
  });
  it("uses the existing configured client by default and refuses missing configuration", async () => {
    await expect(fetchTranscriptHistoryBundle({ scope, versionId: id(2) })).rejects.toMatchObject({ code: "HISTORY_CLOUD_NOT_CONFIGURED" });
    const f = fixture(); mockClient = f.client; expect((await fetchTranscriptHistoryBundle({ scope, versionId: id(2) })).kind).toBe("ready");
  });
  it.each([null, {}, { scope, versionId: "bad" }, { scope, versionId: id(2), expectedVersion: 0 },
    { scope, versionId: id(2), timeoutMs: 0 }, { scope, versionId: id(2), timeoutMs: null }, { scope, versionId: id(2), timeoutMs: 60_001 }])(
    "rejects malformed input before any SDK work: %j", async (input) => {
      const f = fixture(); await expect(fetchTranscriptHistoryBundle(input as never, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INPUT_INVALID" });
      expect(f.port.auth.getSession).not.toHaveBeenCalled(); expect(f.port.from).not.toHaveBeenCalled();
    });
  it("captures request scope/selection before awaiting auth", async () => {
    const f = fixture(); const hold = deferred<Awaited<ReturnType<typeof f.port.auth.getSession>>>();
    f.port.auth.getSession.mockReturnValueOnce(hold.promise);
    const input = { scope: { ...scope, userId: USER.toUpperCase() }, versionId: id(2), expectedVersion: 2 };
    const pending = fetchTranscriptHistoryBundle(input, f.client); input.scope.sessionId = OTHER; input.versionId = OTHER;
    hold.resolve({ data: { session: { access_token: "unit-test-token", user: { id: USER } } as Session }, error: null });
    expect((await pending).selectedVersionId).toBe(id(2)); expect(f.queries[0].filters.get("session_id")).toBe(SESSION);
  });
  it("rejects a changed expected selection number", async () => {
    const f = fixture(); await expect(fetchTranscriptHistoryBundle({ scope, versionId: id(2), expectedVersion: 3 }, f.client)).rejects.toThrow();
    expect(f.queries).toHaveLength(1);
  });
  it.each(["selected", "parent", "run", "job"])("returns no partial material when %s is not visible", async (which) => {
    const f = fixture();
    if (which === "selected") f.state.versions = [];
    if (which === "parent") f.state.versions.pop();
    if (which === "run") f.state.run = null;
    if (which === "job") f.state.job = null;
    const reason = which === "selected" ? "version_not_visible" : `${which}_not_visible`;
    const result = await f.collect(); expect(result).toMatchObject({ kind: "unavailable", reason });
    expect(result).not.toHaveProperty("bundle"); expect(result).not.toHaveProperty("versions"); expect(digest).not.toHaveBeenCalled();
  });
  it.each(["pending", "leased", "manual_review"])("does not fetch segments or signal readiness during cleanup %s", async (status) => {
    const f = fixture(); f.state.run!.provider_cleanup_status = status; f.state.run!.provider_cleanup_completed_at = null;
    expect(await f.collect()).toMatchObject(status === "manual_review" ? { kind: "unavailable", reason: "cleanup_manual_review" } : { kind: "not_ready", reason: "cleanup_pending" });
    expect(f.queries.some((q) => q.table === "transcript_segments")).toBe(false); expect(digest).not.toHaveBeenCalled();
  });
  it("distinguishes nullable provider provenance from a broken user-edit lineage", async () => {
    const f = fixture(); f.state.versions[1].transcription_run_id = null;
    expect(await f.collect()).toMatchObject({ kind: "unavailable", reason: "nullable_run_provenance" });
    expect(f.queries.every((q) => q.table === "transcript_versions")).toBe(true);
    f.state.versions[0].parent_version_id = null; await expect(f.collect()).rejects.toThrow();
  });
  it.each(["import", "provider_lineage"])("does not fabricate completeness for unsupported %s", async (which) => {
    const f = fixture();
    if (which === "import") f.state.versions[1].version_origin = "import";
    if (which === "provider_lineage") f.state.versions[1].parent_version_id = id(10);
    expect((await f.collect()).kind).toBe("unavailable"); expect(f.queries.some((q) => q.table === "transcript_segments")).toBe(false);
  });
  it("rejects segment rows attached to a user edit instead of silently dropping them", async () => {
    const f = fixture(); f.state.segments.push({ ...segment(0), id: id(9000), transcript_version_id: id(2) });
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_BUNDLE_INVALID" });
    expect(f.queries.some((q) => q.columns === "id" && q.filters.get("transcript_version_id") === id(2))).toBe(true);
  });
  it("does not fetch segments for incomplete processing state", async () => {
    const f = fixture(); f.state.job!.status = "processing";
    expect(await f.collect()).toMatchObject({ kind: "not_ready", reason: "processing_incomplete" });
    expect(f.queries.some((q) => q.table === "transcript_segments")).toBe(false);
  });
  it.each([1, 2, 500])("continues short segment pages (server cap %s) to an empty terminal page", async (cap) => {
    const f = fixture(); f.state.cap = cap; f.state.segments.push(segment(2)); f.state.run!.word_count = 3;
    expect((await f.collect()).kind).toBe("ready");
    const pages = f.queries.filter((q) => q.table === "transcript_segments" && q.columns !== "id");
    expect(pages[0].after).toBe(-1); expect(pages[pages.length - 1].after).toBe(2); expect(pages[pages.length - 1].take).toBe(1);
    expect(pages.every((q) => q.ascending === true && q.columns === HISTORY_BUNDLE_SEGMENT_COLUMNS.join(","))).toBe(true);
  });
  it.each([500, 501])("handles a page boundary with %s segments and checks for extra tail data", async (count) => {
    const f = fixture(); f.state.segments = Array.from({ length: count }, (_, i) => segment(i)); f.state.run!.word_count = count;
    const result = await f.collect(); if (result.kind !== "ready") throw new Error("Expected ready");
    expect(result.bundle.segments).toHaveLength(count); expect(f.queries.filter((q) => q.table === "transcript_segments" && q.columns !== "id").at(-1)?.after).toBe(count - 1);
  });
  it.each(["missing_tail", "extra_tail", "gap", "duplicate", "wrong_scope"])("rejects segment corruption %s without returning partial evidence", async (which) => {
    const f = fixture();
    if (which === "missing_tail") f.state.segments.pop();
    if (which === "extra_tail") f.state.segments.push(segment(2));
    if (which === "gap") f.state.segments[1] = segment(2);
    if (which === "duplicate") f.state.segments[1].id = f.state.segments[0].id;
    if (which === "wrong_scope") f.state.segments[0].workspace_id = OTHER;
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_BUNDLE_INVALID" });
  });
  it.each([null, {}, "[]"])("rejects malformed segment data %j instead of accepting an empty set", async (data) => {
    const f = fixture(); f.state.override = (q) => q.table === "transcript_segments" ? ok(data) : undefined;
    await expect(f.collect()).rejects.toThrow();
  });
  it.each(["transcript_versions", "transcription_runs", "processing_jobs"])("rejects duplicate exact records from %s", async (table) => {
    const f = fixture(); f.state.override = (q) => {
      if (q.table !== table) return undefined;
      const reply = f.answer(q); return ok([...(reply.data as unknown[]), ...(reply.data as unknown[])]);
    };
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_BUNDLE_INVALID" });
  });
  it("rejects a mismatched run scope before using its job reference", async () => {
    const f = fixture(); f.state.run!.workspace_id = OTHER; await expect(f.collect()).rejects.toThrow();
    expect(f.queries.some((q) => q.table === "processing_jobs")).toBe(false);
  });
  it("accepts exactly 64 parent links within the request budget", async () => {
    const f = fixture(); f.state.versions = Array.from({ length: 65 }, (_, i) => version(65 - i, { is_current: i === 0 }));
    const result = await fetchTranscriptHistoryBundle({ scope, versionId: id(65) }, f.client);
    if (result.kind !== "ready") throw new Error("Expected ready");
    expect(result.bundle.versions).toHaveLength(65); expect(f.queries.length).toBeLessThan(MAX_HISTORY_BUNDLE_REQUESTS);
  });
  it("refuses too many parent links without treating the ancestry as complete", async () => {
    const f = fixture(); f.state.versions = Array.from({ length: 66 }, (_, i) => version(66 - i));
    await expect(fetchTranscriptHistoryBundle({ scope, versionId: id(66) }, f.client)).rejects.toMatchObject({ code: "HISTORY_BUNDLE_LIMIT_EXCEEDED" });
  });
  it("bounds request count even if the server supplies one segment per page", async () => {
    const f = fixture(); f.state.cap = 1; f.state.segments = Array.from({ length: MAX_HISTORY_BUNDLE_REQUESTS + 1 }, (_, i) => segment(i));
    f.state.run!.word_count = f.state.segments.length;
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_BUNDLE_LIMIT_EXCEEDED" });
    expect(f.queries.length).toBe(MAX_HISTORY_BUNDLE_REQUESTS);
  });
  it("rejects a detail beyond the decoded Full Text budget rather than truncating it", async () => {
    const f = fixture(); f.state.versions[0].plain_text = "x".repeat(MAX_HISTORY_CLOUD_TEXT_BYTES + 1);
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_CLOUD_LIMIT_EXCEEDED" });
  });
  it.each(["deleted_provider", "cleared_provider_run", "changed_text", "changed_count"])("rechecks evidence at the end: %s", async (which) => {
    const f = fixture(); let changed = false;
    f.state.override = (q) => {
      if (!changed && q.table === "transcript_segments" && q.after === 1) {
        changed = true;
        if (which === "deleted_provider") f.state.versions.pop();
        if (which === "cleared_provider_run") f.state.versions[1].transcription_run_id = null;
        if (which === "changed_text") f.state.versions[0].plain_text = "unexpected new text";
        if (which === "changed_count") f.state.run!.word_count = 3;
      }
      return undefined;
    };
    if (which.startsWith("changed")) await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_BUNDLE_PROOF_CHANGED" });
    else expect((await f.collect()).kind).toBe("unavailable");
  });
  it("preserves final marker/reference observations when the selected edit is demoted during collection", async () => {
    const f = fixture(); f.state.override = (q) => {
      if (q.table === "transcript_segments" && q.after === 1) {
        f.state.versions[0].is_current = false; f.state.versions[0].transcription_run_id = null; f.state.versions[0].created_by = null;
      } return undefined;
    };
    const result = await f.collect(); if (result.kind !== "ready") throw new Error("Expected ready");
    expect(result.bundle.versions[0]).toMatchObject({ is_current: false, transcription_run_id: null, created_by: null });
  });
  it("rejects checksum mismatches after all reads without returning readiness", async () => {
    const f = fixture(); f.state.versions[0].content_checksum_sha256 = "0".repeat(64);
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_BUNDLE_CHECKSUM_MISMATCH" });
  });
});

describe("3E.2B1 whole-operation lifetime and errors", () => {
  it.each(["cancelled", "inactive", "deleting", "wrong_user"])("refuses admission: %s", async (reason) => {
    const f = fixture(); const abort = new AbortController();
    if (reason === "cancelled") abort.abort("PRIVATE REASON");
    if (reason === "deleting") mockDeleting = true;
    if (reason === "wrong_user") f.state.user = OTHER;
    await expect(fetchTranscriptHistoryBundle({ scope, versionId: id(2), signal: abort.signal, isContextActive: () => reason !== "inactive" }, f.client)).rejects.toThrow();
    expect(f.port.from).not.toHaveBeenCalled();
  });
  it("does not revive A's bundle after A -> B -> A between queries", async () => {
    const f = fixture(); f.state.override = (q) => {
      if (q.table === "transcription_runs") { f.emit(OTHER); f.emit(USER); } return undefined;
    };
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
    expect(f.queries.some((q) => q.table === "processing_jobs")).toBe(false); expect(f.listeners.size).toBe(0);
  });
  it("allows same-account token refresh without restarting the bundle", async () => {
    const f = fixture(); f.state.override = () => { f.emit(USER, "TOKEN_REFRESHED"); return undefined; };
    expect((await f.collect()).kind).toBe("ready");
  });
  it("handles an auth callback invoked synchronously on subscription", async () => {
    const f = fixture(); f.port.auth.onAuthStateChange.mockImplementationOnce((listener) => {
      listener("SIGNED_OUT", null); return { data: { subscription: { unsubscribe: f.unsubscribe } } };
    });
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
    expect(f.queries).toHaveLength(0); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("checks SDK identity again even when no auth event was delivered", async () => {
    const f = fixture(); f.state.override = (q) => { if (q.table === "processing_jobs") f.state.user = null; return undefined; };
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
  });
  it("holds the lifetime across async hashing, where per-query guards alone are insufficient", async () => {
    const f = fixture(); digest.mockImplementationOnce(async (_a, text) => { f.emit(OTHER); f.emit(USER); return hash(text); });
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
  });
  it.each(["context", "deletion"])("blocks late data after %s changes while waiting for segments", async (which) => {
    const f = fixture(); let active = true; const gate = deferred<Reply>();
    f.state.override = (q) => q.table === "transcript_segments" ? gate.promise : undefined;
    const pending = expect(fetchTranscriptHistoryBundle({ scope, versionId: id(2), isContextActive: () => active }, f.client))
      .rejects.toMatchObject({ code: which === "context" ? "HISTORY_CLOUD_CONTEXT_INACTIVE" : "HISTORY_CLOUD_DELETION_PENDING" });
    // Wait for the deterministic fake to reach the first segment request, not a wall-clock sleep.
    for (let attempt = 0; attempt < 100 && !f.queries.some((q) => q.table === "transcript_segments"); attempt += 1) await tick();
    expect(f.queries.some((q) => q.table === "transcript_segments")).toBe(true);
    if (which === "context") active = false; else mockDeleting = true;
    gate.resolve(ok([segment(0), segment(1)])); await pending;
    expect(digest).not.toHaveBeenCalled();
  });
  it("times out the complete operation, aborts transport, and consumes a late rejection", async () => {
    jest.useFakeTimers(); const f = fixture(); const gate = deferred<Reply>(); f.state.override = () => gate.promise;
    const pending = expect(fetchTranscriptHistoryBundle({ scope, versionId: id(2), timeoutMs: 100 }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_TIMEOUT" });
    await tick(); expect(f.queries).toHaveLength(1); jest.advanceTimersByTime(101); await pending;
    expect(f.queries[0].signal?.aborted).toBe(true); expect(f.listeners.size).toBe(0);
    gate.reject(new Error("PRIVATE LATE RESPONSE")); await tick(); expect(f.queries).toHaveLength(1);
  });
  it("does not release concurrency slots for abort-ignoring transport until continuations settle", async () => {
    const f = fixture(); const gate = deferred<Reply>(); f.state.override = () => gate.promise;
    const a = new AbortController(); const b = new AbortController();
    const first = expect(fetchTranscriptHistoryBundle({ scope, versionId: id(2), signal: a.signal }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_CANCELLED" });
    const second = expect(fetchTranscriptHistoryBundle({ scope, versionId: id(1), signal: b.signal }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_CANCELLED" });
    await tick(); a.abort("PRIVATE"); b.abort(); await Promise.all([first, second]);
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_CLOUD_BUSY" });
    gate.resolve(ok([])); await tick(); f.state.override = null;
    expect((await f.collect()).kind).toBe("ready");
  });
  it.each([[401, "HISTORY_CLOUD_AUTH_REQUIRED"], [403, "HISTORY_CLOUD_FORBIDDEN"], [429, "HISTORY_CLOUD_RETRYABLE_QUERY"],
    [503, "HISTORY_CLOUD_RETRYABLE_QUERY"], [0, "HISTORY_CLOUD_NETWORK_UNAVAILABLE"], [400, "HISTORY_BUNDLE_QUERY_FAILED"]])(
    "classifies HTTP %s without leaking a raw body", async (status, code) => {
      const f = fixture(); f.state.override = (q) => q.table === "transcription_runs" ? { data: null, status: Number(status), error: { message: "PRIVATE SQL TOKEN TEXT" } } : undefined;
      try { await f.collect(); throw new Error("Expected failure"); } catch (error) {
        expect(error).toMatchObject({ code }); expect(String(error)).not.toContain("PRIVATE"); expect(error).not.toHaveProperty("cause");
      }
    });
  it("sanitizes network throws and native digest failures without a retry loop", async () => {
    const f = fixture(); f.state.override = () => { throw new TypeError("PRIVATE network request failed"); };
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_CLOUD_NETWORK_UNAVAILABLE" }); expect(f.queries).toHaveLength(1);
    f.state.override = null; digest.mockRejectedValueOnce(new Error("PRIVATE NATIVE TEXT"));
    await expect(f.collect()).rejects.toMatchObject({ code: "HISTORY_BUNDLE_HASH_UNAVAILABLE" });
  });
});

describe("3E.2B1 pinned Supabase SDK with fake transport", () => {
  it("generates authenticated GETs, JSON-field projection and keyset filters with AbortSignal", async () => {
    const f = fixture();
    const fetcher = jest.fn(async (address: RequestInfo | URL, _options?: RequestInit) => {
      const url = new URL(String(address)); const table = url.pathname.split("/").at(-1)!;
      let rows: unknown[];
      if (table === "transcript_versions") rows = f.state.versions.filter((v) => `eq.${v.id}` === url.searchParams.get("id"));
      else if (table === "transcription_runs") rows = [f.state.run];
      else if (table === "processing_jobs") rows = [f.state.job];
      else if (table === "transcript_segments") rows = f.state.segments.filter((s) =>
        `eq.${s.transcript_version_id}` === url.searchParams.get("transcript_version_id") &&
        (url.searchParams.get("select") === "id" || Number(s.segment_index) > Number(url.searchParams.get("segment_index")!.slice(3))));
      else throw new Error("Unexpected network target");
      return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, text: async () => JSON.stringify(rows) } as unknown as Response;
    });
    const client = createClient("https://history-bundle-unit.invalid", "public-unit-test-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { fetch: fetcher },
    });
    jest.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: { access_token: "unit-test-token", user: { id: USER } } as Session }, error: null });
    const unsubscribe = jest.fn();
    jest.spyOn(client.auth, "onAuthStateChange").mockReturnValue({ data: { subscription: { unsubscribe } } } as never);
    expect((await fetchTranscriptHistoryBundle({ scope, versionId: id(2) }, client)).kind).toBe("ready");
    for (const [address, options] of fetcher.mock.calls) {
      const url = new URL(String(address)); expect(options?.method).toBe("GET"); expect(options?.signal).toBeDefined();
      const headers = options?.headers as { get(name: string): string | null };
      expect(headers.get("Authorization")).toBe("Bearer unit-test-token");
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${WORKSPACE}`); expect(url.searchParams.get("session_id")).toBe(`eq.${SESSION}`);
      if (url.pathname.endsWith("transcription_runs")) expect(url.searchParams.get("select")).toContain("word_count:provider_metadata->wordCount");
      if (url.pathname.endsWith("transcript_segments") && url.searchParams.get("select") !== "id") {
        expect(url.searchParams.get("transcript_version_id")).toBe(`eq.${id(1)}`);
        expect(url.searchParams.get("order")).toBe("segment_index.asc"); expect(url.searchParams.get("offset")).toBeNull();
      }
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
