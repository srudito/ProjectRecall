import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { LogBox } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { I18nProvider } from "@/src/i18n/I18nProvider";
import { RootStack } from "@/src/navigation/RootStack";
import { RecordingAudioCoordinator } from "@/src/services/recording/RecordingAudioCoordinator";
import { ProjectSyncCoordinator } from "@/src/services/sync/ProjectSyncCoordinator";
import { useAuthStore } from "@/src/stores/auth-store";
import { ThemeProvider, useTheme } from "@/src/theme/ThemeProvider";

// Disable logbox in preview.
LogBox.ignoreAllLogs(true);

// Keep native splash visible until fonts register (icon prewarm — do not remove).
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function StatusBarAdapter() {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === "dark" ? "light" : "dark"} />;
}

export default function RootLayout() {
  const [loaded, error] = useIconFonts();
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [loaded, error]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    (async () => {
      dispose = await initialize();
    })();
    return () => {
      dispose?.();
    };
  }, [initialize]);

  if (!loaded && !error) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <I18nProvider>
          <QueryClientProvider client={queryClient}>
            <KeyboardProvider>
              <RecordingAudioCoordinator />
              <ProjectSyncCoordinator />
              <StatusBarAdapter />
              <RootStack />
            </KeyboardProvider>
          </QueryClientProvider>
        </I18nProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
