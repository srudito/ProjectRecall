import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { TimelineEventType } from "@/src/domain/enums";
import { sortTimeline } from "@/src/services/timeline/ordering";
import { deleteSession, getSessionBundle } from "@/src/services/session/service";
import {
  BookmarkRecord,
  MediaAssetRecord,
  NoteRecord,
  SessionRecord,
  TimelineEventRecord,
  getSession,
} from "@/src/services/sqlite/repository";
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
      const b = bookmarks.find((x) => x.id === ev.source_entity_id);
      return `${t("session", "timeline.bookmarkAdded")}: ${b?.label ?? ""}`;
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
  const [tab, setTab] = useState<"overview" | "timeline" | "evidence">("overview");
  const [timeline, setTimeline] = useState<CombinedTimeline[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([]);
  const [assets, setAssets] = useState<MediaAssetRecord[]>([]);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const s = await getSession(String(id));
      setSession(s);
      const bundle = await getSessionBundle(String(id));
      setNotes(bundle.notes);
      setBookmarks(bundle.bookmarks);
      setAssets(bundle.assets);
      const combined = sortTimeline(bundle.timeline).map((ev) => ({
        ...ev,
        label: buildLabel(ev, bundle.notes, bundle.bookmarks, bundle.assets, t),
      }));
      setTimeline(combined);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const onDelete = async () => {
    if (!session) return;
    await deleteSession(session);
    router.replace("/(tabs)/library");
  };

  if (!session) {
    return (
      <Screen testID="session-detail-screen">
        <Text style={[typography.body, { color: colors.textSecondary }]}>{t("common", "status.loading")}</Text>
      </Screen>
    );
  }

  const renderTabs = () => {
    const tabs: Array<{ key: typeof tab; label: string }> = [
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
        <Card testID="session-overview">
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
        </Card>
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
              {assets.map((a) => (
                <View key={a.id} style={{ paddingVertical: spacing.xs }}>
                  <Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>{a.original_file_name}</Text>
                  <Text style={[typography.caption, { color: colors.textTertiary }]}>
                    {a.asset_type} • {formatDurationMs(a.recording_offset_ms)}
                  </Text>
                </View>
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
        onPress={() => router.back()}
      />
    </Screen>
  );
}
