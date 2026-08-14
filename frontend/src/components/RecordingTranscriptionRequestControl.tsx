import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";

import { useI18n } from "@/src/i18n/I18nProvider";
import type {
  RecordingRecord,
  SessionRecord,
  TranscriptionRequestQueueRow,
} from "@/src/services/sqlite/repository";
import { subscribeTranscriptionSyncChanges } from "@/src/services/sync/transcription-sync-events";
import { resolveTranscriptionFeatureEnabled } from "@/src/services/transcription/feature-availability";
import {
  getRecordingTranscriptionRequest,
  queueRecordingTranscription,
} from "@/src/services/transcription/service";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";

import { Button } from "./Button";

const transcriptionStatusKey = (status: string): string => {
  const supported = new Set([
    "pending",
    "submitting",
    "submitted",
    "failed",
    "cancelled",
  ]);
  return supported.has(status) ? status : "pending";
};

export function RecordingTranscriptionRequestControl({
  session,
  recording,
}: {
  session: SessionRecord;
  recording: RecordingRecord;
}) {
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const [featureEnabled, setFeatureEnabled] = useState(false);
  const [request, setRequest] = useState<TranscriptionRequestQueueRow | null>(
    null,
  );
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;

    const enabled = await resolveTranscriptionFeatureEnabled();
    const localRequest = userId
      ? await getRecordingTranscriptionRequest({ session, recording, userId })
      : null;

    if (requestId !== loadRequestRef.current) return;
    setFeatureEnabled(enabled);
    setRequest(localRequest);
    setError(null);
  }, [recording, session, userId]);

  useEffect(() => {
    void load();
    const unsubscribe = subscribeTranscriptionSyncChanges(() => {
      void load();
    });
    return () => {
      loadRequestRef.current += 1;
      unsubscribe();
    };
  }, [load]);

  if (Platform.OS === "web" || (!featureEnabled && !request)) {
    return null;
  }

  const requestBusy =
    request?.queue_status === "pending" ||
    request?.queue_status === "submitting" ||
    request?.queue_status === "submitted";
  const canRequest =
    featureEnabled &&
    userId != null &&
    recording.upload_status !== "failed" &&
    recording.upload_status !== "cancelled";
  const buttonLabel =
    request?.queue_status === "failed"
      ? t("session", "recording.transcription.retry")
      : requestBusy
        ? t(
            "session",
            `recording.transcription.status.${transcriptionStatusKey(
              request?.queue_status ?? "pending",
            )}`,
          )
        : t("session", "recording.transcription.request");

  const requestTranscription = async () => {
    if (!userId || requesting || !canRequest) return;
    setRequesting(true);
    setError(null);
    try {
      const queued = await queueRecordingTranscription({
        session,
        recording,
        userId,
      });
      setRequest(queued);
    } catch {
      // Do not expose SQLite/network implementation details in user-visible UI.
      setError(t("session", "recording.transcription.requestFailed"));
    } finally {
      setRequesting(false);
    }
  };

  return (
    <View style={{ marginTop: spacing.sm }}>
      {request ? (
        <Text
          testID="session-recording-transcription-status"
          style={[
            typography.caption,
            {
              color:
                request.queue_status === "failed"
                  ? colors.recording
                  : colors.textSecondary,
              marginBottom: spacing.xs,
            },
          ]}
        >
          {t(
            "session",
            `recording.transcription.status.${transcriptionStatusKey(
              request.queue_status,
            )}`,
          )}
        </Text>
      ) : null}

      {canRequest ? (
        <Button
          testID="session-recording-transcription-button"
          label={buttonLabel}
          variant="secondary"
          loading={requesting}
          disabled={requesting || requestBusy}
          onPress={() => {
            void requestTranscription();
          }}
        />
      ) : null}

      {recording.upload_status !== "synchronized" &&
      recording.upload_status !== "failed" &&
      recording.upload_status !== "cancelled" ? (
        <Text
          testID="session-recording-transcription-waiting-upload"
          style={[
            typography.caption,
            { color: colors.textTertiary, marginTop: spacing.xs },
          ]}
        >
          {t("session", "recording.transcription.waitForUpload")}
        </Text>
      ) : recording.upload_status === "failed" ||
        recording.upload_status === "cancelled" ? (
        <Text
          testID="session-recording-transcription-retry-upload"
          style={[
            typography.caption,
            { color: colors.textTertiary, marginTop: spacing.xs },
          ]}
        >
          {t("session", "recording.transcription.retryUploadFirst")}
        </Text>
      ) : null}

      {request?.last_safe_error ? (
        <Text
          accessibilityRole="alert"
          style={[
            typography.caption,
            { color: colors.recording, marginTop: spacing.xs },
          ]}
        >
          {request.last_safe_error}
        </Text>
      ) : null}

      {error ? (
        <Text
          accessibilityRole="alert"
          style={[
            typography.caption,
            { color: colors.recording, marginTop: spacing.xs },
          ]}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
