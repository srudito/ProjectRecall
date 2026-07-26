import { useRouter } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";
import { z } from "zod";

import { Button } from "@/src/components/Button";
import { Field } from "@/src/components/Field";
import { Screen } from "@/src/components/Screen";
import { AppError } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import { sendPasswordReset } from "@/src/services/supabase/auth";
import { useTheme } from "@/src/theme/ThemeProvider";

const schema = z.object({ email: z.string().email() });

export default function ForgotPassword() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setMessage(null);
    const parsed = schema.safeParse({ email: email.trim() });
    if (!parsed.success) {
      setError(t("auth", "validation.emailInvalid"));
      return;
    }
    setBusy(true);
    try {
      await sendPasswordReset(parsed.data.email);
      setMessage(t("auth", "messages.resetSent"));
    } catch (e) {
      const code = e instanceof AppError ? e.code : "UNKNOWN_ERROR";
      setError(t("errors", code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="forgot-password-screen">
      <Text style={[typography.title, { color: colors.textPrimary }]}>
        {t("auth", "forgotPassword.title")}
      </Text>
      <Text style={[typography.body, { color: colors.textSecondary, marginTop: spacing.md, marginBottom: spacing.lg }]}>
        {t("auth", "forgotPassword.body")}
      </Text>
      <Field
        testID="forgot-password-email-input"
        label={t("common", "labels.email")}
        placeholder={t("auth", "signIn.emailPlaceholder")}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      {message ? (
        <Text
          testID="forgot-password-message"
          style={[typography.caption, { color: colors.success, marginBottom: spacing.md }]}
        >
          {message}
        </Text>
      ) : null}
      {error ? (
        <Text
          testID="forgot-password-error"
          style={[typography.caption, { color: colors.recording, marginBottom: spacing.md }]}
        >
          {error}
        </Text>
      ) : null}
      <Button
        testID="forgot-password-submit-button"
        label={t("auth", "forgotPassword.submit")}
        loading={busy}
        onPress={submit}
        fullWidth
      />
      <Button
        testID="forgot-password-back-button"
        label={t("common", "actions.back")}
        variant="ghost"
        onPress={() => router.replace("/(auth)/sign-in")}
      />
    </Screen>
  );
}
