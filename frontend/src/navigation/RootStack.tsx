import { Stack } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import {
  ROOT_ROUTE,
  resolveRootAuthState,
} from "@/src/services/auth/route-access";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";

interface RootNavigatorProps {
  isAuthenticated: boolean;
}

export function RootNavigator({
  isAuthenticated,
}: RootNavigatorProps) {
  return (
    <Stack screenOptions={{ headerShown: false, animation: "fade" }}>
      <Stack.Screen name={ROOT_ROUTE.index} />
      <Stack.Screen name={ROOT_ROUTE.authGroup} />

      <Stack.Protected guard={isAuthenticated}>
        <Stack.Screen name={ROOT_ROUTE.onboardingGroup} />
        <Stack.Screen name={ROOT_ROUTE.tabsGroup} />
        <Stack.Screen
          name={ROOT_ROUTE.recordSetup}
          options={{ presentation: "modal" }}
        />
        <Stack.Screen name={ROOT_ROUTE.recordActive} />
        <Stack.Screen name={ROOT_ROUTE.recordReview} />
        <Stack.Screen name={ROOT_ROUTE.sessionDetail} />
        <Stack.Screen name={ROOT_ROUTE.projectDetail} />
        <Stack.Screen name={ROOT_ROUTE.accountDelete} />
      </Stack.Protected>

      {/* OAuth callbacks must stay public. The link callback preserves the existing session. */}
      <Stack.Screen name={ROOT_ROUTE.authCallback} />
      <Stack.Screen name={ROOT_ROUTE.authLinkCallback} />
      <Stack.Screen name={ROOT_ROUTE.authResetCallback} />
    </Stack>
  );
}

export function RootStack() {
  const { colors } = useTheme();
  const initialized = useAuthStore((state) => state.initialized);
  const session = useAuthStore((state) => state.session);
  const authState = resolveRootAuthState({
    initialized,
    hasSession: Boolean(session),
  });

  if (authState === "loading") {
    return (
      <View
        testID="app-splash-loading"
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <RootNavigator
      isAuthenticated={authState === "authenticated"}
    />
  );
}
