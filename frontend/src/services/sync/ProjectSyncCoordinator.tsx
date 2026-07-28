import NetInfo from "@react-native-community/netinfo";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { useAuthStore } from "@/src/stores/auth-store";

import { requestProjectSync } from "./project-sync-worker";

/**
 * Starts the native project metadata worker at the lifecycle boundaries that
 * can make pending work eligible again. Web project operations go directly to
 * Supabase and therefore do not use the local SQLite queue.
 */
export function ProjectSyncCoordinator() {
  const initialized = useAuthStore((state) => state.initialized);
  const userId = useAuthStore((state) => state.user?.id ?? null);

  useEffect(() => {
    if (Platform.OS === "web" || !initialized || !userId) return;
    requestProjectSync();
  }, [initialized, userId]);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && useAuthStore.getState().user?.id) {
        requestProjectSync();
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
        requestProjectSync();
      }
    });

    return unsubscribe;
  }, []);

  return null;
}
