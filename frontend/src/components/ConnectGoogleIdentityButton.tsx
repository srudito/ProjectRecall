import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";

import { Button } from "@/src/components/Button";
import { AppError, ErrorCode } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import { linkGoogleIdentity } from "@/src/services/supabase/auth";
import { useTheme } from "@/src/theme/ThemeProvider";

interface ConnectGoogleIdentityButtonProps {
  onLinked: () => Promise<void> | void;
  disabled?: boolean;
}

export function ConnectGoogleIdentityButton({
  onLinked,
  disabled = false,
}: ConnectGoogleIdentityButtonProps) {
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (disabled || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const result = await linkGoogleIdentity();

      if (result.status === "cancelled") {
        return;
      }

      if (result.status === "alreadyLinkedElsewhere") {
        if (mountedRef.current) {
          setError(
            t("errors", ErrorCode.AUTH_IDENTITY_LINK_CONFLICT),
          );
        }
        return;
      }

      await onLinked();
    } catch (cause) {
      if (!mountedRef.current) {
        return;
      }

      const code =
        cause instanceof AppError
          ? cause.code
          : ErrorCode.AUTH_IDENTITY_LINK_FAILED;

      setError(t("errors", code));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  return (
    <View>
      <Button
        testID="profile-connect-google-button"
        label={t("profile", "connectedAccounts.connectGoogle")}
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
          testID="profile-connect-google-error"
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
