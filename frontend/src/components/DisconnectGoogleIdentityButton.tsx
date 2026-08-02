import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Text, View } from "react-native";

import { Button } from "@/src/components/Button";
import { AppError, ErrorCode } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import { unlinkGoogleIdentity } from "@/src/services/supabase/auth";
import { useTheme } from "@/src/theme/ThemeProvider";

interface DisconnectGoogleIdentityButtonProps {
  identityId: string;
  identityEmail: string | null;
  onUnlinked: () => Promise<void> | void;
  disabled?: boolean;
}

export function DisconnectGoogleIdentityButton({
  identityId,
  identityEmail,
  onUnlinked,
  disabled = false,
}: DisconnectGoogleIdentityButtonProps) {
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

  const performUnlink = async (): Promise<void> => {
    if (disabled || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    if (mountedRef.current) {
      setSubmitting(true);
      setError(null);
    }

    try {
      const result = await unlinkGoogleIdentity(identityId);

      if (result.status === "lastIdentity") {
        if (mountedRef.current) {
          setError(
            t("errors", ErrorCode.AUTH_IDENTITY_UNLINK_LAST_IDENTITY),
          );
        }
        return;
      }

      await onUnlinked();
    } catch (cause) {
      if (!mountedRef.current) {
        return;
      }

      const code =
        cause instanceof AppError
          ? cause.code
          : ErrorCode.AUTH_IDENTITY_UNLINK_FAILED;

      setError(t("errors", code));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  const confirmUnlink = (): void => {
    if (disabled || inFlightRef.current) {
      return;
    }

    const title = t(
      "profile",
      "connectedAccounts.disconnectGoogleConfirmTitle",
    );
    const message = t(
      "profile",
      "connectedAccounts.disconnectGoogleConfirmBody",
      {
        email:
          identityEmail ??
          t("profile", "connectedAccounts.providers.google"),
      },
    );

    if (Platform.OS === "web") {
      const confirmFn = (globalThis as {
        confirm?: (text: string) => boolean;
      }).confirm;

      if (confirmFn?.(`${title}\n\n${message}`) ?? false) {
        void performUnlink();
      }
      return;
    }

    Alert.alert(title, message, [
      {
        text: t("common", "actions.cancel"),
        style: "cancel",
      },
      {
        text: t("profile", "connectedAccounts.disconnectGoogle"),
        style: "destructive",
        onPress: () => {
          void performUnlink();
        },
      },
    ]);
  };

  return (
    <View>
      <Button
        testID={`profile-disconnect-google-${identityId}`}
        label={t("profile", "connectedAccounts.disconnectGoogle")}
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
        onPress={confirmUnlink}
      />

      {error ? (
        <Text
          testID={`profile-disconnect-google-error-${identityId}`}
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
