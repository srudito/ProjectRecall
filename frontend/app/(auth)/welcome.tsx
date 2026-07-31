import { useRouter } from "expo-router";
import { Text, View } from "react-native";

import { AuthMethodDivider } from "@/src/components/AuthMethodDivider";
import { Button } from "@/src/components/Button";
import { GoogleSignInButton } from "@/src/components/GoogleSignInButton";
import { Screen } from "@/src/components/Screen";
import { branding } from "@/src/config/branding";
import { isSupabaseConfigured } from "@/src/config/env";
import { useI18n } from "@/src/i18n/I18nProvider";
import { useTheme } from "@/src/theme/ThemeProvider";

export default function Welcome() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const supabaseConfigured = isSupabaseConfigured();

  return (
    <Screen testID="welcome-screen">
      <View
        style={{
          flex: 1,
          justifyContent: "space-between",
        }}
      >
        <View style={{ marginTop: spacing.xxl }}>
          <Text
            style={[
              typography.overline,
              { color: colors.accent },
            ]}
          >
            {branding.productName.toUpperCase()}
          </Text>
          <Text
            testID="welcome-title"
            style={[
              typography.displayLarge,
              {
                color: colors.textPrimary,
                marginTop: spacing.sm,
              },
            ]}
          >
            {t("auth", "welcome.title")}
          </Text>
          <Text
            style={[
              typography.bodyLarge,
              {
                color: colors.textSecondary,
                marginTop: spacing.md,
              },
            ]}
          >
            {t("auth", "welcome.subtitle")}
          </Text>
        </View>

        <View>
          {!supabaseConfigured ? (
            <Text
              testID="supabase-not-configured-notice"
              style={[
                typography.caption,
                {
                  color: colors.warning,
                  padding: spacing.sm,
                  borderWidth: 1,
                  borderColor: colors.warning,
                  borderRadius: 12,
                  marginBottom: spacing.sm,
                },
              ]}
            >
              Supabase is not configured. Add
              EXPO_PUBLIC_SUPABASE_URL and
              EXPO_PUBLIC_SUPABASE_ANON_KEY to
              /app/frontend/.env to enable sign-in and cloud
              sync.
            </Text>
          ) : null}

          {supabaseConfigured ? (
            <GoogleSignInButton testID="welcome-google-button" />
          ) : null}

          {supabaseConfigured ? <AuthMethodDivider /> : null}

          <View style={{ gap: spacing.sm }}>
            <Button
              testID="welcome-sign-in-button"
              label={t("auth", "welcome.signIn")}
              variant="primary"
              fullWidth
              onPress={() =>
                router.push("/(auth)/sign-in")
              }
            />
            <Button
              testID="welcome-create-account-button"
              label={t("auth", "welcome.createAccount")}
              variant="secondary"
              fullWidth
              onPress={() =>
                router.push("/(auth)/sign-up")
              }
            />
          </View>
        </View>
      </View>
    </Screen>
  );
}
