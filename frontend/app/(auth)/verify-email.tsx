import { useLocalSearchParams, useRouter } from "expo-router";
import { Text, View } from "react-native";
import { useState } from "react";

import { Button } from "@/src/components/Button";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { resendVerificationEmail } from "@/src/services/supabase/auth";
import { useTheme } from "@/src/theme/ThemeProvider";
import { AppError } from "@/src/domain/errors";

export default function VerifyEmail() {
  const params = useLocalSearchParams<{ email?: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resend = async () => {
    if (!params.email) return;
    setBusy(true);
    setMessage(null);
    try {
      await resendVerificationEmail(params.email);
      setMessage(t("auth", "messages.checkYourInbox"));
    } catch (e) {
      const code = e instanceof AppError ? e.code : "UNKNOWN_ERROR";
      setMessage(t("errors", code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="verify-email-screen">
      <Text style={[typography.title, { color: colors.textPrimary }]}>
        {t("auth", "verifyEmail.title")}
      </Text>
      <Text style={[typography.body, { color: colors.textSecondary, marginTop: spacing.md }]}>
        {t("auth", "verifyEmail.body", { email: params.email ?? "" })}
      </Text>
      {message ? (
        <Text
          testID="verify-email-message"
          style={[typography.caption, { color: colors.success, marginTop: spacing.md }]}
        >
          {message}
        </Text>
      ) : null}
      <View style={{ height: spacing.lg }} />
      <Button
        testID="verify-email-resend-button"
        label={t("auth", "verifyEmail.resend")}
        loading={busy}
        onPress={resend}
        fullWidth
      />
      <Button
        testID="verify-email-change-email-button"
        label={t("auth", "verifyEmail.changeEmail")}
        variant="ghost"
        onPress={() => router.replace("/(auth)/sign-up")}
      />
      <Button
        testID="verify-email-go-sign-in-button"
        label={t("auth", "signIn.title")}
        variant="ghost"
        onPress={() => router.replace("/(auth)/sign-in")}
      />
    </Screen>
  );
}
