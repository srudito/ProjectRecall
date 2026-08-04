import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Platform, Text, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Field } from "@/src/components/Field";
import { Screen } from "@/src/components/Screen";
import { AppError, ErrorCode, type ErrorCodeKey } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import { useAccountDeletion } from "@/src/components/AccountDeletionBoundary";
import { isRecordingStateSafeForAccountDeletion } from "@/src/services/account-deletion/state";
import { useAuthStore } from "@/src/stores/auth-store";
import { useRecordingStore } from "@/src/stores/recording-store";
import { useTheme } from "@/src/theme/ThemeProvider";

const REQUIRED_CONFIRMATION = "DELETE";

export default function DeleteAccountScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const { beginDeletion, pending } = useAccountDeletion();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const recordingState = useRecordingStore(
    (state) => state.snapshot.state,
  );
  const inFlightRef = useRef(false);
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCodeKey | null>(null);

  const recordingSafe = isRecordingStateSafeForAccountDeletion(
    recordingState,
  );
  const confirmationValid = confirmation === REQUIRED_CONFIRMATION;

  const submit = async (): Promise<void> => {
    if (
      inFlightRef.current ||
      pending ||
      !confirmationValid ||
      !userId
    ) {
      return;
    }

    if (!recordingSafe) {
      setErrorCode(ErrorCode.ACCOUNT_DELETION_RECORDING_ACTIVE);
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    setErrorCode(null);

    try {
      await beginDeletion(userId);
    } catch (cause) {
      const code =
        cause instanceof AppError
          ? cause.code
          : ErrorCode.ACCOUNT_DELETION_LOCAL_STATE_FAILED;
      setErrorCode(code);
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const confirmAndSubmit = (): void => {
    if (!confirmationValid || submitting || pending) return;

    const title = t("profile", "deleteAccount.finalTitle");
    const message = t("profile", "deleteAccount.finalBody");

    if (Platform.OS === "web") {
      const confirmFn = (globalThis as {
        confirm?: (text: string) => boolean;
      }).confirm;
      if (confirmFn?.(`${title}\n\n${message}`) ?? false) {
        void submit();
      }
      return;
    }

    Alert.alert(title, message, [
      {
        text: t("common", "actions.cancel"),
        style: "cancel",
      },
      {
        text: t("profile", "deleteAccount.confirmButton"),
        style: "destructive",
        onPress: () => {
          void submit();
        },
      },
    ]);
  };

  return (
    <Screen scrollable testID="delete-account-screen">
      <Button
        testID="delete-account-back-button"
        label={t("common", "actions.back")}
        variant="ghost"
        onPress={() => router.back()}
      />

      <Text
        style={[
          typography.displayMedium,
          {
            color: colors.textPrimary,
            marginTop: spacing.md,
            marginBottom: spacing.lg,
          },
        ]}
      >
        {t("profile", "deleteAccount.screenTitle")}
      </Text>

      <Card
        title={t("profile", "deleteAccount.warningTitle")}
        testID="delete-account-warning-card"
      >
        <Text style={[typography.body, { color: colors.textPrimary }]}>
          {t("profile", "deleteAccount.warningBody")}
        </Text>
        <Text
          style={[
            typography.caption,
            {
              color: colors.textSecondary,
              marginTop: spacing.md,
            },
          ]}
        >
          {t("profile", "deleteAccount.offlineWarning")}
        </Text>
      </Card>

      <View style={{ height: spacing.lg }} />

      <Field
        testID="delete-account-confirmation-input"
        label={t("profile", "deleteAccount.confirmationLabel")}
        placeholder={t(
          "profile",
          "deleteAccount.confirmationPlaceholder",
        )}
        value={confirmation}
        autoCapitalize="characters"
        autoCorrect={false}
        onChangeText={(value: string) => {
          setConfirmation(value);
          setErrorCode(null);
        }}
        errorText={
          errorCode ? t("errors", errorCode) : undefined
        }
      />

      {!recordingSafe ? (
        <Text
          testID="delete-account-recording-active-warning"
          accessibilityRole="alert"
          style={[
            typography.caption,
            {
              color: colors.recording,
              marginBottom: spacing.md,
            },
          ]}
        >
          {t("profile", "deleteAccount.recordingActive")}
        </Text>
      ) : null}

      <Button
        testID="delete-account-submit-button"
        label={t("profile", "deleteAccount.confirmButton")}
        variant="danger"
        fullWidth
        disabled={
          !confirmationValid ||
          !recordingSafe ||
          !userId ||
          pending
        }
        loading={submitting}
        onPress={confirmAndSubmit}
      />
    </Screen>
  );
}
