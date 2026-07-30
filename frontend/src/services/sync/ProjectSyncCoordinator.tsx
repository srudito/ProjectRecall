import NetInfo from "@react-native-community/netinfo";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { useAuthStore } from "@/src/stores/auth-store";

import { subscribeMetadataSyncChanges } from "./project-sync-events";
import { requestMetadataSync } from "./project-sync-worker";
import { requestMediaUploadSync } from "./media-upload-worker";
import { requestRecordingUploadSync } from "./recording-upload-worker";

const requestAllSync = (): void => {
  requestMetadataSync();
  requestRecordingUploadSync();
  requestMediaUploadSync();
};

/**
 * Starts the native metadata, recording-upload, and evidence-upload workers at lifecycle
 * boundaries that can make queued work eligible again. Web operations go
 * directly to Supabase and therefore do not use the local SQLite queues.
 */
export function ProjectSyncCoordinator() {
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

    // A session may become eligible for binary upload immediately after its
    // metadata worker reaches the synchronized state.
    return subscribeMetadataSyncChanges(() => {
      if (useAuthStore.getState().user?.id) {
        requestRecordingUploadSync();
        requestMediaUploadSync();
      }
    });
  }, []);

  return null;
}
