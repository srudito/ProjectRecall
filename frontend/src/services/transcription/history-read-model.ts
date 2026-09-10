import { Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  listLocalTranscriptHistoryPage,
  loadLocalTranscriptHistoryVersion,
} from "@/src/services/sqlite/repository";
import { useAuthStore } from "@/src/stores/auth-store";

import { cacheTranscriptHistoryVersion } from "./history-cache-service";
import type { HistoryCacheResult } from "./history-cache-types";
import { captureHistoryCloudVersion } from "./history-cloud-types";
import {
  normalizeTranscriptHistoryError,
  normalizeTranscriptHistoryPageRequest,
  normalizeTranscriptHistoryScope,
  normalizeTranscriptHistoryVersionRequest,
  TranscriptHistoryError,
  type LocalTranscriptHistoryPage,
  type LocalTranscriptHistoryVersion,
  type TranscriptHistoryPageRequest,
  type TranscriptHistoryScope,
  type TranscriptHistoryVersionRequest,
} from "./history-types";

export interface TranscriptHistoryHydrationRequest
  extends TranscriptHistoryVersionRequest {
  /** Applies only to the remote cache-fill phase; a local hit needs no network. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TranscriptHistoryHydrationResult {
  /** Exact local result after zero or one cache attempt. */
  detail: LocalTranscriptHistoryVersion;
  /** null means the selected Full Text was already available locally. */
  cacheResult: HistoryCacheResult | null;
}

export interface TranscriptHistoryReaderDependencies {
  platform: string;
  getAuth: () => { initialized: boolean; userId: string | null };
  subscribeAuth: (listener: () => void) => () => void;
  isDeletionPending: () => boolean;
  isContextActive: () => boolean;
  listPage: typeof listLocalTranscriptHistoryPage;
  loadVersion: typeof loadLocalTranscriptHistoryVersion;
}
export interface TranscriptHistoryHydrationDependencies {
  cacheVersion: typeof cacheTranscriptHistoryVersion;
}
const defaults: TranscriptHistoryReaderDependencies &
  TranscriptHistoryHydrationDependencies = {
  platform: Platform.OS,
  getAuth: () => {
    const auth = useAuthStore.getState();
    return { initialized: auth.initialized, userId: auth.user?.id ?? null };
  },
  subscribeAuth: (listener) => useAuthStore.subscribe(listener),
  isDeletionPending: isAccountDeletionLocallyPending,
  isContextActive: () => true,
  listPage: listLocalTranscriptHistoryPage,
  loadVersion: loadLocalTranscriptHistoryVersion,
  cacheVersion: cacheTranscriptHistoryVersion,
};

/**
 * Scope-owned reader. Call dispose() when its future viewer closes. Page and
 * loadVersion remain local-only; hydrateVersion is an explicit read-through
 * cache fill and never runs from construction, paging, polling, or coordinator.
 * Page and detail reads each use latest-request-wins independently. A cursor
 * fixes an upper version bound, not a database snapshot across separate calls;
 * cache backfills/cleanup may change local availability. Cloud coverage is unknown.
 */
