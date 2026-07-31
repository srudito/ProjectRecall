import { useRouter } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";
import { z } from "zod";

import { AuthMethodDivider } from "@/src/components/AuthMethodDivider";
import { Button } from "@/src/components/Button";
import { Field } from "@/src/components/Field";
import { GoogleSignInButton } from "@/src/components/GoogleSignInButton";
import { Screen } from "@/src/components/Screen";
import { AppError } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import { signUpWithEmail } from "@/src/services/supabase/auth";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";

const schema = z.object({
  displayName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

export default function SignUp() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const setSession = useAuthStore((state) => state.setSession);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);

    const parsed = schema.safeParse({
      displayName: displayName.trim(),
      email: email.trim(),
      password,
    });

    if (!parsed.success) {
      const first = parsed.error.issues[0];

      if (first?.path[0] === "displayName") {
        setError(
          t("auth", "validation.displayNameRequired"),
        );
      } else if (first?.path[0] === "email") {
        setError(t("auth", "validation.emailInvalid"));
      } else {
        setError(
          t("auth", "validation.passwordTooShort"),
        );
      }
      return;
    }

    setSubmitting(true);

    try {
      const result = await signUpWithEmail(
        parsed.data.email,
        parsed.data.password,
        parsed.data.displayName,
      );

      if (result.session) {
        setSession(result.session);
        router.replace("/(tabs)/home");
        return;
      }

      router.replace({
        pathname: "/(auth)/verify-email",
        params: { email: parsed.data.email },
      });
    } catch (cause) {
      const code =
        cause instanceof AppError
          ? cause.code
          : "UNKNOWN_ERROR";

      setError(t("errors", code));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scrollable testID="sign-up-screen">
      <Text
        style={[
          typography.title,
          {
            color: colors.textPrimary,
            marginBottom: spacing.lg,
          },
        ]}
      >
        {t("auth", "signUp.title")}
      </Text>

      <GoogleSignInButton testID="sign-up-google-button" />
      <AuthMethodDivider />

      <Field
        testID="sign-up-display-name-input"
        label={t("common", "labels.displayName")}
        placeholder={t(
          "auth",
          "signUp.displayNamePlaceholder",
        )}
        value={displayName}
        onChangeText={setDisplayName}
      />
      <Field
        testID="sign-up-email-input"
        label={t("common", "labels.email")}
        placeholder={t(
          "auth",
          "signUp.emailPlaceholder",
        )}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        value={email}
        onChangeText={setEmail}
      />
      <Field
        testID="sign-up-password-input"
        label={t("common", "labels.password")}
        placeholder={t(
          "auth",
          "signUp.passwordPlaceholder",
        )}
        secureTextEntry
        autoCapitalize="none"
        value={password}
        onChangeText={setPassword}
      />

      {error ? (
        <Text
          testID="sign-up-error"
          accessibilityRole="alert"
          style={[
            typography.caption,
            {
              color: colors.recording,
              marginBottom: spacing.md,
            },
          ]}
        >
          {error}
        </Text>
      ) : null}

      <Button
        testID="sign-up-submit-button"
        label={t("auth", "signUp.submit")}
        loading={submitting}
        onPress={() => {
          void submit();
        }}
        fullWidth
      />

      <Text
        style={[
          typography.caption,
          {
            color: colors.textTertiary,
            marginTop: spacing.md,
          },
        ]}
      >
        {t("auth", "signUp.terms")}
      </Text>

      <Button
        testID="sign-up-go-sign-in-button"
        label={t("auth", "signUp.signIn")}
        variant="ghost"
        onPress={() =>
          router.replace("/(auth)/sign-in")
        }
      />
    </Screen>
  );
}
