import { Redirect } from "expo-router";
import { View, ActivityIndicator } from "react-native";

import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";
import { isSupabaseConfigured } from "@/src/config/env";

export default function Index() {
  const { colors } = useTheme();
  const { session, initialized } = useAuthStore();

  if (!initialized) {
    return (
      <View
        testID="app-splash-loading"
        style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}
      >
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  // If Supabase is not configured, we route to welcome so the user still sees
  // the branded intro screen and any local-only affordances.
  if (!isSupabaseConfigured() || !session) {
    return <Redirect href="/(auth)/welcome" />;
  }

  return <Redirect href="/(tabs)/home" />;
}