export const createLocalTranscriptHistoryReader = (
  scopeInput: Readonly<TranscriptHistoryScope>,
  overrides: Partial<
    TranscriptHistoryReaderDependencies & TranscriptHistoryHydrationDependencies
  > = {},
) => {
  const scope = Object.freeze(normalizeTranscriptHistoryScope(scopeInput));
  const deps = { ...defaults, ...overrides };
  let alive = true;
  let pageGeneration = 0;
  let detailGeneration = 0;
  let unsubscribe: (() => void) | null = null;
  const dispose = (): void => {
    alive = false;
    const stop = unsubscribe;
    unsubscribe = null;
    try { stop?.(); } catch { /* Local invalidation still prevents result delivery. */ }
  };
  const assertActive = (): void => {
    if (deps.platform !== "android" && deps.platform !== "ios") throw new TranscriptHistoryError("HISTORY_NATIVE_ONLY");
    if (!alive || !deps.isContextActive()) {
      dispose();
      throw new TranscriptHistoryError("HISTORY_CONTEXT_INACTIVE");
    }
    const auth = deps.getAuth();
    if (!auth.initialized || auth.userId?.toLowerCase() !== scope.userId) {
      dispose();
      throw new TranscriptHistoryError("HISTORY_AUTH_REQUIRED");
    }
    if (deps.isDeletionPending()) {
      dispose();
      throw new TranscriptHistoryError("HISTORY_DELETION_PENDING");
    }
  };
  try {
    assertActive();
    unsubscribe = deps.subscribeAuth(() => {
      // Irreversible for this reader: A -> B -> A never revives A's old requests.
      try { assertActive(); } catch { dispose(); }
    });
    assertActive();
  } catch (error) {
    dispose();
    throw normalizeTranscriptHistoryError(error);
  }

  const detailGuard = (generation: number): (() => void) => () => {
    assertActive();
    if (generation !== detailGeneration) {
      throw new TranscriptHistoryError("HISTORY_REQUEST_SUPERSEDED");
    }
  };
  const cloneDetail = (
    result: LocalTranscriptHistoryVersion,
  ): LocalTranscriptHistoryVersion =>
    result.kind === "ready"
      ? { ...result, scope: { ...result.scope }, version: { ...result.version } }
      : { ...result, scope: { ...result.scope } };
  const readDetail = async (
    captured: TranscriptHistoryVersionRequest,
    guard: () => void,
  ): Promise<LocalTranscriptHistoryVersion> => {
    const result = await deps.loadVersion({ scope, assertActive: guard, ...captured });
    guard();
    return cloneDetail(result);
  };

  return {
    scope,
    dispose,
    listPage: async (input: TranscriptHistoryPageRequest = {}): Promise<LocalTranscriptHistoryPage> => {
      try {
        assertActive();
        const captured = normalizeTranscriptHistoryPageRequest(scope, input);
        const generation = ++pageGeneration;
        const guard = (): void => {
          assertActive();
          if (generation !== pageGeneration) throw new TranscriptHistoryError("HISTORY_REQUEST_SUPERSEDED");
        };
        const page = await deps.listPage({ scope, assertActive: guard, ...captured });
        guard();
        return { ...page, scope: { ...page.scope }, versions: page.versions.map((row) => ({ ...row })),
          nextCursor: page.nextCursor ? { ...page.nextCursor, scope: { ...page.nextCursor.scope } } : null };
      } catch (error) {
        throw normalizeTranscriptHistoryError(error);
      }
    },
    loadVersion: async (input: TranscriptHistoryVersionRequest): Promise<LocalTranscriptHistoryVersion> => {
      try {
        assertActive();
        const captured = normalizeTranscriptHistoryVersionRequest(input);
        const generation = ++detailGeneration;
        return await readDetail(captured, detailGuard(generation));
      } catch (error) {
        throw normalizeTranscriptHistoryError(error);
      }
    },
    hydrateVersion: async (
      input: TranscriptHistoryHydrationRequest,
    ): Promise<TranscriptHistoryHydrationResult> => {
      try {
        assertActive();
        const captured = normalizeTranscriptHistoryVersionRequest(input);
        let cloudRequest: ReturnType<typeof captureHistoryCloudVersion>;
        try {
          cloudRequest = captureHistoryCloudVersion({
            scope,
            ...captured,
            signal: input.signal,
            timeoutMs: input.timeoutMs,
          });
        } catch {
          throw new TranscriptHistoryError("HISTORY_INPUT_INVALID");
        }

        const generation = ++detailGeneration;
        const guard = detailGuard(generation);
        const local = await readDetail(captured, guard);
        if (local.kind === "ready") {
          return { detail: local, cacheResult: null };
        }

        const cacheResult = await deps.cacheVersion({
          scope: cloudRequest.scope,
          versionId: cloudRequest.versionId,
          expectedVersion: cloudRequest.expectedVersion,
          signal: cloudRequest.signal,
          timeoutMs: cloudRequest.timeoutMs,
          isContextActive: () => {
            try {
              guard();
              return true;
            } catch {
              return false;
            }
          },
          assertActive: guard,
        });
        guard();

        // One exact re-read observes either this acknowledged cache commit or a
        // concurrent result/current-version writer. There is no automatic retry.
        const refreshed = await readDetail(captured, guard);
        let deliveredCacheResult: HistoryCacheResult = { ...cacheResult };
        if (
          refreshed.kind === "not_cached" &&
          (cacheResult.kind === "committed" || cacheResult.kind === "unchanged")
        ) {
          deliveredCacheResult = {
            ...cacheResult,
            kind: "indeterminate",
            code: "HISTORY_CACHE_COMMIT_UNCONFIRMED",
          };
        }
        return { detail: refreshed, cacheResult: deliveredCacheResult };
      } catch (error) {
        throw normalizeTranscriptHistoryError(error);
      }
    },
  };
};
