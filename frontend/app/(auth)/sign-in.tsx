import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";

import { Button } from "@/src/components/Button";
import { Field } from "@/src/components/Field";
import { Screen } from "@/src/components/Screen";
import { AppError } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import { signInWithEmail } from "@/src/services/supabase/auth";
import { useTheme } from "@/src/theme/ThemeProvider";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export default function SignIn() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    const parsed = schema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      setError(t("auth", "validation.emailInvalid"));
      return;
    }
    setSubmitting(true);
    try {
      await signInWithEmail(parsed.data.email, parsed.data.password);
      router.replace("/(tabs)/home");
    } catch (e) {
      const code = e instanceof AppError ? e.code : "UNKNOWN_ERROR";
      setError(t("errors", code));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scrollable testID="sign-in-screen">
      <Text style={[typography.title, { color: colors.textPrimary, marginBottom: spacing.lg }]}>
        {t("auth", "signIn.title")}
      </Text>
      <Field
        testID="sign-in-email-input"
        label={t("common", "labels.email")}
        placeholder={t("auth", "signIn.emailPlaceholder")}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        value={email}
        onChangeText={setEmail}
      />
      <Field
        testID="sign-in-password-input"
        label={t("common", "labels.password")}
        placeholder={t("auth", "signIn.passwordPlaceholder")}
        secureTextEntry
        autoCapitalize="none"
        value={password}
        onChangeText={setPassword}
      />
      {error ? (
        <Text
          testID="sign-in-error"
          style={[typography.caption, { color: colors.recording, marginBottom: spacing.md }]}
        >
          {error}
        </Text>
      ) : null}
      <Button
        testID="sign-in-submit-button"
        label={t("auth", "signIn.submit")}
        loading={submitting}
        onPress={submit}
        fullWidth
      />
      <View style={{ height: spacing.md }} />
      <Button
        testID="sign-in-forgot-button"
        label={t("auth", "signIn.forgot")}
        variant="ghost"
        onPress={() => router.push("/(auth)/forgot-password")}
      />
      <Button
        testID="sign-in-create-account-button"
        label={t("auth", "signIn.createOne")}
        variant="ghost"
        onPress={() => router.replace("/(auth)/sign-up")}
      />
    </Screen>
  );
}
