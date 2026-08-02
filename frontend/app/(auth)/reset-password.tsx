import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Text,
  View,
} from "react-native";
import { z } from "zod";

import { Button } from "@/src/components/Button";
import { Field } from "@/src/components/Field";
import { Screen } from "@/src/components/Screen";
import { AppError } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import {
  hasActivePasswordRecoveryGrant,
  updateRecoveredPassword,
} from "@/src/services/supabase/auth";
import { useTheme } from "@/src/theme/ThemeProvider";

const schema = z
  .object({ password: z.string().min(8), confirm: z.string().min(8) })
  .refine((v) => v.password === v.confirm, {
    message: "no_match",
    path: ["confirm"],
  });

export default function ResetPassword() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;

    void hasActivePasswordRecoveryGrant().then((ready) => {
      if (active) {
        setRecoveryReady(ready);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const submit = async () => {
    setError(null);
    const parsed = schema.safeParse({ password, confirm });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      if (first?.message === "no_match") {
        setError(t("auth", "validation.passwordsMustMatch"));
      } else {
        setError(t("auth", "validation.passwordTooShort"));
      }
      return;
    }

    setBusy(true);
    try {
      await updateRecoveredPassword(parsed.data.password);
      router.replace("/(tabs)/home");
    } catch (cause) {
      const code =
        cause instanceof AppError
          ? cause.code
          : "UNKNOWN_ERROR";

      if (code === "AUTH_PASSWORD_RECOVERY_REQUIRED") {
        setRecoveryReady(false);
      }

      setError(t("errors", code));
    } finally {
      setBusy(false);
    }
  };

  if (recoveryReady === null) {
    return (
      <Screen testID="reset-password-screen">
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ActivityIndicator color={colors.accent} />
          <Text
            style={[
              typography.body,
              {
                color: colors.textSecondary,
                marginTop: spacing.md,
                textAlign: "center",
              },
            ]}
          >
            {t("auth", "resetPassword.verifying")}
          </Text>
        </View>
      </Screen>
    );
  }

  if (!recoveryReady) {
    return (
      <Screen testID="reset-password-screen">
        <Text
          style={[
            typography.title,
            {
              color: colors.textPrimary,
              marginBottom: spacing.md,
            },
          ]}
        >
          {t("auth", "resetPassword.title")}
        </Text>
        <Text
          testID="reset-password-recovery-required"
          accessibilityRole="alert"
          style={[
            typography.body,
            {
              color: colors.recording,
              marginBottom: spacing.lg,
            },
          ]}
        >
          {t("errors", "AUTH_PASSWORD_RECOVERY_REQUIRED")}
        </Text>
        <Button
          testID="reset-password-request-new-link-button"
          label={t("auth", "resetPassword.requestNewLink")}
          onPress={() =>
            router.replace("/(auth)/forgot-password")
          }
          fullWidth
        />
      </Screen>
    );
  }

  return (
    <Screen testID="reset-password-screen">
      <Text
        style={[
          typography.title,
          { color: colors.textPrimary, marginBottom: spacing.lg },
        ]}
      >
        {t("auth", "resetPassword.title")}
      </Text>
      <Field
        testID="reset-password-new-input"
        label={t("auth", "resetPassword.newPassword")}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Field
        testID="reset-password-confirm-input"
        label={t("auth", "resetPassword.confirmPassword")}
        secureTextEntry
        value={confirm}
        onChangeText={setConfirm}
      />
      {error ? (
        <Text
          testID="reset-password-error"
          style={[
            typography.caption,
            { color: colors.recording, marginBottom: spacing.md },
          ]}
        >
          {error}
        </Text>
      ) : null}
      <Button
        testID="reset-password-submit-button"
        label={t("auth", "resetPassword.submit")}
        loading={busy}
        onPress={submit}
        fullWidth
      />
    </Screen>
  );
}
