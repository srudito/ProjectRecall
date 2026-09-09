import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as Crypto from "expo-crypto";

import { createTranscriptHistoryCacheService } from "@/src/services/transcription/history-cache-service";
import { consumeHistoryCacheCommand, historyCacheError, historyCacheResult,
  type PreparedHistoryCacheCommand } from "@/src/services/transcription/history-cache-types";
import { HISTORY_BUNDLE_SOURCE, type TranscriptHistoryBundleResult } from "@/src/services/transcription/history-bundle-types";
import type { TranscriptHistoryCloudVersion, TranscriptHistoryCloudVersionRequest } from "@/src/services/transcription/history-cloud-types";
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const fixture = () => {
  const auth = { userId: USER as string | null, initialized: true };
  const state = { deleting: false, active: true };
  const listeners = new Set<() => void>();
  const collect = jest.fn(async (_input: TranscriptHistoryCloudVersionRequest): Promise<TranscriptHistoryBundleResult> => ready());
  const persist = jest.fn(async (command: PreparedHistoryCacheCommand) => {
    const data = consumeHistoryCacheCommand(command); data.assertActive(); return historyCacheResult("committed");
  });
  const waitForWritesIdle = jest.fn(async (_sessionId?: string): Promise<void> => undefined);
  const service = createTranscriptHistoryCacheService({ collect, persist, waitForWritesIdle,
    identity: () => auth, deletionPending: () => state.deleting,
    subscribeIdentity: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  const request = { scope: { ...scope }, versionId: id(2), assertActive: () => { if (!state.active) throw new Error("PRIVATE LIFETIME"); } };
  const emit = (userId: string | null) => { auth.userId = userId; for (const listener of [...listeners]) listener(); };
  return { auth, state, listeners, collect, persist, waitForWritesIdle, service, request, emit };
};
beforeEach(() => { digest.mockReset(); digest.mockImplementation(async (_algorithm, text) => hash(text)); });
afterEach(() => { jest.useRealTimers(); });

describe("history cache service lifetime without runtime activation", () => {
  it("does nothing until explicitly called and sends only the prepared command to persistence", async () => {
    const f = fixture(); expect(f.collect).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
    expect(await f.service.cache(f.request)).toMatchObject({ kind: "committed" });
    expect(f.collect).toHaveBeenCalledTimes(1); expect(f.persist).toHaveBeenCalledTimes(1);
    expect(Object.keys(f.persist.mock.calls[0][0])).toEqual([]); expect(f.listeners.size).toBe(0);
  });
  it.each([null, {}, { scope, versionId: "bad", assertActive: () => {} },
    { scope, versionId: id(2), assertActive: false }, { scope, versionId: id(2), assertActive: () => {}, timeoutMs: 0 }])(
    "rejects invalid input before collection: %j", async (input) => {
      const f = fixture(); expect(await f.service.cache(input as never)).toMatchObject({ kind: "rejected", code: "HISTORY_CACHE_INPUT_INVALID" });
      expect(f.collect).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
    });
  it.each(["anonymous", "wrong-account", "uninitialized", "deletion", "caller"])("refuses inactive admission: %s", async (kind) => {
    const f = fixture();
    if (kind === "anonymous") f.auth.userId = null;
    if (kind === "wrong-account") f.auth.userId = OTHER;
    if (kind === "uninitialized") f.auth.initialized = false;
    if (kind === "deletion") f.state.deleting = true;
    if (kind === "caller") f.state.active = false;
    expect((await f.service.cache(f.request)).kind).toBe("rejected"); expect(f.collect).not.toHaveBeenCalled();
  });
  it("captures request scope and expected version before awaits", async () => {
    const f = fixture(); const gate = deferred<TranscriptHistoryBundleResult>(); f.collect.mockReturnValue(gate.promise);
    const input = { ...f.request, scope: { ...scope }, expectedVersion: 2 };
    const pending = f.service.cache(input); input.scope.userId = OTHER; input.versionId = OTHER; input.expectedVersion = 3;
    gate.resolve(ready()); expect((await pending).kind).toBe("committed");
    expect(f.collect.mock.calls[0][0]).toMatchObject({ scope, versionId: id(2), expectedVersion: 2 });
  });
  it.each(["not_ready", "unavailable"] as const)("does not persist a %s bundle", async (kind) => {
    const f = fixture(); f.collect.mockResolvedValue({ ...ready(), kind,
      reason: kind === "not_ready" ? "cleanup_pending" : "nullable_run_provenance" } as never);
    expect((await f.service.cache(f.request)).kind).toBe(kind); expect(f.persist).not.toHaveBeenCalled();
  });
  it("rejects mismatched selected scope or version even from an injected collector", async () => {
    const f = fixture(); f.collect.mockResolvedValue({ ...ready(), selectedVersionId: OTHER });
    expect(await f.service.cache(f.request)).toMatchObject({ kind: "rejected", code: "HISTORY_CACHE_BUNDLE_INVALID" });
    f.collect.mockResolvedValue(ready());
    expect(await f.service.cache({ ...f.request, expectedVersion: 99 })).toMatchObject({ kind: "rejected", code: "HISTORY_CACHE_BUNDLE_INVALID" });
    expect(f.persist).not.toHaveBeenCalled();
  });
  it.each(["switch-back", "delete", "cancel", "invalidate", "caller"])("refuses stale completion after %s", async (kind) => {
    const f = fixture(); const gate = deferred<TranscriptHistoryBundleResult>(); const abort = new AbortController();
    f.collect.mockReturnValue(gate.promise); const pending = f.service.cache({ ...f.request, signal: abort.signal });
    if (kind === "switch-back") { f.emit(OTHER); f.emit(USER); }
    if (kind === "delete") f.state.deleting = true;
    if (kind === "cancel") abort.abort();
    if (kind === "invalidate") f.service.invalidate();
    if (kind === "caller") f.state.active = false;
    gate.resolve(ready()); expect((await pending).kind).toBe("rejected"); expect(f.persist).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0); await f.service.waitForIdle();
  });
  it("does not report idle while a cancelled collector still has a continuation", async () => {
    const f = fixture(); const gate = deferred<TranscriptHistoryBundleResult>(); f.collect.mockReturnValue(gate.promise);
    const pending = f.service.cache(f.request); f.service.invalidate();
    let idle = false; const drain = f.service.waitForIdle().then(() => { idle = true; }); await tick(); expect(idle).toBe(false);
    gate.resolve(ready()); await pending; await drain; expect(idle).toBe(true); expect(f.persist).not.toHaveBeenCalled();
  });
  it("blocks session admission until every pause lease is released and does not revive old work", async () => {
    const f = fixture(); const first = f.service.pauseSession(SESSION); const second = f.service.pauseSession(SESSION);
    first(); first(); expect(await f.service.cache(f.request)).toMatchObject({ code: "HISTORY_CACHE_DELETION_PENDING" });
    second(); expect((await f.service.cache(f.request)).kind).toBe("committed");
  });
  it("does not block another session when one session is paused", async () => {
    const f = fixture(); const release = f.service.pauseSession(OTHER);
    expect((await f.service.cache(f.request)).kind).toBe("committed"); release();
  });
  it("bounds active requests and has no unbounded retry/download queue", async () => {
    const f = fixture(); const gate = deferred<TranscriptHistoryBundleResult>(); f.collect.mockReturnValue(gate.promise);
    const first = f.service.cache(f.request); const second = f.service.cache(f.request);
    expect(await f.service.cache(f.request)).toMatchObject({ kind: "retryable", code: "HISTORY_CACHE_BUSY" });
    gate.resolve(ready()); await first; await second; expect(f.collect).toHaveBeenCalledTimes(2);
  });
  it("times out cooperatively without returning a fictitious rollback during COMMIT", async () => {
    jest.useFakeTimers(); const f = fixture(); const entered = deferred<void>(); const commit = deferred<void>();
    f.persist.mockImplementation(async (command) => {
      consumeHistoryCacheCommand(command).assertActive(); entered.resolve(); await commit.promise; return historyCacheResult("committed");
    });
    const pending = f.service.cache({ ...f.request, timeoutMs: 50 }); await entered.promise;
    let settled = false; void pending.then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(50); expect(settled).toBe(false);
    commit.resolve(); expect((await pending).kind).toBe("committed");
  });
  it("does not start persistence if the deadline expired during collection", async () => {
    jest.useFakeTimers(); const f = fixture(); const gate = deferred<TranscriptHistoryBundleResult>(); f.collect.mockReturnValue(gate.promise);
    const pending = f.service.cache({ ...f.request, timeoutMs: 50 }); await jest.advanceTimersByTimeAsync(50);
    expect(f.collect.mock.calls[0][0].signal!.aborted).toBe(true);
    gate.resolve(ready()); expect(await pending).toMatchObject({ kind: "rejected", code: "HISTORY_CACHE_TIMEOUT" });
    expect(f.persist).not.toHaveBeenCalled();
  });
  it("does not overwrite an acknowledged commit when auth changes during final native work", async () => {
    const f = fixture(); const entered = deferred<void>(); const end = deferred<void>();
    f.persist.mockImplementation(async (command) => {
      consumeHistoryCacheCommand(command).assertActive(); entered.resolve(); await end.promise;
      return { ...historyCacheResult("committed"), resources: "pending", resourceError: "HISTORY_CACHE_RESOURCES_PENDING" };
    });
    const pending = f.service.cache(f.request); await entered.promise; f.emit(OTHER); end.resolve();
    expect(await pending).toMatchObject({ kind: "committed", resources: "pending" });
    f.waitForWritesIdle.mockRejectedValueOnce(historyCacheError("HISTORY_CACHE_RESOURCES_PENDING"));
    await expect(f.service.waitForIdle()).rejects.toMatchObject({ code: "HISTORY_CACHE_RESOURCES_PENDING" });
  });
  it("sanitizes arbitrary upstream exceptions without leaking raw transcript or credentials", async () => {
    const f = fixture(); f.collect.mockRejectedValue(new Error("PRIVATE TOKEN/TEXT"));
    const result = await f.service.cache(f.request); expect(result).toMatchObject({ kind: "rejected", code: "HISTORY_CACHE_FETCH_FAILED" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(f.persist).not.toHaveBeenCalled();
  });
});

describe("deletion coordination and writer boundaries", () => {
  const source = (file: string) => readFileSync(path.join(__dirname, "..", "src", "services", file), "utf8");
  it("drains history before taking the deletion transaction turn, retaining session pauses across failure", () => {
    const repository = source("sqlite/repository.ts");
    for (const [name, helper] of [["atomicPrepareSessionDeletion", "prepareSessionDeletionWithReadsPaused"],
      ["hardDeleteLocalSessionData", "hardDeleteLocalSessionDataWithReadsPaused"]]) {
      const start = repository.indexOf(`export const ${name} =`);
      const body = repository.slice(start, repository.indexOf(`const ${helper} =`, start));
      expect(body.indexOf("pauseSessionTranscriptHistoryCache(")).toBeLessThan(body.indexOf("await waitForTranscriptHistoryCacheIdle("));
      expect(body.indexOf("await waitForTranscriptHistoryCacheIdle(")).toBeLessThan(body.indexOf(`await ${helper}(`));
      expect(body).toContain("finally { releaseReads(); }");
      expect(body).toContain("finally { releaseHistory(); }");
      expect(body).not.toContain("runSerializedLocalTransaction(");
    }
  });
  it("never changes provider execution, current ownership, draft, outbox, or request diagnostics", () => {
    const sql = source("sqlite/history-cache.ts");
    for (const token of [".rpc(", ".storage", "functions.invoke", "console.", "is_current = 1", "DELETE FROM", "ON CONFLICT"]) {
      expect(sql).not.toContain(token);
    }
    expect(sql).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) local_(?:transcription_request_queue|transcript_edit|processing_jobs|transcription_runs|sessions)/);
    expect(sql).not.toContain("digestStringAsync");
  });
});
