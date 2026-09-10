import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  prepareGuardedTranscriptHistoryRestoreDraft,
  type TranscriptEditDraftRow,
} from "@/src/services/sqlite/repository";
import { notifyTranscriptionSyncChanges } from "@/src/services/sync/transcription-sync-events";
import { useAuthStore } from "@/src/stores/auth-store";

import { transcriptEditorUuid } from "./editor-types";
import {
  captureTranscriptHistoryRestoreRequest,
  normalizeTranscriptHistoryRestoreFailure,
  TranscriptHistoryRestoreError,
  type TranscriptHistoryRestoreDraftResult,
  type TranscriptHistoryRestoreRequest,
} from "./history-restore-types";

export interface TranscriptHistoryRestoreServiceDependencies {
  platform: string;
  getAuth: () => { initialized: boolean; userId: string | null };
  subscribeAuth: (listener: () => void) => () => void;
  isDeletionPending: () => boolean;
  prepare: typeof prepareGuardedTranscriptHistoryRestoreDraft;
  notifyChanged: () => void;
}

const defaults: TranscriptHistoryRestoreServiceDependencies = {
  platform: Platform.OS,
  getAuth: () => {
    const auth = useAuthStore.getState();
    return { initialized: auth.initialized, userId: auth.user?.id ?? null };
  },
  subscribeAuth: (listener) => useAuthStore.subscribe(listener),
  isDeletionPending: isAccountDeletionLocallyPending,
  prepare: prepareGuardedTranscriptHistoryRestoreDraft,
  notifyChanged: notifyTranscriptionSyncChanges,
};

const verifySourceChecksum = async (
  request: ReturnType<typeof captureTranscriptHistoryRestoreRequest>,
  assertActive: () => void,
): Promise<void> => {
  const expected = request.command.sourceContentChecksumSha256;
  if (expected === null) return;
  assertActive();
  let digest: string;
  try {
    digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      request.command.sourcePlainText,
    );
  } catch {
    assertActive();
    throw new TranscriptHistoryRestoreError(
      "HISTORY_RESTORE_HASH_UNAVAILABLE",
    );
  }
  assertActive();
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
    throw new TranscriptHistoryRestoreError(
      "HISTORY_RESTORE_HASH_UNAVAILABLE",
    );
  }
  if (digest.toLowerCase() !== expected) {
    throw new TranscriptHistoryRestoreError(
      "HISTORY_RESTORE_CHECKSUM_MISMATCH",
    );
  }
};

const detachResult = (
  value: TranscriptHistoryRestoreDraftResult,
  request: ReturnType<typeof captureTranscriptHistoryRestoreRequest>,
): TranscriptHistoryRestoreDraftResult => {
  if (
    !value ||
    value.kind !== "draft_created" ||
    value.sourceVersionId !== request.command.sourceVersionId
  ) {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_WRITE_FAILED");
  }
  let baseVersionId: string;
  try {
    baseVersionId = transcriptEditorUuid(value.baseVersionId);
  } catch {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_WRITE_FAILED");
  }
  const draft = value.draft as TranscriptEditDraftRow | null;
  if (
    !draft ||
    baseVersionId === request.command.sourceVersionId ||
    draft.user_id !== request.scope.userId ||
    draft.workspace_id !== request.scope.workspaceId ||
    draft.session_id !== request.scope.sessionId ||
    draft.base_version_id !== baseVersionId ||
    draft.plain_text !== request.command.sourcePlainText ||
    typeof draft.created_at !== "string" ||
    typeof draft.updated_at !== "string" ||
    !Number.isFinite(Date.parse(draft.created_at)) ||
    !Number.isFinite(Date.parse(draft.updated_at))
  ) {
    throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_WRITE_FAILED");
  }
  return {
    kind: "draft_created",
    sourceVersionId: request.command.sourceVersionId,
    baseVersionId,
    draft: { ...draft },
  };
};

