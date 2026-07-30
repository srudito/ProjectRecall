import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Screen } from "@/src/components/Screen";
import { SessionEvidenceAsset } from "@/src/components/SessionEvidenceAsset";
import { SessionRecordingPanel } from "@/src/components/SessionRecordingPanel";
import { useI18n } from "@/src/i18n/I18nProvider";
import { TimelineEventType } from "@/src/domain/enums";
import { sortTimeline } from "@/src/services/timeline/ordering";
import {
  deleteSession,
  fetchProject,
  fetchSession,
  getSessionBundle,
  retrySessionSync,
} from "@/src/services/session/service";
import type {
  BookmarkRecord,
  MediaAssetRecord,
  NoteRecord,
  ProjectRecord,
  SessionRecord,
  TimelineEventRecord,
} from "@/src/services/sqlite/repository";
import { subscribeMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

type CombinedTimeline = TimelineEventRecord & { label: string };

const buildLabel = (
  ev: TimelineEventRecord,
  notes: NoteRecord[],
  bookmarks: BookmarkRecord[],
  assets: MediaAssetRecord[],
  t: (ns: any, key: string, opts?: any) => string,
): string => {
  switch (ev.event_type) {
    case TimelineEventType.RECORDING_STARTED:
      return t("session", "timeline.recordingStarted");
    case TimelineEventType.RECORDING_PAUSED:
      return t("session", "timeline.recordingPaused");
    case TimelineEventType.RECORDING_RESUMED:
      return t("session", "timeline.recordingResumed");
    case TimelineEventType.RECORDING_STOPPED:
      return t("session", "timeline.recordingStopped");
    case TimelineEventType.NOTE_ADDED: {
      const n = notes.find((x) => x.id === ev.source_entity_id);
      return `${t("session", "timeline.noteAdded")}: ${n?.text ?? ""}`;
    }
    case TimelineEventType.BOOKMARK_ADDED: {
      const bookmark = bookmarks.find(
        (item) => item.id === ev.source_entity_id,
      );
      const label = bookmark?.label.trim();

      // The default label is already "Bookmark". Returning only the label
      // avoids the redundant "Bookmark: Bookmark" timeline text while still
      // allowing a future custom bookmark name to be displayed directly.
      return label || t("session", "timeline.bookmarkAdded");
    }
    case TimelineEventType.IMAGE_ADDED: {
      const a = assets.find((x) => x.id === ev.source_entity_id);
      return `${t("session", "timeline.imageAdded")}: ${a?.original_file_name ?? ""}`;
    }
    case TimelineEventType.VIDEO_ADDED: {
      const a = assets.find((x) => x.id === ev.source_entity_id);
      return `${t("session", "timeline.videoAdded")}: ${a?.original_file_name ?? ""}`;
    }
    case TimelineEventType.DOCUMENT_ADDED: {
      const a = assets.find((x) => x.id === ev.source_entity_id);
      return `${t("session", "timeline.documentAdded")}: ${a?.original_file_name ?? ""}`;
    }
    default:
      return ev.event_type;
  }
};

export default function SessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [tab, setTab] = useState<"overview" | "timeline" | "evidence">("overview");
  const [timeline, setTimeline] = useState<CombinedTimeline[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([]);
  const [assets, setAssets] = useState<MediaAssetRecord[]>([]);
  const [retryingSync, setRetryingSync] = useState(false);
  const [syncActionError, setSyncActionError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    if (!id) return;
    const sessionId = String(id);
    const loadedSession = await fetchSession(sessionId);
    setSession(loadedSession);

    if (loadedSession?.project_id) {
      setProject(await fetchProject(loadedSession.project_id));
    } else {
      setProject(null);
    }

    const bundle = await getSessionBundle(sessionId);
    setNotes(bundle.notes);
    setBookmarks(bundle.bookmarks);
    setAssets(bundle.assets);
    setTimeline(
      sortTimeline(bundle.timeline).map((event) => ({
        ...event,
        label: buildLabel(
          event,
          bundle.notes,
          bundle.bookmarks,
          bundle.assets,
          t,
        ),
      })),
    );
  }, [id, t]);

  useEffect(() => {
    void loadSession();
    return subscribeMetadataSyncChanges(() => {
      void loadSession();
    });
  }, [loadSession]);

  const onDelete = async () => {
    if (!session) return;
    await deleteSession(session);
    router.replace("/(tabs)/library");
  };

  const onBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace("/(tabs)/library");
  };

