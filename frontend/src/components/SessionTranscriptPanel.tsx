import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";

import { useI18n } from "@/src/i18n/I18nProvider";
import { subscribeTranscriptionSyncChanges } from "@/src/services/sync/transcription-sync-events";
import {
  loadLocalTranscriptReadModel,
  type LocalTranscriptReadModel,
} from "@/src/services/transcription/read-model";
import { useTheme } from "@/src/theme/ThemeProvider";

import { Button } from "./Button";
import { Card } from "./Card";

export function SessionTranscriptPanel({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const [model, setModel] = useState<LocalTranscriptReadModel>({ kind: "empty" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (!hasLoadedRef.current) setLoading(true);

    try {
      const nextModel = await loadLocalTranscriptReadModel(sessionId);
      if (requestId !== loadRequestRef.current) return;
      setModel(nextModel);
      setError(null);
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setError(t("session", "transcript.loadFailed"));
    } finally {
      if (requestId === loadRequestRef.current) {
        hasLoadedRef.current = true;
        setLoading(false);
      }
    }
  }, [sessionId, t]);

  useEffect(() => {
    hasLoadedRef.current = false;
    loadRequestRef.current += 1;
    setModel({ kind: "empty" });
    setError(null);
    setLoading(true);

    void load();
    const unsubscribe = subscribeTranscriptionSyncChanges(() => {
      void load();
    });

    return () => {
      loadRequestRef.current += 1;
      unsubscribe();
    };
  }, [load]);

  return (
    <Card
      title={t("session", "transcript.title")}
      testID="session-transcript-panel"
    >
      {loading ? (
        <Text style={[typography.caption, { color: colors.textTertiary }]}>
          {t("common", "status.loading")}
        </Text>
      ) : error && model.kind === "empty" ? (
        <View>
          <Text
            accessibilityRole="alert"
            testID="session-transcript-error"
            style={[typography.caption, { color: colors.recording }]}
          >
            {error}
          </Text>
          <Button
            testID="session-transcript-retry-button"
            label={t("session", "transcript.retry")}
            variant="secondary"
            onPress={() => {
              void load();
            }}
            style={{ marginTop: spacing.sm }}
          />
        </View>
      ) : model.kind === "empty" ? (
        <View>
          <Text
            testID="session-transcript-empty"
            style={[typography.body, { color: colors.textSecondary }]}
          >
            {t("session", "transcript.empty")}
          </Text>
          <Text
            style={[
              typography.caption,
              { color: colors.textTertiary, marginTop: spacing.xs },
            ]}
          >
            {t("session", "transcript.emptyHint")}
          </Text>
        </View>
      ) : (
        <View>
          <Text
            testID="session-transcript-offline-badge"
            style={[typography.caption, { color: colors.success }]}
          >
            {t("session", "transcript.availableOffline")}
          </Text>
          <Text
            testID="session-transcript-metadata"
            style={[
              typography.caption,
              { color: colors.textTertiary, marginTop: spacing.xxs },
            ]}
          >
            {t("session", "transcript.metadata", {
              version: model.version.version,
              count: model.segmentCount,
            })}
          </Text>

          {error ? (
            <Text
              accessibilityRole="alert"
              testID="session-transcript-refresh-error"
              style={[
                typography.caption,
                { color: colors.warning, marginTop: spacing.sm },
              ]}
            >
              {error}
            </Text>
          ) : null}

          <Text
            selectable
            testID="session-transcript-text"
            style={[
              typography.body,
              { color: colors.textPrimary, marginTop: spacing.sm },
            ]}
          >
            {model.plainText || t("session", "transcript.emptyContent")}
          </Text>
        </View>
      )}
    </Card>
  );
}
