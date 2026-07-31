import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";

import { AppError } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import { signInWithGoogle } from "@/src/services/supabase/auth";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";

import { Button } from "@/src/components/Button";

interface GoogleSignInButtonProps {
  testID: string;
  disabled?: boolean;
}

export function GoogleSignInButton({
  testID,
  disabled = false,
}: GoogleSignInButtonProps) {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const setSession = useAuthStore((state) => state.setSession);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting || disabled) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const result = await signInWithGoogle();

      if (result.status === "cancelled") {
        return;
      }

      setSession(result.session);
      router.replace("/(tabs)/home");
    } catch (cause) {
      const code =
        cause instanceof AppError
          ? cause.code
          : "AUTH_OAUTH_FAILED";

      setError(t("errors", code));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View>
      <Button
        testID={testID}
        label={t("auth", "oauth.continueWithGoogle")}
        variant="secondary"
        fullWidth
        disabled={disabled}
        loading={submitting}
        leftIcon={
          <Ionicons
            name="logo-google"
            size={20}
            color={colors.textPrimary}
          />
        }
        onPress={() => {
          void submit();
        }}
      />

      {error ? (
        <Text
          testID={`${testID}-error`}
          accessibilityRole="alert"
          style={[
            typography.caption,
            {
              color: colors.recording,
              marginTop: spacing.sm,
            },
          ]}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
