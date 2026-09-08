import { useCallback, useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";

import { useI18n } from "@/src/i18n/I18nProvider";
import { subscribeTranscriptionSyncChanges } from "@/src/services/sync/transcription-sync-events";
import {
  loadLocalTranscriptReadModelWithEvidence,
  type LocalTranscriptReadModelWithEvidence,
  type LocalTranscriptSegmentReadRow,
} from "@/src/services/transcription/read-model";
import { useTheme } from "@/src/theme/ThemeProvider";

import { Button } from "./Button";
import { Card } from "./Card";

type TranscriptViewMode = "continuous" | "segments";

const SEGMENT_BATCH_SIZE = 100;

export function SessionTranscriptPanel({ sessionId, workspaceId, onEdit, editDisabled }: {
  sessionId: string;
  workspaceId?: string;
  onEdit?: () => void;
  editDisabled?: boolean;
}) {
  const { t } = useI18n();
  const { colors, spacing, radii, typography, layout } = useTheme();
  const [model, setModel] = useState<LocalTranscriptReadModelWithEvidence>({ kind: "empty" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] =
    useState<TranscriptViewMode>("continuous");
  const [visibleSegmentCount, setVisibleSegmentCount] =
    useState(SEGMENT_BATCH_SIZE);
  const loadRequestRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (!hasLoadedRef.current) setLoading(true);

    try {
      const nextModel = await loadLocalTranscriptReadModelWithEvidence(sessionId);
      if (requestId !== loadRequestRef.current) return;
      if (nextModel.kind === "ready" && workspaceId && nextModel.version.workspace_id !== workspaceId) {
        throw new Error("Transcript scope changed.");
      }
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
  }, [sessionId, workspaceId, t]);

  useEffect(() => {
    hasLoadedRef.current = false;
    loadRequestRef.current += 1;
    setModel({ kind: "empty" });
    setError(null);
    setLoading(true);
    setViewMode("continuous");
    setVisibleSegmentCount(SEGMENT_BATCH_SIZE);

    void load();
    const unsubscribe = subscribeTranscriptionSyncChanges(() => {
      void load();
    });

    return () => {
      loadRequestRef.current += 1;
      unsubscribe();
    };
  }, [load]);

  const currentVersionId =
    model.kind === "ready" ? model.version.id : null;

  const evidence = model.kind === "ready" ? model.evidence : null;
  const evidenceVersionId = evidence?.kind === "available" ? evidence.version.id : null;
  const ancestor = evidence?.kind === "available" && evidence.source === "ancestor" ? evidence : null;
  // Never relabel provider evidence as segments belonging to an edited version.
  const segmentRows = model.kind !== "ready" ? [] : evidence?.kind === "available"
    ? evidence.segmentRows : model.version.version_origin === "user_edit" ? [] : model.segmentRows;
  const segmentCount = segmentRows.length;
  const segmentsEmptyKey = evidence?.kind === "unavailable" ? "transcript.evidenceUnavailable"
    : model.kind === "ready" && model.version.version_origin === "user_edit" && evidence?.kind === "none"
      ? "transcript.evidenceNone" : "transcript.noTimestampedSegments";

  useEffect(() => {
    setVisibleSegmentCount(SEGMENT_BATCH_SIZE);
  }, [currentVersionId, evidenceVersionId]);

  const renderViewModeButton = (
    mode: TranscriptViewMode,
    label: string,
  ) => {
    const selected = viewMode === mode;
    return (
      <TouchableOpacity
        testID={`session-transcript-view-${mode}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        onPress={() => setViewMode(mode)}
        style={{
          minHeight: layout.minTouchTarget,
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: spacing.sm,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: selected ? colors.accent : colors.border,
          backgroundColor: selected ? colors.accent : colors.surface,
        }}
      >
        <Text
          style={[
            typography.caption,
            { color: selected ? colors.textOnAccent : colors.textPrimary },
          ]}
        >
          {label}
        </Text>
      </TouchableOpacity>
    );
  };

  const segmentDetails = (segment: LocalTranscriptSegmentReadRow): string =>
    [
      segment.speakerLabel
        ? t("session", "transcript.segmentSpeaker", {
            speaker: segment.speakerLabel,
          })
        : null,
      segment.languageCode
        ? t("session", "transcript.segmentLanguage", {
            language: segment.languageCode.toUpperCase(),
          })
        : null,
    ]
      .filter((value): value is string => value != null)
      .join(" • ");

  return (
    <Card
      title={t("session", "transcript.title")}
      testID="session-transcript-panel"
    >
      {onEdit ? <Button testID="session-transcript-edit" label={t("session", "editor.open")}
        variant="secondary" onPress={onEdit} disabled={editDisabled}
        style={{ marginBottom: spacing.sm }} /> : null}
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
            {t("session", ancestor ? "transcript.editedMetadata" : "transcript.metadata", {
              version: model.version.version,
              count: segmentCount,
              sourceVersion: ancestor?.version.version ?? model.version.version,
            })}
          </Text>

          {ancestor ? <Text testID="session-transcript-evidence-provenance"
            style={[typography.caption, { color: colors.textSecondary, marginTop: spacing.xs }]}>
            {t("session", "transcript.evidenceProvenance", { sourceVersion: ancestor.version.version })}
          </Text> : null}

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

          <View
            testID="session-transcript-view-mode"
            style={{
              flexDirection: "row",
              gap: spacing.xs,
              marginTop: spacing.sm,
            }}
          >
            {renderViewModeButton(
              "continuous",
              t("session", "transcript.viewContinuous"),
            )}
            {renderViewModeButton(
              "segments",
              t("session", "transcript.viewTimestamped"),
            )}
          </View>

          {viewMode === "continuous" ? (
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
          ) : segmentRows.length === 0 ? (
            <Text
              testID="session-transcript-segments-empty"
              style={[
                typography.body,
                { color: colors.textSecondary, marginTop: spacing.sm },
              ]}
            >
              {t("session", segmentsEmptyKey)}
            </Text>
          ) : (
            <View
              testID="session-transcript-segment-list"
              style={{ marginTop: spacing.sm }}
            >
              {segmentRows
                .slice(0, visibleSegmentCount)
                .map((segment) => {
                  const details = segmentDetails(segment);
                  return (
                    <View
                      key={segment.id}
                      testID={`session-transcript-segment-${segment.segmentIndex}`}
                      style={{
                        paddingVertical: spacing.sm,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.border,
                      }}
                    >
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "baseline",
                          flexWrap: "wrap",
                          gap: spacing.xs,
                        }}
                      >
                        <Text
                          testID={`session-transcript-segment-time-${segment.segmentIndex}`}
                          style={[
                            typography.caption,
                            {
                              color: colors.accent,
                              fontVariant: ["tabular-nums"],
                            },
                          ]}
                        >
                          {segment.timestampLabel}
                        </Text>
                        {details ? (
                          <Text
                            style={[
                              typography.caption,
                              { color: colors.textTertiary },
                            ]}
                          >
                            {details}
                          </Text>
                        ) : null}
                      </View>
                      <Text
                        selectable
                        testID={`session-transcript-segment-text-${segment.segmentIndex}`}
                        style={[
                          typography.body,
                          { color: colors.textPrimary, marginTop: spacing.xxs },
                        ]}
                      >
                        {segment.text}
                      </Text>
                    </View>
                  );
                })}

              <Text
                testID="session-transcript-segment-progress"
                style={[
                  typography.caption,
                  { color: colors.textTertiary, marginTop: spacing.sm },
                ]}
              >
                {t("session", "transcript.segmentProgress", {
                  shown: Math.min(visibleSegmentCount, segmentCount),
                  total: segmentCount,
                })}
              </Text>

              {visibleSegmentCount < segmentCount ? (
                <Button
                  testID="session-transcript-show-more"
                  label={t("session", "transcript.showMoreSegments")}
                  variant="secondary"
                  onPress={() =>
                    setVisibleSegmentCount((current) =>
                      Math.min(
                        current + SEGMENT_BATCH_SIZE,
                        segmentCount,
                      ),
                    )
                  }
                  style={{ marginTop: spacing.sm }}
                />
              ) : null}
            </View>
          )}
        </View>
      )}
    </Card>
  );
}