const onOpenProject = () => {
  const projectId = session?.project_id;

  if (!projectId) {
    return;
  }

  router.push({
    pathname: "/project/[id]",
    params: {
      id: projectId,
    },
  });
};

  const onRetrySync = async () => {
    if (!session || retryingSync) return;

    setRetryingSync(true);
    setSyncActionError(null);
    try {
      const pending = await retrySessionSync(session);
      setSession(pending);
    } catch {
      setSyncActionError(t("session", "sync.retryFailed"));
    } finally {
      setRetryingSync(false);
    }
  };

  const syncStatusLabel = (status: string): string => {
    const supported = new Set([
      "local_only",
      "pending",
      "synchronizing",
      "synchronized",
      "failed",
    ]);
    const key = supported.has(status) ? status : "local_only";
    return t("library", `library.syncStatus.${key}`);
  };

  if (!session) {
    return (
      <Screen testID="session-detail-screen">
        <Text style={[typography.body, { color: colors.textSecondary }]}>{t("common", "status.loading")}</Text>
      </Screen>
    );
  }

  const renderTabs = () => {
    const tabs: { key: typeof tab; label: string }[] = [
      { key: "overview", label: t("session", "tabs.overview") },
      { key: "timeline", label: t("session", "tabs.timeline") },
      { key: "evidence", label: t("session", "tabs.evidence") },
    ];
    return (
      <View style={{ flexDirection: "row", gap: spacing.xs, marginBottom: spacing.md }}>
        {tabs.map((it) => (
          <TouchableOpacity
            key={it.key}
            testID={`session-tab-${it.key}`}
            onPress={() => setTab(it.key)}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: spacing.sm,
              borderRadius: 12,
              backgroundColor: tab === it.key ? colors.primary : colors.surface,
              borderWidth: 1,
              borderColor: tab === it.key ? colors.primary : colors.border,
            }}
          >
            <Text
              style={[
                typography.bodyMedium,
                { color: tab === it.key ? colors.textOnPrimary : colors.textPrimary },
              ]}
            >
              {it.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  return (
    <Screen scrollable testID="session-detail-screen">
      <Text style={[typography.title, { color: colors.textPrimary, marginBottom: spacing.md }]}>{session.title}</Text>
      {renderTabs()}
      {tab === "overview" ? (
        <>
          <Card testID="session-overview">
          <Text style={[typography.caption, { color: colors.textTertiary }]}>
            {t("session", "overview.project")}
          </Text>
          {session.project_id ? (
            <TouchableOpacity
              testID="session-project-link"
              accessibilityRole="button"
              onPress={onOpenProject}
              style={{ paddingVertical: spacing.xxs }}
            >
              <Text style={[typography.bodyMedium, { color: colors.accent }]}>
                {project?.name ??
                  t("library", "library.projectContext.unknownProject")}
              </Text>
              {project?.status === "archived" ? (
                <Text style={[typography.caption, { color: colors.textTertiary }]}>
                  {t("library", "library.projectContext.archived")}
                </Text>
              ) : null}
            </TouchableOpacity>
          ) : (
            <Text style={[typography.body, { color: colors.textPrimary }]}>
              {t("library", "library.projectContext.noProject")}
            </Text>
          )}
          <View style={{ height: spacing.md }} />
          <Text style={[typography.caption, { color: colors.textTertiary }]}>{t("session", "overview.duration")}</Text>
          <Text style={[typography.headline, { color: colors.textPrimary }]}>
            {formatDurationMs(session.total_recorded_duration_ms)}
          </Text>
          <View style={{ height: spacing.md }} />
          <Text style={[typography.caption, { color: colors.textTertiary }]}>{t("session", "overview.spokenMode")}</Text>
          <Text style={[typography.body, { color: colors.textPrimary }]}>{session.spoken_language_mode}</Text>
          <View style={{ height: spacing.md }} />
          <Text style={[typography.caption, { color: colors.textTertiary }]}>
            {t("session", "overview.expectedLanguages")}
          </Text>
          <Text style={[typography.body, { color: colors.textPrimary }]}>
            {session.expected_spoken_languages.join(", ") || "—"}
          </Text>
          <View style={{ height: spacing.md }} />
          <Text style={[typography.caption, { color: colors.textTertiary }]}>
            {t("session", "sync.details")}
          </Text>
          <Text style={[typography.body, { color: colors.textPrimary }]}>
            {syncStatusLabel(session.local_sync_status)}
          </Text>
          {session.last_sync_error_message ? (
            <Text style={[typography.caption, { color: colors.recording, marginTop: spacing.xs }]}>
              {session.last_sync_error_message}
            </Text>
          ) : null}
          {syncActionError ? (
            <Text
              accessibilityRole="alert"
              style={[
                typography.caption,
                { color: colors.recording, marginTop: spacing.xs },
              ]}
            >
              {syncActionError}
            </Text>
          ) : null}
          {session.local_sync_status === "failed" ? (
            <Button
              testID="session-retry-sync-button"
              label={t("session", "sync.retry")}
              variant="secondary"
              onPress={onRetrySync}
              loading={retryingSync}
              disabled={retryingSync}
              style={{ marginTop: spacing.xs }}
            />
          ) : null}
          </Card>
          <SessionRecordingPanel session={session} />
        </>
      ) : null}

      {tab === "timeline" ? (
        <Card testID="session-timeline">
          {timeline.length === 0 ? (
            <Text style={[typography.caption, { color: colors.textTertiary }]}>{t("session", "timeline.empty")}</Text>
          ) : (
            <ScrollView>
              {timeline.map((ev) => (
                <View
                  key={ev.id}
                  testID={`timeline-event-${ev.id}`}
                  style={{
                    paddingVertical: spacing.xs,
                    borderBottomWidth: 1,
                    borderColor: colors.border,
                    flexDirection: "row",
                    gap: spacing.md,
                  }}
                >
                  <Text style={{ color: colors.accent, fontVariant: ["tabular-nums"], width: 74 }}>
                    {formatDurationMs(ev.recording_offset_ms)}
                  </Text>
                  <Text style={{ color: colors.textPrimary, flex: 1 }}>{ev.label}</Text>
                </View>
              ))}
            </ScrollView>
          )}
        </Card>
      ) : null}

      {tab === "evidence" ? (
        <Card testID="session-evidence">
          {assets.length === 0 && notes.length === 0 && bookmarks.length === 0 ? (
            <Text style={[typography.caption, { color: colors.textTertiary }]}>{t("common", "status.empty")}</Text>
          ) : (
            <>
              {assets.map((asset) => (
                <SessionEvidenceAsset
                  key={asset.id}
                  asset={asset}
                  onUpdated={(updated) => {
                    setAssets((current) =>
                      current.map((item) =>
                        item.id === updated.id ? updated : item,
                      ),
                    );
                  }}
                />
              ))}
              {notes.map((n) => (
                <View key={n.id} style={{ paddingVertical: spacing.xs }}>
                  <Text style={[typography.body, { color: colors.textPrimary }]}>{n.text}</Text>
                  <Text style={[typography.caption, { color: colors.textTertiary }]}>
                    {formatDurationMs(n.recording_offset_ms)}
                  </Text>
                </View>
              ))}
              {bookmarks.map((b) => (
                <View key={b.id} style={{ paddingVertical: spacing.xs }}>
                  <Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>{b.label}</Text>
                  <Text style={[typography.caption, { color: colors.textTertiary }]}>
                    {formatDurationMs(b.recording_offset_ms)}
                  </Text>
                </View>
              ))}
            </>
          )}
        </Card>
      ) : null}

      <View style={{ height: spacing.lg }} />
      <Button
        testID="session-delete-button"
        label={t("session", "actions.delete")}
        variant="danger"
        onPress={onDelete}
      />
      <Button
        testID="session-back-button"
        label={t("common", "actions.back")}
        variant="ghost"
        onPress={onBack}
      />
    </Screen>
  );
}