/**
 * One explicit local operation. It never promotes a historical row, calls an
 * RPC, starts synchronization, or overwrites a pre-existing draft. The draft
 * remains based on the current version so the ordinary Save path creates a new
 * immutable user-edit version with its existing compare-and-swap contract.
 */
export const createTranscriptHistoryRestoreService = (
  overrides: Partial<TranscriptHistoryRestoreServiceDependencies> = {},
) => {
  const dependencies = { ...defaults, ...overrides };

  const prepareDraft = async (
    input: TranscriptHistoryRestoreRequest,
  ): Promise<TranscriptHistoryRestoreDraftResult> => {
    let request: ReturnType<typeof captureTranscriptHistoryRestoreRequest>;
    try {
      request = captureTranscriptHistoryRestoreRequest(input);
    } catch (failure) {
      throw normalizeTranscriptHistoryRestoreFailure(failure);
    }

    if (dependencies.platform !== "android" && dependencies.platform !== "ios") {
      throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_NATIVE_ONLY");
    }

    const assertCaller = (): void => {
      try {
        request.assertCaller();
      } catch {
        throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_CONTEXT_INACTIVE");
      }
    };

    try {
      assertCaller();
      const auth = dependencies.getAuth();
      if (!auth.initialized || auth.userId?.toLowerCase() !== request.scope.userId) {
        throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_AUTH_REQUIRED");
      }
      if (dependencies.isDeletionPending()) {
        throw new TranscriptHistoryRestoreError("HISTORY_RESTORE_DELETION_PENDING");
      }
    } catch (failure) {
      throw normalizeTranscriptHistoryRestoreFailure(failure);
    }

    let stopped: TranscriptHistoryRestoreError | null = null;
    let finished = false;
    const stop = (
      code: "HISTORY_RESTORE_CONTEXT_INACTIVE" | "HISTORY_RESTORE_DELETION_PENDING",
    ): void => {
      if (!finished && !stopped) stopped = new TranscriptHistoryRestoreError(code);
    };
    const guard = (): void => {
      if (stopped) throw stopped;
      try {
        assertCaller();
      } catch {
        stop("HISTORY_RESTORE_CONTEXT_INACTIVE");
      }
      try {
        const auth = dependencies.getAuth();
        if (!auth.initialized || auth.userId?.toLowerCase() !== request.scope.userId) {
          stop("HISTORY_RESTORE_CONTEXT_INACTIVE");
        } else if (dependencies.isDeletionPending()) {
          stop("HISTORY_RESTORE_DELETION_PENDING");
        }
      } catch {
        stop("HISTORY_RESTORE_CONTEXT_INACTIVE");
      }
      if (stopped) throw stopped;
    };

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = dependencies.subscribeAuth(() => {
        try {
          const auth = dependencies.getAuth();
          if (
            !auth.initialized ||
            auth.userId?.toLowerCase() !== request.scope.userId
          ) {
            stop("HISTORY_RESTORE_CONTEXT_INACTIVE");
          }
        } catch {
          stop("HISTORY_RESTORE_CONTEXT_INACTIVE");
        }
      });
      guard();
      await verifySourceChecksum(request, guard);
      guard();
      const persisted = await dependencies.prepare({
        scope: request.scope,
        ...request.command,
        assertActive: guard,
      });
      const result = detachResult(persisted, request);

      // Persistence has already acknowledged COMMIT. A later auth/lifetime
      // transition may suppress notification, but must not turn it into a
      // fictitious rollback that encourages another restore attempt.
      try {
        guard();
        dependencies.notifyChanged();
      } catch {
        // The durable draft remains discoverable by a future matching owner.
      }
      return result;
    } catch (failure) {
      throw normalizeTranscriptHistoryRestoreFailure(stopped ?? failure);
    } finally {
      finished = true;
      try {
        unsubscribe?.();
      } catch {
        // The completed one-shot owner cannot start another write.
      }
    }
  };

  return { prepareDraft };
};

const service = createTranscriptHistoryRestoreService();
export const prepareTranscriptHistoryRestoreDraft = service.prepareDraft;
