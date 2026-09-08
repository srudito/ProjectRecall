import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";

import { fetchTranscriptHistoryPage, fetchTranscriptHistoryVersion } from "@/src/services/transcription/history-client";
import {
  HISTORY_CLOUD_DETAIL_COLUMNS, HISTORY_CLOUD_SUMMARY_COLUMNS,
  MAX_HISTORY_CLOUD_TEXT_BYTES, TRANSCRIPT_HISTORY_CLOUD_SOURCE, TranscriptHistoryCloudError,
  type TranscriptHistoryCloudCursor,
} from "@/src/services/transcription/history-cloud-types";

let mockDeleting = false;
let mockConfiguredClient: SupabaseClient | null = null;
jest.mock("@/src/services/account-deletion/state", () => ({ isAccountDeletionLocallyPending: () => mockDeleting }));
jest.mock("@/src/services/supabase/client", () => ({ getSupabase: () => mockConfiguredClient }));
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const summary = (version = 3, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(version), workspace_id: WORKSPACE, session_id: SESSION, version,
  version_origin: "provider", version_status: "final", parent_version_id: null,
  created_by: null, transcription_run_id: null, content_checksum_sha256: null,
  created_at: "2026-09-08T16:00:00.123456+00:00", updated_at: "2026-09-08T16:00:00.123456+00:00",
  is_current: false, ...extra,
});
const detail = (version = 3, extra: Record<string, unknown> = {}) => ({
  ...summary(version), plain_text: "  Bahasa / English\n\u00e9 \u6f22\u5b57 \ud83d\ude00  ",
  language_summary: { primaryLanguage: null, languages: ["en", "id"] }, ...extra,
});
const cursor = (): TranscriptHistoryCloudCursor => ({ source: TRANSCRIPT_HISTORY_CLOUD_SOURCE,
  scope: { ...scope }, upperVersion: 10, beforeVersion: 8 });
