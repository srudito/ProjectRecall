import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";

import { useI18n } from "@/src/i18n/I18nProvider";
import {
  fetchRecordingForSession,
  resolveRecordingPlaybackUri,
  retryRecordingUpload,
} from "@/src/services/session/service";
import type {
  RecordingRecord,
  SessionRecord,
} from "@/src/services/sqlite/repository";
import { subscribeMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

import { Button } from "./Button";
import { Card } from "./Card";
import {
  RecordingTranscriptionRequestControl,
} from "./RecordingTranscriptionRequestControl";

function RecordingAudioPlayer({ uri }: { uri: string }) {
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const player = useAudioPlayer(uri, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);

  const currentSeconds = Number.isFinite(status.currentTime)
    ? status.currentTime
    : 0;
  const durationSeconds = Number.isFinite(status.duration)
    ? status.duration
    : 0;
  const currentMs = Math.max(0, Math.round(currentSeconds * 1000));
  const durationMs = Math.max(0, Math.round(durationSeconds * 1000));

  const togglePlayback = () => {
    if (status.playing) {
      player.pause();
      return;
    }

    if (durationMs > 0 && currentMs >= durationMs - 250) {
      void player.seekTo(0);
    }
    player.play();
  };

  return (
    <View style={{ marginTop: spacing.sm }}>
      <Text
        testID="session-recording-playback-time"
        style={[
          typography.caption,
          {
            color: colors.textSecondary,
            fontVariant: ["tabular-nums"],
            marginBottom: spacing.xs,
          },
        ]}
      >
        {formatDurationMs(currentMs)} / {formatDurationMs(durationMs)}
      </Text>
      <Button
        testID="session-recording-play-pause-button"
        label={
          status.playing
            ? t("session", "playback.pause")
            : t("session", "playback.play")
        }
        variant="secondary"
        onPress={togglePlayback}
      />
    </View>
  );
}

const recordingStatusKey = (status: string): string => {
  const supported = new Set([
    "local_only",
    "pending",
    "uploading",
    "synchronized",
    "failed",
    "cancelled",
  ]);
  return supported.has(status) ? status : "local_only";
};

export function SessionRecordingPanel({ session }: { session: SessionRecord }) {
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const [recording, setRecording] = useState<RecordingRecord | null>(null);
  const [playbackUri, setPlaybackUri] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;

    if (!hasLoadedRef.current) {
      setInitialLoading(true);
    }

    try {
      const next = await fetchRecordingForSession(session.id);

      if (requestId !== loadRequestRef.current) {
        return;
      }

      setRecording(next);
      setError(null);

      if (!next) {
        setPlaybackUri(null);
        return;
      }

      try {
        const nextPlaybackUri = await resolveRecordingPlaybackUri(next);

        if (requestId === loadRequestRef.current) {
          setPlaybackUri(nextPlaybackUri);
        }
      } catch (cause) {
        if (requestId === loadRequestRef.current) {
          // Keep the recording metadata visible while playback resolution is
          // retried. Only the playback control is unavailable.
          setPlaybackUri(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    } catch (cause) {
      if (requestId === loadRequestRef.current) {
        // A background refresh failure must not collapse content that was
        // already rendered; doing so moves the action buttons up and down.
        if (!hasLoadedRef.current) {
          setRecording(null);
          setPlaybackUri(null);
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        hasLoadedRef.current = true;
        setInitialLoading(false);
      }
    }
  }, [session.id]);

  useEffect(() => {
    hasLoadedRef.current = false;
    loadRequestRef.current += 1;
    setInitialLoading(true);
    setRecording(null);
    setPlaybackUri(null);
    setError(null);

    void load();

    const unsubscribe = subscribeMetadataSyncChanges(() => {
      // Refresh in place. Do not replace the panel with a compact loading
      // placeholder for every Pending -> Uploading -> Synchronized event.
      void load();
    });

    return () => {
      // Invalidate an in-flight request before the component unmounts or the
      // session changes, then remove the metadata-sync subscription.
      loadRequestRef.current += 1;
      unsubscribe();
    };
  }, [load]);

  const retry = async () => {
    if (!recording || !userId || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const pending = await retryRecordingUpload({ recording, userId });
      setRecording(pending);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetrying(false);
    }
  };

  const statusColor =
    recording?.upload_status === "synchronized"
      ? colors.success
      : recording?.upload_status === "failed"
        ? colors.recording
        : colors.warning;

  return (
    <Card
      title={t("session", "recording.title")}
      testID="session-recording-panel"
      style={{ marginTop: spacing.md }}
    >
      {initialLoading ? (
        <View
          style={{
            minHeight: 144,
            justifyContent: "center",
          }}
        >
          <Text style={[typography.caption, { color: colors.textTertiary }]}>
            {t("common", "status.loading")}
          </Text>
        </View>
      ) : recording ? (
        <>
          <Text
            style={[
              typography.bodyMedium,
              { color: colors.textPrimary },
            ]}
          >
            {recording.original_file_name}
          </Text>
          <Text
            testID="session-recording-upload-status"
            style={[
              typography.caption,
              { color: statusColor, marginTop: spacing.xxs },
            ]}
          >
            {t(
              "session",
              `recording.status.${recordingStatusKey(recording.upload_status)}`,
            )}
          </Text>
          <Text
            style={[
              typography.caption,
              { color: colors.textTertiary, marginTop: spacing.xxs },
            ]}
          >
            {formatDurationMs(recording.duration_ms)}
          </Text>

          {playbackUri ? <RecordingAudioPlayer uri={playbackUri} /> : null}

          {!playbackUri && recording.upload_status === "synchronized" ? (
            <Text
              style={[
                typography.caption,
                { color: colors.textTertiary, marginTop: spacing.sm },
              ]}
            >
              {t("session", "recording.playbackUnavailable")}
            </Text>
          ) : null}

          <RecordingTranscriptionRequestControl
            session={session}
            recording={recording}
          />

          {recording.upload_error_message ? (
            <Text
              accessibilityRole="alert"
              style={[
                typography.caption,
                { color: colors.recording, marginTop: spacing.sm },
              ]}
            >
              {recording.upload_error_message}
            </Text>
          ) : null}

          {recording.upload_status === "failed" &&
          Platform.OS !== "web" &&
          recording.local_file_uri ? (
            <Button
              testID="session-recording-retry-button"
              label={t("session", "recording.retry")}
              variant="secondary"
              loading={retrying}
              disabled={retrying}
              onPress={() => {
                void retry();
              }}
              style={{ marginTop: spacing.sm }}
            />
          ) : null}
        </>
      ) : (
        <Text style={[typography.caption, { color: colors.textTertiary }]}>
          {t("session", "recording.empty")}
        </Text>
      )}

      {error ? (
        <Text
          accessibilityRole="alert"
          style={[
            typography.caption,
            { color: colors.recording, marginTop: spacing.sm },
          ]}
        >
          {error}
        </Text>
      ) : null}
    </Card>
  );
}
