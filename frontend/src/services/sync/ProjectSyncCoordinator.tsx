import NetInfo from "@react-native-community/netinfo";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import { useAuthStore } from "@/src/stores/auth-store";

import { subscribeMetadataSyncChanges } from "./project-sync-events";
import { requestMetadataSync } from "./project-sync-worker";
import { requestMediaUploadSync } from "./media-upload-worker";
import { requestRecordingUploadSync } from "./recording-upload-worker";
import { requestSessionDeletionSync } from "./session-deletion-worker";
import { requestTranscriptionRequestSync } from "./transcription-request-worker";
import { requestTranscriptionResultSync } from "./transcription-result-worker";
import { requestTranscriptCurrentVersionSync } from "./transcript-current-version-worker";
import {
  pauseTranscriptEditSync,
  resumeTranscriptEditSync,
} from "./transcript-edit-worker";
import { subscribeTranscriptionRequestSubmissions } from "./transcription-sync-events";

const requestAllSync = (): void => {
  if (isAccountDeletionLocallyPending()) return;
  requestSessionDeletionSync();
  requestMetadataSync();
  requestRecordingUploadSync();
  requestMediaUploadSync();
  requestTranscriptionRequestSync();
  requestTranscriptionResultSync();
  requestTranscriptCurrentVersionSync();
};

/**
 * Edit-worker admission only; this does not create an editor/controller.
 * Auth subscription is synchronous so A -> B -> A invalidates the old run,
 * even if React batches away the intermediate render. Token refresh wakes a
 * deferred same-user operation without replacing its UUID or retry metadata.
 */
export const startTranscriptEditSyncLifecycle = (): (() => void) => {
  if (Platform.OS === "web") return () => {};
  let disposed = false;
  let active = AppState.currentState === "active";
  let online = true; // Unknown connectivity is checked by the worker itself.
  let previousAuth = useAuthStore.getState();

  const updateAdmission = (): void => {
    if (disposed) return;
    const auth = useAuthStore.getState();
    if (active && online && auth.initialized && auth.user?.id && !isAccountDeletionLocallyPending()) {
      resumeTranscriptEditSync();
    } else {
      pauseTranscriptEditSync();
    }
  };

  const unsubscribeAuth = useAuthStore.subscribe((auth) => {
    if (disposed) return;
    const identityChanged = auth.user?.id !== previousAuth.user?.id;
    const changed = identityChanged || auth.initialized !== previousAuth.initialized ||
      auth.session !== previousAuth.session;
    previousAuth = auth;
    if (identityChanged) pauseTranscriptEditSync();
    if (changed) updateAdmission();
  });
  const appSubscription = AppState.addEventListener("change", (state) => {
    if (disposed) return;
    active = state === "active";
    updateAdmission();
  });
  const unsubscribeConnection = NetInfo.addEventListener((state) => {
    if (disposed) return;
    online = state.isConnected !== false && state.isInternetReachable !== false;
    updateAdmission();
  });
  updateAdmission();

  return () => {
    disposed = true;
    pauseTranscriptEditSync();
    unsubscribeAuth();
    appSubscription.remove();
    unsubscribeConnection();
  };
};

/**
 * Starts the native metadata, binary-upload, and transcription-request workers
 * at lifecycle boundaries that can make queued work eligible again. Web operations go
 * directly to Supabase and therefore do not use the local SQLite queues.
 */
export function ProjectSyncCoordinator() {
  useEffect(() => startTranscriptEditSyncLifecycle(), []);
  const initialized = useAuthStore((state) => state.initialized);
  const userId = useAuthStore((state) => state.user?.id ?? null);

  useEffect(() => {
    if (Platform.OS === "web" || !initialized || !userId) return;
    requestAllSync();
  }, [initialized, userId]);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && useAuthStore.getState().user?.id) {
        requestAllSync();
      }
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const unsubscribe = NetInfo.addEventListener((state) => {
      const online =
        state.isConnected !== false && state.isInternetReachable !== false;
      if (online && useAuthStore.getState().user?.id) {
        requestAllSync();
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;
    return subscribeTranscriptionRequestSubmissions(() => {
      if (useAuthStore.getState().user?.id) {
        requestTranscriptionResultSync();
      }
    });
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;

    // A session may become eligible for binary upload immediately after its
    // metadata worker reaches the synchronized state.
    return subscribeMetadataSyncChanges(() => {
      if (useAuthStore.getState().user?.id) {
        requestRecordingUploadSync();
        requestMediaUploadSync();
        requestTranscriptionRequestSync();
        requestTranscriptCurrentVersionSync();
      }
    });
  }, []);

  return null;
}