type Reply = { data: unknown; error: unknown; status: number };
const ok = (data: unknown): Reply => ({ data, error: null, status: 200 });
const deferred = <T,>() => {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

/** SDK-shaped unit fixture; the separate integration test uses the pinned SDK. */
class Query implements PromiseLike<Reply> {
  calls: [string, ...unknown[]][] = [];
  signal?: AbortSignal;
  constructor(private readonly response: () => Promise<Reply> | Reply) {}
  select(columns: string) { this.calls.push(["select", columns]); return this; }
  eq(column: string, value: unknown) { this.calls.push(["eq", column, value]); return this; }
  order(column: string, value: unknown) { this.calls.push(["order", column, value]); return this; }
  limit(value: number) { this.calls.push(["limit", value]); return this; }
  lte(column: string, value: number) { this.calls.push(["lte", column, value]); return this; }
  lt(column: string, value: number) { this.calls.push(["lt", column, value]); return this; }
  abortSignal(signal: AbortSignal) { this.signal = signal; return this; }
  then<TResult1 = Reply, TResult2 = never>(
    onfulfilled?: ((value: Reply) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve().then(this.response).then(onfulfilled, onrejected);
  }
}
const fixture = (initial: Reply = ok([summary()])) => {
  const state = { reply: initial, userId: USER as string | null };
  const listeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>();
  const session = () => state.userId ? { access_token: "unit-test-token", user: { id: state.userId } } as Session : null;
  const queries: Query[] = [];
  const responses: (() => Reply | Promise<Reply>)[] = [];
  const unsubscribed = jest.fn();
  const port = {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: session() }, error: null as unknown })),
      onAuthStateChange: jest.fn((listener: (event: AuthChangeEvent, session: Session | null) => void) => {
        listeners.add(listener);
        return { data: { subscription: { unsubscribe: () => { listeners.delete(listener); unsubscribed(); } } } };
      }),
    },
    from: jest.fn((_table: string) => {
      const query = new Query(responses.shift() ?? (() => state.reply)); queries.push(query); return query;
    }),
  };
  const client = port as unknown as SupabaseClient;
  const emit = (userId: string | null, event: AuthChangeEvent = "SIGNED_IN") => {
    state.userId = userId; for (const listener of [...listeners]) listener(event, session());
  };
  return { client, state, port, queries, responses, listeners, unsubscribed, emit };
};
beforeEach(() => { jest.clearAllMocks(); mockDeleting = false; mockConfiguredClient = null; });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe("3E.2A authenticated history SELECT client", () => {
  it("uses only scoped final-version metadata SELECTs and checks auth before and after", async () => {
    const f = fixture(ok([summary(7), summary(3)]));
    const result = await fetchTranscriptHistoryPage({ scope }, f.client);
    expect(f.port.auth.getSession).toHaveBeenCalledTimes(2);
    expect(f.port.from).toHaveBeenCalledTimes(1); expect(f.port.from).toHaveBeenCalledWith("transcript_versions");
    expect(f.queries[0].calls).toEqual([
      ["select", HISTORY_CLOUD_SUMMARY_COLUMNS.join(",")], ["eq", "workspace_id", WORKSPACE],
      ["eq", "session_id", SESSION], ["eq", "version_status", "final"],
      ["order", "version", { ascending: false }], ["limit", 25],
    ]);
    expect(HISTORY_CLOUD_SUMMARY_COLUMNS.join(",")).not.toContain("plain_text");
    expect(result).toMatchObject({ windowUpperVersion: 7, visibleWindowExhausted: false,
      nextCursor: { source: TRANSCRIPT_HISTORY_CLOUD_SOURCE, scope, upperVersion: 7, beforeVersion: 3 } });
    expect(f.listeners.size).toBe(0); expect(f.unsubscribed).toHaveBeenCalledTimes(1);
  });
  it("uses the existing configured client without creating another Supabase client", async () => {
    const f = fixture(); mockConfiguredClient = f.client;
    await fetchTranscriptHistoryPage({ scope }); expect(f.port.from).toHaveBeenCalledTimes(1);
  });
  it("fails explicitly without Supabase configuration", async () => {
    await expect(fetchTranscriptHistoryPage({ scope })).rejects.toMatchObject({ code: "HISTORY_CLOUD_NOT_CONFIGURED" });
  });
  it.each([1, 25, 100])("continues from a short/nonempty page with requested size %s", async (pageSize) => {
    const f = fixture(ok([summary(1)])); const result = await fetchTranscriptHistoryPage({ scope, pageSize }, f.client);
    expect(result.visibleWindowExhausted).toBe(false); expect(result.nextCursor?.beforeVersion).toBe(1);
    f.state.reply = ok([]);
    const last = await fetchTranscriptHistoryPage({ scope, cursor: result.nextCursor }, f.client);
    expect(last).toMatchObject({ versions: [], windowUpperVersion: 1, nextCursor: null, visibleWindowExhausted: true });
    expect(f.queries[1].calls).toContainEqual(["lt", "version", 1]);
  });
  it("keeps the cloud window across pages without using offsets or local cursors", async () => {
    const f = fixture(ok([summary(7), summary(2)])); const input = cursor();
    const page = await fetchTranscriptHistoryPage({ scope, cursor: input }, f.client);
    expect(page.windowUpperVersion).toBe(10); expect(page.nextCursor?.beforeVersion).toBe(2);
    expect(f.queries[0].calls).toContainEqual(["lte", "version", 10]);
    expect(f.queries[0].calls).toContainEqual(["lt", "version", 8]);
  });
  it("returns empty visibility rather than a deletion command or cloud-total claim", async () => {
    const f = fixture(ok([])); const result = await fetchTranscriptHistoryPage({ scope }, f.client);
    expect(result).toEqual({ source: TRANSCRIPT_HISTORY_CLOUD_SOURCE, scope, versions: [],
      windowUpperVersion: null, nextCursor: null, visibleWindowExhausted: true });
    expect(result).not.toHaveProperty("totalCount");
  });
  it.each([0, -1, 1.5, 101, NaN, Infinity, "25", null])("rejects invalid page size %s before any auth/query", async (pageSize) => {
    const f = fixture(); await expect(fetchTranscriptHistoryPage({ scope, pageSize } as never, f.client))
      .rejects.toMatchObject({ code: "HISTORY_CLOUD_INPUT_INVALID" });
    expect(f.port.from).not.toHaveBeenCalled(); expect(f.port.auth.getSession).not.toHaveBeenCalled();
  });
  it.each([0, -1, 60_001, 1.5, "20", null])("rejects invalid timeout %s before any auth/query", async (timeoutMs) => {
    const f = fixture(); await expect(fetchTranscriptHistoryPage({ scope, timeoutMs } as never, f.client))
      .rejects.toMatchObject({ code: "HISTORY_CLOUD_INPUT_INVALID" }); expect(f.port.auth.getSession).not.toHaveBeenCalled();
  });
  it.each(["userId", "workspaceId", "sessionId"] as const)("rejects a cloud cursor from another %s", async (field) => {
    const f = fixture(); const c = cursor(); c.scope = { ...scope, [field]: OTHER };
    await expect(fetchTranscriptHistoryPage({ scope, cursor: c }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INPUT_INVALID" });
    expect(f.port.from).not.toHaveBeenCalled();
  });
  it.each([{}, { upperVersion: 2, beforeVersion: 3 }, { upperVersion: 0, beforeVersion: 1 },
    { upperVersion: 2_147_483_648, beforeVersion: 1 }, { upperVersion: 10, beforeVersion: 0 }])(
    "rejects malformed cursor window %j", async (changes) => {
      const f = fixture(); const c = Object.keys(changes).length ? { ...cursor(), ...changes } : { scope, upperVersion: 10, beforeVersion: 8 };
      await expect(fetchTranscriptHistoryPage({ scope, cursor: c } as never, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INPUT_INVALID" });
    });
  it("captures caller inputs before awaits and normalizes UUID case", async () => {
    const f = fixture(ok([summary(7)])); const hold = deferred<{ data: { session: Session | null }; error: unknown }>();
    f.port.auth.getSession.mockReturnValueOnce(hold.promise);
    const input = { scope: { ...scope, userId: USER.toUpperCase() }, cursor: cursor() };
    const pending = fetchTranscriptHistoryPage(input, f.client); input.scope.sessionId = OTHER; input.cursor.beforeVersion = 2;
    hold.resolve({ data: { session: { access_token: "unit-test-token", user: { id: USER } } as Session }, error: null });
    const result = await pending; expect(result.scope).toEqual(scope);
    expect(f.queries[0].calls).toContainEqual(["lt", "version", 8]);
  });
  it.each(["workspace_id", "session_id", "id", "version", "version_origin", "version_status",
    "parent_version_id", "created_by", "transcription_run_id", "content_checksum_sha256", "created_at", "updated_at", "is_current"])(
    "rejects malformed metadata %s", async (field) => {
      const f = fixture(ok([summary(3, { [field]: "invalid" })]));
      await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
    });
  it.each(["parent_version_id", "created_by", "transcription_run_id", "content_checksum_sha256"])(
    "requires explicit nullable field %s rather than treating missing as null", async (field) => {
      const value = summary(); delete value[field]; const f = fixture(ok([value]));
      await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
    });
  it.each(["2026-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "not a date", "2026-09-08"])(
    "rejects malformed timestamp %s", async (created_at) => {
      const f = fixture(ok([summary(3, { created_at })]));
      await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
    });
  it.each(["duplicate_id", "duplicate_number", "ascending", "outside_window", "two_current", "self_parent", "edit_shape", "extra_columns"])(
    "rejects invalid history page %s", async (kind) => {
      const cases: Record<string, Record<string, unknown>[]> = {
        duplicate_id: [summary(7), summary(6, { id: id(7) })], duplicate_number: [summary(7), summary(7, { id: id(6) })],
        ascending: [summary(2), summary(7)], outside_window: [summary(8)],
        two_current: [summary(7, { is_current: true }), summary(6, { is_current: true })],
        self_parent: [summary(7, { parent_version_id: id(7) })], edit_shape: [summary(7, { version_origin: "user_edit" })],
        extra_columns: [summary(7, { plain_text: "Unexpected Full Text" })],
      };
      const f = fixture(ok(cases[kind]));
      await expect(fetchTranscriptHistoryPage({ scope, cursor: cursor() }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
    });
  it.each([null, {}, "[]"])("does not treat malformed response data %j as empty", async (data) => {
    const f = fixture(ok(data)); await expect(fetchTranscriptHistoryPage({ scope }, f.client))
      .rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
  });
  it("bounds returned rows and decoded metadata bytes", async () => {
    const f = fixture(ok([summary(3), summary(2)]));
    await expect(fetchTranscriptHistoryPage({ scope, pageSize: 1 }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_LIMIT_EXCEEDED" });
    f.state.reply = ok([summary(3, { created_at: "a".repeat(262_145) })]);
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_LIMIT_EXCEEDED" });
  });
  it("reads exact detail without segment/cleanup/cache promises and returns detached nested JSON", async () => {
    const value = detail(); const f = fixture(ok([value]));
    const result = await fetchTranscriptHistoryVersion({ scope, versionId: id(3), expectedVersion: 3 }, f.client);
    expect(result).toMatchObject({ kind: "ready", completeness: "version_record_only", version: { plain_text: value.plain_text, is_current: false } });
    expect(f.queries[0].calls).toContainEqual(["select", HISTORY_CLOUD_DETAIL_COLUMNS.join(",")]);
    expect(f.queries[0].calls).toContainEqual(["eq", "id", id(3)]); expect(f.queries[0].calls).toContainEqual(["limit", 2]);
    if (result.kind !== "ready") throw new Error("Expected detail");
    (result.version.language_summary.languages as string[]).push("other");
    expect(value.language_summary.languages).toEqual(["en", "id"]);
  });
  it.each(["provider", "import"])("preserves genuinely empty %s text", async (version_origin) => {
    const f = fixture(ok([detail(3, { plain_text: "", version_origin })]));
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).resolves.toMatchObject({ kind: "ready", version: { plain_text: "" } });
  });
  it("distinguishes not visible from empty text and rejects an identity mismatch", async () => {
    const f = fixture(ok([]));
    expect(await fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).toEqual({ kind: "not_visible",
      source: TRANSCRIPT_HISTORY_CLOUD_SOURCE, scope, versionId: id(3) });
    f.state.reply = ok([detail(2)]);
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
    f.state.reply = ok([detail(3)]);
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3), expectedVersion: 2 }, f.client))
      .rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
  });
  it("rejects invalid detail inputs and duplicate detail responses", async () => {
    const f = fixture(ok([detail(), detail()]));
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: "' OR 1=1 --" }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INPUT_INVALID" });
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3), expectedVersion: 0 }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INPUT_INVALID" });
    expect(f.port.from).not.toHaveBeenCalled();
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
  });
  it.each([null, [], "en"])("rejects invalid language-summary shape %j", async (language_summary) => {
    const f = fixture(ok([detail(3, { language_summary })]));
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
  });
  it("requires nonempty user-edit content without trimming returned text", async () => {
    const f = fixture(ok([detail(3, { version_origin: "user_edit", parent_version_id: id(2),
      content_checksum_sha256: "A".repeat(64), plain_text: "  Exact\n" })]));
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client))
      .resolves.toMatchObject({ version: { plain_text: "  Exact\n", content_checksum_sha256: "a".repeat(64) } });
    f.state.reply = ok([detail(3, { version_origin: "user_edit", parent_version_id: id(2), content_checksum_sha256: "a".repeat(64), plain_text: " \n " })]);
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
  });
  it("enforces a UTF-8 byte budget, not a character count, and never truncates", async () => {
    const f = fixture(ok([detail(3, { plain_text: "\u00e9".repeat(MAX_HISTORY_CLOUD_TEXT_BYTES / 2) })]));
    const allowed = await fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client);
    expect(allowed.kind === "ready" && allowed.version.plain_text.length).toBe(MAX_HISTORY_CLOUD_TEXT_BYTES / 2);
    f.state.reply = ok([detail(3, { plain_text: "\u00e9".repeat(MAX_HISTORY_CLOUD_TEXT_BYTES / 2 + 1) })]);
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_LIMIT_EXCEEDED" });
  });
  it.each(["\ud800", "\udc00", "bad\0text"])("rejects non-roundtrippable text %#", async (plain_text) => {
    const f = fixture(ok([detail(3, { plain_text })]));
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_INVALID_RESPONSE" });
  });
  it("bounds language-summary size and nesting", async () => {
    const f = fixture(ok([detail(3, { language_summary: { huge: "a".repeat(65_537) } })]));
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_LIMIT_EXCEEDED" });
    let nested: object = {}; for (let index = 0; index < 20; index += 1) nested = { nested };
    f.state.reply = ok([detail(3, { language_summary: nested })]);
    await expect(fetchTranscriptHistoryVersion({ scope, versionId: id(3) }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_LIMIT_EXCEEDED" });
  });
  it.each([null, OTHER])("refuses absent/wrong user %s before SELECT", async (userId) => {
    const f = fixture(); f.state.userId = userId;
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
    expect(f.port.from).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0);
  });
  it("checks user again after the read even when no auth event was delivered", async () => {
    const f = fixture(); f.responses.push(() => { f.state.userId = OTHER; return ok([summary()]); });
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
  });
  it("irreversibly cancels an A -> B -> A request and consumes its late response", async () => {
    const f = fixture(); const hold = deferred<Reply>(); f.responses.push(() => hold.promise);
    const pending = expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
    await tick(); f.emit(OTHER); f.emit(USER); await pending;
    expect(f.queries[0].signal?.aborted).toBe(true); expect(f.listeners.size).toBe(0);
    hold.resolve(ok([summary()])); await tick();
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).resolves.toHaveProperty("versions");
  });
  it("handles synchronous auth invalidation during listener registration without starting a query", async () => {
    const f = fixture();
    f.port.auth.onAuthStateChange.mockImplementationOnce((listener) => {
      listener("SIGNED_OUT", null);
      return { data: { subscription: { unsubscribe: f.unsubscribed } } };
    });
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
    expect(f.port.from).not.toHaveBeenCalled(); expect(f.unsubscribed).toHaveBeenCalledTimes(1);
  });
  it("fails closed if final auth validation fails even after a successful SELECT", async () => {
    const f = fixture();
    f.port.auth.getSession.mockImplementationOnce(async () => ({ data: { session: { access_token: "unit-test-token", user: { id: USER } } as Session }, error: null }))
      .mockResolvedValueOnce({ data: { session: null }, error: { message: "PRIVATE auth failure" } });
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_AUTH_REQUIRED" });
    expect(f.port.from).toHaveBeenCalledTimes(1); expect(f.listeners.size).toBe(0);
  });
  it("keeps a request valid across same-user token refresh", async () => {
    const f = fixture(); const hold = deferred<Reply>(); f.responses.push(() => hold.promise);
    const pending = fetchTranscriptHistoryPage({ scope }, f.client); await tick(); f.emit(USER, "TOKEN_REFRESHED");
    hold.resolve(ok([summary()])); await expect(pending).resolves.toHaveProperty("versions");
  });
  it("does not start during deletion and checks deletion again after network", async () => {
    const f = fixture(); mockDeleting = true;
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_DELETION_PENDING" });
    expect(f.port.from).not.toHaveBeenCalled(); mockDeleting = false;
    f.responses.push(() => { mockDeleting = true; return ok([summary()]); });
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_DELETION_PENDING" });
  });
  it("rechecks caller lifetime and sanitizes a throwing lifetime callback", async () => {
    const f = fixture(); let active = true;
    f.responses.push(() => { active = false; return ok([summary()]); });
    await expect(fetchTranscriptHistoryPage({ scope, isContextActive: () => active }, f.client))
      .rejects.toMatchObject({ code: "HISTORY_CLOUD_CONTEXT_INACTIVE" });
    await expect(fetchTranscriptHistoryPage({ scope, isContextActive: () => { throw new Error("PRIVATE"); } }, f.client))
      .rejects.toMatchObject({ code: "HISTORY_CLOUD_CONTEXT_INACTIVE" });
  });
  it("cancels before auth or in flight without exposing an abort reason", async () => {
    const f = fixture(); const aborted = new AbortController(); aborted.abort("PRIVATE");
    await expect(fetchTranscriptHistoryPage({ scope, signal: aborted.signal }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_CANCELLED" });
    expect(f.port.auth.getSession).not.toHaveBeenCalled();
    const signal = new AbortController(); const hold = deferred<Reply>(); f.responses.push(() => hold.promise);
    const pending = expect(fetchTranscriptHistoryPage({ scope, signal: signal.signal }, f.client))
      .rejects.toMatchObject({ code: "HISTORY_CLOUD_CANCELLED" });
    await tick(); signal.abort("PRIVATE"); await pending;
    expect(f.queries[0].signal?.aborted).toBe(true); expect(f.listeners.size).toBe(0);
    hold.reject(new Error("PRIVATE LATE ERROR")); await tick();
  });
  it.each(["auth", "query", "final_auth"])("times out a stalled %s and cleans up without relying on transport abort", async (phase) => {
    jest.useFakeTimers(); const f = fixture(); const hold = deferred<Reply>();
    if (phase === "query") f.responses.push(() => hold.promise);
    else if (phase === "auth") f.port.auth.getSession.mockReturnValueOnce(new Promise(() => {}));
    else f.port.auth.getSession.mockImplementationOnce(async () => ({ data: { session: { access_token: "unit-test-token", user: { id: USER } } as Session }, error: null }))
      .mockReturnValueOnce(new Promise(() => {}));
    const pending = expect(fetchTranscriptHistoryPage({ scope, timeoutMs: 50 }, f.client))
      .rejects.toMatchObject({ code: "HISTORY_CLOUD_TIMEOUT", retryable: true });
    await tick(); jest.advanceTimersByTime(50); await pending;
    expect(f.listeners.size).toBe(0); expect(jest.getTimerCount()).toBe(0);
    hold.resolve(ok([summary()])); await tick();
  });
  it("clears the timeout and external listener after success", async () => {
    jest.useFakeTimers(); const f = fixture(); const signal = new AbortController();
    const remove = jest.spyOn(signal.signal, "removeEventListener");
    await fetchTranscriptHistoryPage({ scope, signal: signal.signal }, f.client);
    expect(jest.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("bounds concurrent logical requests per client without starting a third query", async () => {
    const f = fixture(); const hold1 = deferred<Reply>(); const hold2 = deferred<Reply>();
    f.responses.push(() => hold1.promise, () => hold2.promise);
    const first = fetchTranscriptHistoryPage({ scope }, f.client); const second = fetchTranscriptHistoryPage({ scope }, f.client);
    await tick(); await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_BUSY" });
    expect(f.port.from).toHaveBeenCalledTimes(2); hold1.resolve(ok([])); hold2.resolve(ok([])); await Promise.all([first, second]);
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).resolves.toHaveProperty("versions");
  });
  it.each([
    [401, "HISTORY_CLOUD_AUTH_REQUIRED", false], [403, "HISTORY_CLOUD_FORBIDDEN", false],
    [429, "HISTORY_CLOUD_RETRYABLE_QUERY", true], [503, "HISTORY_CLOUD_RETRYABLE_QUERY", true],
    [400, "HISTORY_CLOUD_QUERY_FAILED", false], [0, "HISTORY_CLOUD_NETWORK_UNAVAILABLE", true],
  ])("classifies HTTP %s without retaining SQL/text/token in error", async (status, code, retryable) => {
    const f = fixture({ data: null, status: status as number, error: { message: "PRIVATE token SQL transcript", details: "PRIVATE", hint: "PRIVATE" } });
    try { await fetchTranscriptHistoryPage({ scope }, f.client); throw new Error("Expected failure"); } catch (caught) {
      expect(caught).toBeInstanceOf(TranscriptHistoryCloudError); expect(caught).toMatchObject({ code, retryable });
      expect(String(caught)).not.toContain("PRIVATE"); expect(JSON.stringify(caught)).not.toContain("PRIVATE");
      expect(caught).not.toHaveProperty("cause");
    }
    expect(f.port.from).toHaveBeenCalledTimes(1); // No automatic retry loop.
  });
  it("classifies network rejections and statement timeout without leaking raw messages", async () => {
    const f = fixture(); f.responses.push(() => Promise.reject(new TypeError("Failed to fetch PRIVATE")));
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_NETWORK_UNAVAILABLE" });
    f.state.reply = { data: null, status: 500, error: { code: "57014", message: "PRIVATE" } };
    await expect(fetchTranscriptHistoryPage({ scope }, f.client)).rejects.toMatchObject({ code: "HISTORY_CLOUD_TIMEOUT" });
  });
  it("has no storage writer, provider/RPC call, notification, or activation import", () => {
    const source = readFileSync(resolve(process.cwd(), "src/services/transcription/history-client.ts"), "utf8").replace(/\s+/g, "");
    for (const forbidden of [".rpc(", ".insert(", ".upsert(", ".update(", ".from(\"transcript_versions\").delete(", ".storage", "functions.invoke",
      "sqlite/repository", "sqlite/schema", "notifyTranscription", "current-version-worker", "transcription_runs", "transcript_segments", "console."]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("3E.2A pinned Supabase SDK transport integration (fake fetch, no network)", () => {
  it("builds a real authenticated GET with keyset filters and forwards AbortSignal", async () => {
    const fetcher = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, status: 200, statusText: "OK", headers: { get: () => null }, text: async () => JSON.stringify([summary(7)]),
    } as unknown as Response));
    const client = createClient("https://history-unit-test.invalid", "public-unit-test-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
    });
    jest.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: { access_token: "unit-test-token", user: { id: USER } } as Session }, error: null });
    const unsubscribe = jest.fn();
    jest.spyOn(client.auth, "onAuthStateChange").mockReturnValue({ data: { subscription: { unsubscribe } } } as never);
    const result = await fetchTranscriptHistoryPage({ scope, cursor: cursor(), pageSize: 10 }, client);
    expect(result.versions[0].version).toBe(7); expect(fetcher).toHaveBeenCalledTimes(1);
    const [address, options] = fetcher.mock.calls[0]; const url = new URL(String(address));
    expect(options?.method).toBe("GET"); expect(options?.signal).toBeDefined();
    expect(url.pathname).toBe("/rest/v1/transcript_versions");
    expect(url.searchParams.get("workspace_id")).toBe(`eq.${WORKSPACE}`);
    expect(url.searchParams.get("session_id")).toBe(`eq.${SESSION}`);
    expect(url.searchParams.get("version_status")).toBe("eq.final");
    expect(url.searchParams.getAll("version")).toEqual(["lte.10", "lt.8"]);
    expect(url.searchParams.get("limit")).toBe("10"); expect(url.searchParams.get("select")).not.toContain("plain_text");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
