import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useI18n } from "@/src/i18n/I18nProvider";
import { useTheme } from "@/src/theme/ThemeProvider";

export default function TabsLayout() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.tabBarActive,
        tabBarInactiveTintColor: colors.tabBarInactive,
        tabBarStyle: {
          backgroundColor: colors.tabBarBackground,
          borderTopColor: colors.border,
          height: 64 + insets.bottom,
          paddingBottom: insets.bottom,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: t("library", "home.startRecording"),
          tabBarLabel: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
          tabBarButtonTestID: "tab-home",
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: t("library", "library.title"),
          tabBarLabel: "Library",
          tabBarIcon: ({ color, size }) => <Ionicons name="library-outline" size={size} color={color} />,
          tabBarButtonTestID: "tab-library",
        }}
      />
      <Tabs.Screen
        name="record"
        options={{
          title: t("recording", "setup.title"),
          tabBarLabel: "Record",
          tabBarIcon: ({ color }) => (
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
                marginTop: -12,
                shadowColor: "#000",
                shadowOpacity: 0.2,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 4 },
                elevation: 6,
              }}
            >
              <Ionicons name="mic" size={22} color="#fff" />
            </View>
          ),
          tabBarButtonTestID: "tab-record",
          tabBarLabelStyle: { fontSize: 11, fontWeight: "600", marginTop: 8, color: colors.accent },
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t("profile", "title"),
          tabBarLabel: "Profile",
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" size={size} color={color} />,
          tabBarButtonTestID: "tab-profile",
        }}
      />
    </Tabs>
  );
}
