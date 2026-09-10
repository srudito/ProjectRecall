import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createLocalTranscriptHistoryReader,
  type TranscriptHistoryHydrationDependencies,
  type TranscriptHistoryReaderDependencies,
} from "@/src/services/transcription/history-read-model";
import {
  historyCacheResult,
  type HistoryCacheResult,
} from "@/src/services/transcription/history-cache-types";
import type {
  LocalTranscriptHistoryPage,
  LocalTranscriptHistoryVersion,
} from "@/src/services/transcription/history-types";

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: jest.fn(),
}));
jest.mock("@/src/services/sqlite/repository", () => ({
  listLocalTranscriptHistoryPage: jest.fn(),
  loadLocalTranscriptHistoryVersion: jest.fn(),
}));
jest.mock("@/src/services/transcription/history-cache-service", () => ({
  cacheTranscriptHistoryVersion: jest.fn(),
}));
jest.mock("@/src/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ initialized: false, user: null }),
    subscribe: jest.fn(() => () => {}),
  },
}));
jest.mock("@/src/services/account-deletion/state", () => ({
  isAccountDeletionLocallyPending: () => false,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const scope = {
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
};
const version = {
  id: VERSION_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  version: 4,
  version_origin: "user_edit" as const,
  version_status: "final" as const,
  parent_version_id: OTHER_ID,
  created_by: USER_ID,
  transcription_run_id: null,
  content_checksum_sha256: "a".repeat(64),
  created_at: "2026-09-10T00:00:00.000Z",
  is_current: false,
};
const ready = (): LocalTranscriptHistoryVersion => ({
  kind: "ready",
  availability: "local_cache_only",
  scope: { ...scope },
  version: { ...version },
  rawPlainText: "  exact historical text  ",
});
const missing = (): LocalTranscriptHistoryVersion => ({
  kind: "not_cached",
  availability: "local_cache_only",
  scope: { ...scope },
  versionId: VERSION_ID,
});
const emptyPage = (): LocalTranscriptHistoryPage => ({
  scope: { ...scope },
  availability: "local_cache_only",
  versions: [],
  windowUpperVersion: null,
  nextCursor: null,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

const readers: ReturnType<typeof createLocalTranscriptHistoryReader>[] = [];
const setup = () => {
  const state = {
    initialized: true,
    userId: USER_ID as string | null,
    active: true,
    deleting: false,
  };
  const listeners = new Set<() => void>();
  const loadVersion = jest.fn(async (): Promise<LocalTranscriptHistoryVersion> => ready());
  const cacheVersion = jest.fn(
    async (
      _input: Parameters<TranscriptHistoryHydrationDependencies["cacheVersion"]>[0],
    ): Promise<HistoryCacheResult> => historyCacheResult("committed"),
  );
  const listPage = jest.fn(async (): Promise<LocalTranscriptHistoryPage> => emptyPage());
  const reader = createLocalTranscriptHistoryReader(scope, {
    platform: "android",
    getAuth: () => ({ initialized: state.initialized, userId: state.userId }),
    subscribeAuth: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isDeletionPending: () => state.deleting,
    isContextActive: () => state.active,
    listPage: listPage as TranscriptHistoryReaderDependencies["listPage"],
    loadVersion: loadVersion as TranscriptHistoryReaderDependencies["loadVersion"],
    cacheVersion:
      cacheVersion as TranscriptHistoryHydrationDependencies["cacheVersion"],
  });
  readers.push(reader);
  const emitAuth = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return { state, reader, loadVersion, cacheVersion, listPage, emitAuth };
};

afterEach(() => {
  for (const reader of readers.splice(0)) reader.dispose();
});

describe("C2D on-demand transcript history hydration", () => {
  it("returns an exact local hit without starting cloud collection", async () => {
    const fixture = setup();

    const result = await fixture.reader.hydrateVersion({ versionId: VERSION_ID });

    expect(result).toEqual({ detail: ready(), cacheResult: null });
    expect(fixture.loadVersion).toHaveBeenCalledTimes(1);
    expect(fixture.cacheVersion).not.toHaveBeenCalled();
  });

  it("fills one missing version through the guarded cache service and re-reads locally", async () => {
    const fixture = setup();
    const committed: HistoryCacheResult = {
      ...historyCacheResult("committed"),
      insertedVersions: 2,
      insertedSegments: 5,
    };
    fixture.loadVersion
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(ready());
    fixture.cacheVersion.mockResolvedValueOnce(committed);
    const abort = new AbortController();

    const result = await fixture.reader.hydrateVersion({
      versionId: VERSION_ID,
      expectedVersion: 4,
      signal: abort.signal,
      timeoutMs: 1_234,
    });

    expect(result).toEqual({ detail: ready(), cacheResult: committed });
    expect(fixture.loadVersion).toHaveBeenCalledTimes(2);
    expect(fixture.cacheVersion).toHaveBeenCalledTimes(1);
    const request = fixture.cacheVersion.mock.calls[0][0];
    expect(request).toMatchObject({
      scope,
      versionId: VERSION_ID,
      expectedVersion: 4,
      signal: abort.signal,
      timeoutMs: 1_234,
      assertActive: expect.any(Function),
      isContextActive: expect.any(Function),
    });
    expect(request.isContextActive?.()).toBe(true);
    expect(() => request.assertActive()).not.toThrow();
  });

  it("re-reads once after a deferred result worker wins the same version", async () => {
    const fixture = setup();
    const deferredResult = historyCacheResult(
      "deferred_to_result_sync",
      "HISTORY_CACHE_RESULT_SYNC_OWNED",
    );
    fixture.loadVersion
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(ready());
    fixture.cacheVersion.mockResolvedValueOnce(deferredResult);

    await expect(
      fixture.reader.hydrateVersion({ versionId: VERSION_ID }),
    ).resolves.toEqual({ detail: ready(), cacheResult: deferredResult });
  });

  it("returns one retryable outcome without creating an automatic retry loop", async () => {
    const fixture = setup();
    const retryable = historyCacheResult(
      "retryable",
      "HISTORY_CACHE_FETCH_RETRYABLE",
    );
    fixture.loadVersion.mockResolvedValue(missing());
    fixture.cacheVersion.mockResolvedValueOnce(retryable);

    const result = await fixture.reader.hydrateVersion({ versionId: VERSION_ID });

    expect(result).toEqual({ detail: missing(), cacheResult: retryable });
    expect(fixture.cacheVersion).toHaveBeenCalledTimes(1);
    expect(fixture.loadVersion).toHaveBeenCalledTimes(2);
  });

  it("marks an acknowledged but unreadable cache result as indeterminate", async () => {
    const fixture = setup();
    const committed: HistoryCacheResult = {
      ...historyCacheResult("committed"),
      resources: "pending",
      resourceError: "HISTORY_CACHE_RESOURCES_PENDING",
      insertedVersions: 1,
      insertedSegments: 3,
    };
    fixture.loadVersion.mockResolvedValue(missing());
    fixture.cacheVersion.mockResolvedValueOnce(committed);

    const result = await fixture.reader.hydrateVersion({ versionId: VERSION_ID });

    expect(result.detail).toEqual(missing());
    expect(result.cacheResult).toEqual({
      ...committed,
      kind: "indeterminate",
      code: "HISTORY_CACHE_COMMIT_UNCONFIRMED",
    });
  });

  it("shares latest-detail-wins between local loads and hydration", async () => {
    const fixture = setup();
    const gate = deferred<HistoryCacheResult>();
    fixture.loadVersion.mockResolvedValue(missing());
    fixture.cacheVersion.mockReturnValueOnce(gate.promise);
    const hydration = expect(
      fixture.reader.hydrateVersion({ versionId: VERSION_ID }),
    ).rejects.toMatchObject({ code: "HISTORY_REQUEST_SUPERSEDED" });
    await flush();
    const admitted = fixture.cacheVersion.mock.calls[0][0];

    await fixture.reader.loadVersion({ versionId: OTHER_ID });

    expect(admitted.isContextActive?.()).toBe(false);
    expect(admitted.assertActive).toThrow(
      expect.objectContaining({ code: "HISTORY_REQUEST_SUPERSEDED" }),
    );
    gate.resolve(historyCacheResult("retryable", "HISTORY_CACHE_FETCH_RETRYABLE"));
    await hydration;
  });

  it("never revives an old hydration after account A to B to A", async () => {
    const fixture = setup();
    const gate = deferred<HistoryCacheResult>();
    fixture.loadVersion.mockResolvedValueOnce(missing());
    fixture.cacheVersion.mockReturnValueOnce(gate.promise);
    const hydration = expect(
      fixture.reader.hydrateVersion({ versionId: VERSION_ID }),
    ).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" });
    await flush();

    fixture.state.userId = OTHER_ID;
    fixture.emitAuth();
    fixture.state.userId = USER_ID;
    fixture.emitAuth();
    gate.resolve(historyCacheResult("committed"));

    await hydration;
    await expect(
      fixture.reader.hydrateVersion({ versionId: VERSION_ID }),
    ).rejects.toMatchObject({ code: "HISTORY_CONTEXT_INACTIVE" });
  });

  it("validates remote-phase controls before local or cloud work", async () => {
    const fixture = setup();

    await expect(
      fixture.reader.hydrateVersion({ versionId: "invalid" }),
    ).rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" });
    await expect(
      fixture.reader.hydrateVersion({ versionId: VERSION_ID, timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "HISTORY_INPUT_INVALID" });

    expect(fixture.loadVersion).not.toHaveBeenCalled();
    expect(fixture.cacheVersion).not.toHaveBeenCalled();
  });

  it("keeps hydration explicit and out of the coordinator and current transcript UI", () => {
    const read = (path: string): string =>
      readFileSync(resolve(process.cwd(), path), "utf8");
    const model = read("src/services/transcription/history-read-model.ts");
    const coordinator = read("src/services/sync/ProjectSyncCoordinator.tsx");
    const currentPanel = read("src/components/SessionTranscriptPanel.tsx");
    const hydrationStart = model.indexOf("hydrateVersion: async");
    const hydrationBody = model.slice(hydrationStart);

    expect(hydrationStart).toBeGreaterThan(0);
    expect(model).toContain("cacheTranscriptHistoryVersion");
    expect(hydrationBody).toContain("There is no automatic retry");
    expect(hydrationBody).not.toContain("setTimeout(");
    expect(coordinator).not.toContain("hydrateVersion");
    expect(coordinator).not.toContain("cacheTranscriptHistoryVersion");
    expect(currentPanel).not.toContain("hydrateVersion");
  });
});
