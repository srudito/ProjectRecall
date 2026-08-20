import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  listTranscriptCurrentVersionSyncTargets,
  persistCurrentTranscriptVersionSnapshot,
  type TranscriptCurrentVersionSyncTarget,
} from "@/src/services/sqlite/repository";
import { getSupabase } from "@/src/services/supabase/client";
import {
  fetchCurrentTranscriptVersionSnapshot,
  normalizeCurrentTranscriptVersionClientError,
  type CurrentTranscriptVersionClientError,
} from "@/src/services/transcription/current-version-client";
import type { CurrentTranscriptVersionSnapshot } from "@/src/services/transcription/result-types";
import { nextBackoffMs } from "@/src/services/upload-queue/backoff";
import { useAuthStore } from "@/src/stores/auth-store";

import { notifyTranscriptionSyncChanges } from "./transcription-sync-events";

export interface TranscriptCurrentVersionSyncRunResult {
  state:
    | "completed"
    | "offline"
    | "authentication_required"
    | "web_skipped";
  processed: number;
  synchronized: number;
  empty: number;
  retried: number;
  failed: number;
}

export interface TranscriptCurrentVersionWorkerDependencies {
  platform: string;
  getConnectionState: () => Promise<NetInfoState>;
  getAuthenticatedUserId: () => Promise<string | null>;
  isDeletionPending: () => boolean;
  listTargets: () => Promise<TranscriptCurrentVersionSyncTarget[]>;
  fetchRemoteSnapshot: (input: {
    target: TranscriptCurrentVersionSyncTarget;
    expectedUserId: string;
  }) => Promise<CurrentTranscriptVersionSnapshot>;
  persistSnapshot: (
    snapshot: Extract<CurrentTranscriptVersionSnapshot, { kind: "ready" }>,
  ) => Promise<void>;
  normalizeRemoteError: (
    error: unknown,
  ) => CurrentTranscriptVersionClientError;
  now: () => Date;
  random: () => number;
  maxTargetsPerPass: number;
  scheduleWake: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearWake: (handle: ReturnType<typeof setTimeout>) => void;
  notifyChanged: () => void;
}

const defaultDependencies: TranscriptCurrentVersionWorkerDependencies = {
  platform: Platform.OS,
  getConnectionState: () => NetInfo.fetch(),
  getAuthenticatedUserId: async () => {
    const storeUser = useAuthStore.getState().user?.id;
    if (storeUser) return storeUser;
    const client = getSupabase();
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) return null;
    return data.session?.user.id ?? null;
  },
  isDeletionPending: isAccountDeletionLocallyPending,
  listTargets: listTranscriptCurrentVersionSyncTargets,
  fetchRemoteSnapshot: ({ target, expectedUserId }) =>
    fetchCurrentTranscriptVersionSnapshot({
      sessionId: target.session_id,
      expectedWorkspaceId: target.workspace_id,
      expectedUserId,
    }),
  persistSnapshot: persistCurrentTranscriptVersionSnapshot,
  normalizeRemoteError: normalizeCurrentTranscriptVersionClientError,
  now: () => new Date(),
  random: Math.random,
  maxTargetsPerPass: 25,
  scheduleWake: (callback, delayMs) => setTimeout(callback, delayMs),
  clearWake: (handle) => clearTimeout(handle),
  notifyChanged: notifyTranscriptionSyncChanges,
};

const emptyResult = (
  state: TranscriptCurrentVersionSyncRunResult["state"],
): TranscriptCurrentVersionSyncRunResult => ({
  state,
  processed: 0,
  synchronized: 0,
  empty: 0,
  retried: 0,
  failed: 0,
});

const BATCH_CONTINUATION_DELAY_MS = 250;

const isOnline = (state: NetInfoState): boolean =>
  state.isConnected !== false && state.isInternetReachable !== false;

const targetKey = (target: TranscriptCurrentVersionSyncTarget): string =>
  `${target.workspace_id}:${target.session_id}`;

