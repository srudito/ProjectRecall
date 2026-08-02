import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { useTheme } from "@/src/theme/ThemeProvider";

// On web this closes the OAuth popup and resolves openAuthSessionAsync in the
// original Profile window. On native it is a harmless no-op.
WebBrowser.maybeCompleteAuthSession();

export default function AuthLinkCallback() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();

  useEffect(() => {
    // Expo Router may also mount this route in the native app while the same
    // deep link is resolving the WebBrowser promise. Returning to Profile is
    // safe because the initiating identity-link service owns the single PKCE
    // code exchange, verifies the original user, and refreshes identities. This
    // route never exchanges a code or sets session itself.
    const timer = setTimeout(() => {
      router.replace("/(tabs)/profile");
    }, 400);

    return () => {
      clearTimeout(timer);
    };
  }, [router]);

  return (
    <Screen testID="auth-link-callback-screen">
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: spacing.lg,
        }}
      >
        <Text
          style={[
            typography.title,
            {
              color: colors.textPrimary,
              textAlign: "center",
            },
          ]}
        >
          {t("auth", "oauth.linkCallbackTitle")}
        </Text>

        <ActivityIndicator
          color={colors.accent}
          style={{ marginTop: spacing.lg }}
        />

        <Text
          style={[
            typography.body,
            {
              color: colors.textSecondary,
              textAlign: "center",
              marginTop: spacing.md,
              marginBottom: spacing.lg,
            },
          ]}
        >
          {t("auth", "oauth.linkCallbackBody")}
        </Text>

        <Button
          testID="auth-link-callback-return-button"
          label={t("auth", "oauth.returnToProfile")}
          variant="secondary"
          onPress={() => router.replace("/(tabs)/profile")}
        />
      </View>
    </Screen>
  );
}
