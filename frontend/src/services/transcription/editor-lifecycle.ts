import { AppState, Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import { subscribeMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { subscribeTranscriptionSyncChanges } from "@/src/services/sync/transcription-sync-events";
import { useAuthStore } from "@/src/stores/auth-store";

import {
  TranscriptEditorError,
  type TranscriptEditorParticipant,
  type TranscriptEditorRegistration,
  type TranscriptEditorScope,
} from "./editor-types";

/** Runtime ownership only. Durable drafts remain in SQLite after normal sign-out. */
export const createTranscriptEditorRegistry = (
  canOpen: (scope: Readonly<TranscriptEditorScope>) => boolean = () => true,
  initiallyForeground = true,
) => {
  type Entry = { participant: TranscriptEditorParticipant; active: boolean; released: boolean };
  const owners = new Map<string, Entry>();
  let admission = true;
  let foreground = initiallyForeground;
  const keyOf = (scope: Readonly<TranscriptEditorScope>) =>
    `${scope.userId}:${scope.workspaceId}:${scope.sessionId}`;

  const register = (participant: TranscriptEditorParticipant): TranscriptEditorRegistration => {
    if (!admission || !canOpen(participant.scope)) throw new TranscriptEditorError("EDITOR_CONTEXT_INACTIVE");
    const key = keyOf(participant.scope);
    if (owners.has(key)) throw new TranscriptEditorError("EDITOR_SCOPE_IN_USE");
    const entry: Entry = { participant, active: true, released: false };
    owners.set(key, entry);
    return {
      foreground,
      isActive: () => admission && entry.active && owners.get(key) === entry && canOpen(participant.scope),
      release: () => {
        entry.active = false;
        if (entry.released) return;
        entry.released = true;
        // Keep the retired owner reachable until its actual jobs drain. A screen
        // unmount must not hide queued SQL from account-deletion quiescence.
        void Promise.resolve().then(() => participant.waitForIdle()).then(() => {
          if (owners.get(key) === entry) owners.delete(key);
        }, () => {
          // Fail closed: an owner whose drain failed is not silently replaced.
        });
      },
    };
  };

  const invalidateAll = (): void => {
    admission = false;
    for (const entry of [...owners.values()]) {
      entry.active = false;
      entry.participant.invalidate();
    }
  };
  return {
    register,
    invalidateAll,
    setAdmission: (allowed: boolean): void => {
      if (!allowed) invalidateAll();
      else admission = true; // Only new owners may open; old entries stay invalid.
    },
    setForeground: (value: boolean): void => {
      foreground = value;
      for (const { participant, active } of [...owners.values()]) {
        if (active) participant.setForeground(value);
      }
    },
    refreshAll: (): void => {
      for (const { participant, active } of [...owners.values()]) {
        if (active) void participant.refresh().catch(() => { /* State records a safe error. */ });
      }
    },
    waitForIdle: async (): Promise<void> => {
      // Admission is closed by quiescence before calling this. Controller idle
      // includes every job already queued, not just the currently running SQL.
      await Promise.all([...owners.values()].map(({ participant }) => participant.waitForIdle()));
    },
  };
};

const native = () => Platform.OS === "android" || Platform.OS === "ios";
const registry = createTranscriptEditorRegistry((scope) => {
  const auth = useAuthStore.getState();
  return native() && auth.initialized && auth.user?.id.toLowerCase() === scope.userId &&
    !isAccountDeletionLocallyPending();
}, AppState.currentState === "active");

export const registerTranscriptEditor = registry.register;
export const invalidateTranscriptEditors = registry.invalidateAll;
export const waitForTranscriptEditorsIdle = registry.waitForIdle;

export interface TranscriptEditorLifecycleDependencies {
  platform: string;
  getAuth: () => { initialized: boolean; userId: string | null };
  subscribeAuth: (listener: () => void) => () => void;
  isDeletionPending: () => boolean;
  isForeground: () => boolean;
  subscribeForeground: (listener: (foreground: boolean) => void) => () => void;
  subscribeTranscript: (listener: () => void) => () => void;
  subscribeMetadata: (listener: () => void) => () => void;
  registry: ReturnType<typeof createTranscriptEditorRegistry>;
}

/** No connectivity gate: local persistence must work offline. */
export const bindTranscriptEditorLifecycle = (dependencies: TranscriptEditorLifecycleDependencies): (() => void) => {
  if (dependencies.platform !== "android" && dependencies.platform !== "ios") return () => {};
  let disposed = false;
  let previous = dependencies.getAuth();
  const update = (): void => {
    if (disposed) return;
    const auth = dependencies.getAuth();
    if (auth.userId !== previous.userId) dependencies.registry.invalidateAll();
    previous = auth;
    dependencies.registry.setAdmission(auth.initialized && auth.userId !== null && !dependencies.isDeletionPending());
  };
  const refresh = (): void => {
    if (disposed) return;
    update();
    dependencies.registry.refreshAll();
  };
  const unsubscribeAuth = dependencies.subscribeAuth(update);
  const unsubscribeForeground = dependencies.subscribeForeground((foreground) => {
    if (disposed) return;
    update();
    dependencies.registry.setForeground(foreground);
    if (foreground) dependencies.registry.refreshAll();
  });
  const unsubscribeTranscript = dependencies.subscribeTranscript(refresh);
  const unsubscribeMetadata = dependencies.subscribeMetadata(refresh);
  update();
  dependencies.registry.setForeground(dependencies.isForeground());
  return () => {
    if (disposed) return;
    disposed = true;
    dependencies.registry.invalidateAll();
    unsubscribeAuth();
    unsubscribeForeground();
    unsubscribeTranscript();
    unsubscribeMetadata();
  };
};

let lifecycleOwners = 0;
let stopLifecycle: (() => void) | null = null;

/** Headless adapter installed once, even if two roots briefly overlap. */
export const startTranscriptEditorLifecycle = (): (() => void) => {
  if (!native()) return () => {};
  if (lifecycleOwners === 0) {
    stopLifecycle = bindTranscriptEditorLifecycle({
      platform: Platform.OS,
      registry,
      getAuth: () => {
        const auth = useAuthStore.getState();
        return { initialized: auth.initialized, userId: auth.user?.id ?? null };
      },
      subscribeAuth: (listener) => useAuthStore.subscribe(listener),
      isDeletionPending: isAccountDeletionLocallyPending,
      isForeground: () => AppState.currentState === "active",
      subscribeForeground: (listener) => {
        const subscription = AppState.addEventListener("change", (state) => listener(state === "active"));
        return () => subscription.remove();
      },
      subscribeTranscript: subscribeTranscriptionSyncChanges,
      subscribeMetadata: subscribeMetadataSyncChanges,
    });
  }
  lifecycleOwners += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lifecycleOwners -= 1;
    if (lifecycleOwners === 0) {
      stopLifecycle?.();
      stopLifecycle = null;
    }
  };
};
