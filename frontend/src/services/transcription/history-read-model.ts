import { Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  listLocalTranscriptHistoryPage,
  loadLocalTranscriptHistoryVersion,
} from "@/src/services/sqlite/repository";
import { useAuthStore } from "@/src/stores/auth-store";

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

export interface TranscriptHistoryReaderDependencies {
  platform: string;
  getAuth: () => { initialized: boolean; userId: string | null };
  subscribeAuth: (listener: () => void) => () => void;
  isDeletionPending: () => boolean;
  isContextActive: () => boolean;
  listPage: typeof listLocalTranscriptHistoryPage;
  loadVersion: typeof loadLocalTranscriptHistoryVersion;
}
const defaults: TranscriptHistoryReaderDependencies = {
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
};

/**
 * Read-only, scope-owned reader. Call dispose() when its future viewer closes.
 * No network/connectivity checks, polling, editor registry or persistence writes.
 * Page and detail reads each use latest-request-wins independently. A cursor
 * fixes an upper version bound, not a database snapshot across separate calls;
 * cache backfills/cleanup may change local availability. Cloud coverage is unknown.
 */
export const createLocalTranscriptHistoryReader = (
  scopeInput: Readonly<TranscriptHistoryScope>,
  overrides: Partial<TranscriptHistoryReaderDependencies> = {},
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
        const guard = (): void => {
          assertActive();
          if (generation !== detailGeneration) throw new TranscriptHistoryError("HISTORY_REQUEST_SUPERSEDED");
        };
        const result = await deps.loadVersion({ scope, assertActive: guard, ...captured });
        guard();
        return result.kind === "ready"
          ? { ...result, scope: { ...result.scope }, version: { ...result.version } }
          : { ...result, scope: { ...result.scope } };
      } catch (error) {
        throw normalizeTranscriptHistoryError(error);
      }
    },
  };
};