export const createTranscriptCurrentVersionWorker = (
  overrides: Partial<TranscriptCurrentVersionWorkerDependencies> = {},
) => {
  const dependencies: TranscriptCurrentVersionWorkerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  const priorityTargets = new Map<string, TranscriptCurrentVersionSyncTarget>();
  const pendingTargets = new Map<string, TranscriptCurrentVersionSyncTarget>();
  const retryAttempts = new Map<string, number>();
  let fullScanRequested = false;
  let activeRun: Promise<TranscriptCurrentVersionSyncRunResult> | null = null;
  let scheduledWake: ReturnType<typeof setTimeout> | null = null;
  let rerunRequested = false;

  const enqueue = (
    target: TranscriptCurrentVersionSyncTarget,
    priority = false,
  ): void => {
    const key = targetKey(target);
    if (priority) {
      pendingTargets.delete(key);
      priorityTargets.set(key, target);
      return;
    }
    if (!priorityTargets.has(key)) pendingTargets.set(key, target);
  };

  const hasPendingTargets = (): boolean =>
    priorityTargets.size > 0 || pendingTargets.size > 0;

  const takeNextTarget = (): {
    target: TranscriptCurrentVersionSyncTarget;
    priority: boolean;
  } | null => {
    const priorityEntry = priorityTargets.entries().next();
    if (!priorityEntry.done) {
      const [key, target] = priorityEntry.value;
      priorityTargets.delete(key);
      return { target, priority: true };
    }
    const entry = pendingTargets.entries().next();
    if (entry.done) return null;
    const [key, target] = entry.value;
    pendingTargets.delete(key);
    return { target, priority: false };
  };

  const clearScheduledWake = (): void => {
    if (scheduledWake === null) return;
    dependencies.clearWake(scheduledWake);
    scheduledWake = null;
  };

  const scheduleContinuation = (delayMs: number): void => {
    if (scheduledWake !== null) return;
    scheduledWake = dependencies.scheduleWake(() => {
      scheduledWake = null;
      void startRun().catch(() => {
        // The next lifecycle/reconnect wake will retry. Never surface an
        // unhandled cache-refresh rejection into the UI.
      });
    }, delayMs);
  };

  const execute = async (): Promise<{
    result: TranscriptCurrentVersionSyncRunResult;
    continuationDelayMs: number | null;
    allowContinuation: boolean;
  }> => {
    if (dependencies.isDeletionPending()) {
      return {
        result: emptyResult("completed"),
        continuationDelayMs: null,
        allowContinuation: false,
      };
    }

    if (dependencies.platform === "web") {
      return {
        result: emptyResult("web_skipped"),
        continuationDelayMs: null,
        allowContinuation: false,
      };
    }

    const connection = await dependencies.getConnectionState();
    if (!isOnline(connection)) {
      return {
        result: emptyResult("offline"),
        continuationDelayMs: null,
        allowContinuation: false,
      };
    }

    const userId = await dependencies.getAuthenticatedUserId();
    if (!userId) {
      return {
        result: emptyResult("authentication_required"),
        continuationDelayMs: null,
        allowContinuation: false,
      };
    }

    if (fullScanRequested) {
      // Consume only the request that started this discovery pass. A second
      // full-scan wake arriving while listTargets() is in flight must remain
      // visible so sessions added concurrently are discovered in a follow-up
      // pass instead of being silently lost.
      fullScanRequested = false;
      try {
        const targets = await dependencies.listTargets();
        for (const target of targets) enqueue(target, false);
      } catch (error) {
        fullScanRequested = true;
        throw error;
      }
    }

    const result = emptyResult("completed");
    let continuationDelayMs: number | null = null;
    let allowContinuation = true;

    for (let index = 0; index < dependencies.maxTargetsPerPass; index += 1) {
      if (dependencies.isDeletionPending()) {
        allowContinuation = false;
        break;
      }

      const next = takeNextTarget();
      if (!next) break;
      const { target, priority } = next;
      const key = targetKey(target);
      result.processed += 1;

      let snapshot: CurrentTranscriptVersionSnapshot;
      try {
        snapshot = await dependencies.fetchRemoteSnapshot({
          target,
          expectedUserId: userId,
        });
      } catch (error) {
        const normalized = dependencies.normalizeRemoteError(error);
        if (
          normalized.code === "TRANSCRIPT_CURRENT_AUTHENTICATION_REQUIRED"
        ) {
          enqueue(target, priority);
          result.state = "authentication_required";
          allowContinuation = false;
          break;
        }
        if (normalized.retryable) {
          const attempt = (retryAttempts.get(key) ?? 0) + 1;
          retryAttempts.set(key, attempt);
          enqueue(target, priority);
          result.retried += 1;
          continuationDelayMs = nextBackoffMs(Math.min(attempt, 5), {
            random: dependencies.random,
          });
          break;
        }
        retryAttempts.delete(key);
        result.failed += 1;
        continue;
      }

      retryAttempts.delete(key);
      if (snapshot.kind === "empty") {
        // Remote absence must never erase the offline cache. Session deletion
        // and access-revocation cleanup are handled by their existing flows.
        result.empty += 1;
        continue;
      }

      // Account deletion can start while the authenticated read is in flight.
      // Never repopulate local private data after quiescence begins.
      if (dependencies.isDeletionPending()) {
        enqueue(target, priority);
        allowContinuation = false;
        break;
      }

      try {
        await dependencies.persistSnapshot(snapshot);
        result.synchronized += 1;
      } catch {
        // Persistence is fail-closed and transactional. A later full scan may
        // retry without corrupting the existing offline transcript cache.
        result.failed += 1;
      }
    }

    if (result.synchronized > 0) dependencies.notifyChanged();

    return { result, continuationDelayMs, allowContinuation };
  };

  const startRun = (): Promise<TranscriptCurrentVersionSyncRunResult> => {
    if (activeRun) return activeRun;

    const run = execute()
      .then(({ result, continuationDelayMs, allowContinuation }) => {
        if (
          allowContinuation &&
          (fullScanRequested || hasPendingTargets())
        ) {
          scheduleContinuation(
            continuationDelayMs ?? BATCH_CONTINUATION_DELAY_MS,
          );
        }
        return result;
      })
      .finally(() => {
        activeRun = null;
        if (rerunRequested) {
          rerunRequested = false;
          if (
            dependencies.platform !== "web" &&
            !dependencies.isDeletionPending() &&
            scheduledWake === null &&
            (fullScanRequested || hasPendingTargets())
          ) {
            scheduleContinuation(0);
          }
        }
      });
    activeRun = run;
    return run;
  };

  const run = (
    target?: TranscriptCurrentVersionSyncTarget,
  ): Promise<TranscriptCurrentVersionSyncRunResult> => {
    if (target) enqueue(target, true);
    else fullScanRequested = true;
    clearScheduledWake();

    if (activeRun) {
      rerunRequested = true;
      return activeRun;
    }
    return startRun();
  };

  return {
    run,
    waitForIdle: async (): Promise<void> => {
      const currentRun = activeRun;
      if (!currentRun) return;
      await currentRun.then(() => undefined, () => undefined);
    },
    dispose: (): void => {
      clearScheduledWake();
      priorityTargets.clear();
      pendingTargets.clear();
      retryAttempts.clear();
      fullScanRequested = false;
      rerunRequested = false;
    },
  };
};

const defaultWorker = createTranscriptCurrentVersionWorker();

export const runTranscriptCurrentVersionWorker = (
  target?: TranscriptCurrentVersionSyncTarget,
): Promise<TranscriptCurrentVersionSyncRunResult> => defaultWorker.run(target);

export const waitForTranscriptCurrentVersionSyncIdle = (): Promise<void> =>
  defaultWorker.waitForIdle();

export const requestTranscriptCurrentVersionSync = (
  target?: TranscriptCurrentVersionSyncTarget,
): void => {
  void runTranscriptCurrentVersionWorker(target).catch(() => {
    // This is a reconstructible cache pull. Existing local data stays valid and
    // lifecycle/reconnect wakes will try again.
  });
};
