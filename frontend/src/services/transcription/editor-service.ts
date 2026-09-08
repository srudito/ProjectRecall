import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import {
  discardGuardedTranscriptEditDraft,
  enqueueGuardedTranscriptEditSnapshot,
  loadTranscriptEditorState,
  saveGuardedTranscriptEditDraft,
  type TranscriptEditDraftRow,
} from "@/src/services/sqlite/repository";
import { requestTranscriptEditSync } from "@/src/services/sync/transcript-edit-worker";
import { notifyTranscriptionSyncChanges } from "@/src/services/sync/transcription-sync-events";
import { useAuthStore } from "@/src/stores/auth-store";

import {
  normalizeTranscriptEditorScope,
  TranscriptEditorError,
  type TranscriptEditorDraftCommand,
  type TranscriptEditorScope,
} from "./editor-types";

export interface TranscriptEditorServiceDependencies {
  platform: string;
  getUserId: () => string | null;
  isDeletionPending: () => boolean;
  isContextActive: () => boolean;
  createId: () => string;
  load: typeof loadTranscriptEditorState;
  saveDraft: typeof saveGuardedTranscriptEditDraft;
  enqueue: typeof enqueueGuardedTranscriptEditSnapshot;
  discard: typeof discardGuardedTranscriptEditDraft;
  notifyChanged: () => void;
  requestSync: () => void;
}

const defaults: TranscriptEditorServiceDependencies = {
  platform: Platform.OS,
  getUserId: () => useAuthStore.getState().user?.id ?? null,
  isDeletionPending: isAccountDeletionLocallyPending,
  isContextActive: () => true,
  createId: () => Crypto.randomUUID(),
  load: loadTranscriptEditorState,
  saveDraft: saveGuardedTranscriptEditDraft,
  enqueue: enqueueGuardedTranscriptEditSnapshot,
  discard: discardGuardedTranscriptEditDraft,
  notifyChanged: notifyTranscriptionSyncChanges,
  requestSync: requestTranscriptEditSync,
};

const copyDraft = (draft: Readonly<TranscriptEditDraftRow> | null) =>
  draft === null ? null : { ...draft };

const captureDraft = (input: TranscriptEditorDraftCommand): TranscriptEditorDraftCommand => ({
  baseVersionId: input.baseVersionId,
  plainText: input.plainText,
  expectedDraft: copyDraft(input.expectedDraft),
});

/** Local persistence only. Timers, controller state and lifecycle wiring come later. */
export const createTranscriptEditorService = (
  scopeInput: Readonly<TranscriptEditorScope>,
  overrides: Partial<TranscriptEditorServiceDependencies> = {},
) => {
  const scope = Object.freeze(normalizeTranscriptEditorScope(scopeInput));
  const dependencies = { ...defaults, ...overrides };
  const assertActive = (): void => {
    if (dependencies.platform !== "android" && dependencies.platform !== "ios") {
      throw new TranscriptEditorError("EDITOR_NATIVE_ONLY");
    }
    if (!dependencies.isContextActive()) {
      throw new TranscriptEditorError("EDITOR_CONTEXT_INACTIVE");
    }
    if (dependencies.getUserId()?.toLowerCase() !== scope.userId) {
      throw new TranscriptEditorError("EDITOR_AUTH_REQUIRED");
    }
    if (dependencies.isDeletionPending()) {
      throw new TranscriptEditorError("EDITOR_DELETION_PENDING");
    }
  };
  const context = { scope, assertActive };

  const perform = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      assertActive();
      return await operation();
    } catch (error) {
      if (error instanceof TranscriptEditorError) throw error;
      throw new TranscriptEditorError("EDITOR_LOCAL_STORAGE_FAILED");
    }
  };

  // A notification/wake failure after SQLite committed is NOT a save failure.
  // Do not report it as one and tempt the caller to submit another UUID.
  const notify = (wake: boolean): void => {
    try { assertActive(); } catch { return; }
    try { dependencies.notifyChanged(); } catch { /* Best effort. */ }
    if (wake) {
      try { dependencies.requestSync(); } catch { /* The outbox remains durable. */ }
    }
  };

  return {
    load: () => perform(() => dependencies.load(context)),
    saveDraft: (input: TranscriptEditorDraftCommand) => {
      const captured = captureDraft(input);
      return perform(async () => {
        const draft = await dependencies.saveDraft({ ...context, ...captured });
        notify(false);
        return draft;
      });
    },
    save: (input: TranscriptEditorDraftCommand & { clientVersionId?: string }) => {
      const captured = { ...captureDraft(input), clientVersionId: input.clientVersionId };
      return perform(async () => {
        const result = await dependencies.enqueue({
          ...context,
          ...captured,
          clientVersionId: captured.clientVersionId ?? dependencies.createId(),
        });
        const row = result.operation;
        notify((row.queue_status === "pending" || row.queue_status === "failed") &&
          row.attempt_count < row.max_attempts);
        return result;
      });
    },
    discardDraft: (expectedDraft: Readonly<TranscriptEditDraftRow> | null) => {
      const captured = copyDraft(expectedDraft);
      return perform(async () => {
        await dependencies.discard({ ...context, expectedDraft: captured });
        notify(false);
      });
    },
  };
};
