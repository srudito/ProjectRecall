import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { fetchSession, getSessionBundle } from "@/src/services/session/service";
import type { SessionRecord } from "@/src/services/sqlite/repository";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

export default function Review() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [counts, setCounts] = useState({ notes: 0, bookmarks: 0, photos: 0, videos: 0, docs: 0 });

  useEffect(() => {
    (async () => {
      if (!sessionId) return;
      const s = await fetchSession(String(sessionId));
      setSession(s);
      const bundle = await getSessionBundle(String(sessionId));
      setCounts({
        notes: bundle.notes.length,
        bookmarks: bundle.bookmarks.length,
        photos: bundle.assets.filter((a) => a.asset_type === "image").length,
        videos: bundle.assets.filter((a) => a.asset_type === "video").length,
        docs: bundle.assets.filter((a) => a.asset_type === "document").length,
      });
    })();
  }, [sessionId]);

  return (
    <Screen scrollable testID="review-screen">
      <Text style={[typography.title, { color: colors.textPrimary, marginBottom: spacing.md }]}>
        {t("session", "overview.title")}
      </Text>
      <Card testID="review-overview">
        <Text style={[typography.headline, { color: colors.textPrimary }]}>{session?.title}</Text>
        <Text style={[typography.caption, { color: colors.textTertiary }]}>
          {formatDurationMs(session?.total_recorded_duration_ms ?? 0)}
        </Text>
        <View style={{ height: spacing.md }} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
          <Metric label={t("session", "overview.counts.photos")} value={counts.photos} />
          <Metric label={t("session", "overview.counts.videos")} value={counts.videos} />
          <Metric label={t("session", "overview.counts.documents")} value={counts.docs} />
          <Metric label={t("session", "overview.counts.notes")} value={counts.notes} />
          <Metric label={t("session", "overview.counts.bookmarks")} value={counts.bookmarks} />
        </View>
      </Card>
      <View style={{ height: spacing.md }} />
      <Button
        testID="review-open-detail-button"
        label={t("session", "tabs.overview")}
        onPress={() => sessionId && router.push({ pathname: "/session/[id]", params: { id: String(sessionId) } })}
      />
      <Button
        testID="review-go-home-button"
        label={t("common", "actions.done")}
        variant="ghost"
        onPress={() => router.replace("/(tabs)/home")}
      />
    </Screen>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  const { colors, typography } = useTheme();
  return (
    <View style={{ minWidth: 80 }}>
      <Text style={[typography.displayMedium, { color: colors.accent }]}>{value}</Text>
      <Text style={[typography.caption, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}
