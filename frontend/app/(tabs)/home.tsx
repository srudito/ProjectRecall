import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Screen } from "@/src/components/Screen";
import { branding } from "@/src/config/branding";
import { useI18n } from "@/src/i18n/I18nProvider";
import { fetchProjects, fetchSessions } from "@/src/services/session/service";
import type {
  ProjectRecord,
  SessionRecord,
} from "@/src/services/sqlite/repository";
import { subscribeMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { resolvePersonalWorkspace } from "@/src/services/workspace/service";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

const supportedSyncStatuses = new Set([
  "local_only",
  "pending",
  "synchronizing",
  "synchronized",
  "failed",
]);

export default function Home() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const user = useAuthStore((state) => state.user);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);

  const syncStatusLabel = (status: string): string => {
    const key = supportedSyncStatuses.has(status)
      ? status
      : "local_only";
    return t("library", `library.syncStatus.${key}`);
  };

  const loadHomeData = useCallback(async () => {
    if (!user?.id) {
      setProjects([]);
      setSessions([]);
      return;
    }

    try {
      const workspace = await resolvePersonalWorkspace(user.id);
      const [projectRows, sessionRows] = await Promise.all([
        fetchProjects(workspace.id),
        fetchSessions(workspace.id),
      ]);
      setProjects(projectRows);
      setSessions(sessionRows);
    } catch {
      setProjects([]);
      setSessions([]);
    }
  }, [user?.id]);

  useEffect(() => {
    void loadHomeData();
  }, [loadHomeData]);

  useEffect(
    () =>
      subscribeMetadataSyncChanges(() => {
        void loadHomeData();
      }),
    [loadHomeData],
  );

  return (
    <Screen scrollable testID="home-screen">
      <Text style={[typography.overline, { color: colors.accent }]}>
        {branding.productName.toUpperCase()}
      </Text>
      <Text
        style={[
          typography.displayMedium,
          { color: colors.textPrimary, marginTop: spacing.xs },
        ]}
      >
        {t("library", "home.greeting")}
      </Text>
      <Text
        style={[
          typography.body,
          {
            color: colors.textSecondary,
            marginTop: spacing.xs,
            marginBottom: spacing.lg,
          },
        ]}
      >
        {branding.tagline}
      </Text>

      <View
        style={{
          flexDirection: "row",
          gap: spacing.sm,
          marginBottom: spacing.lg,
        }}
      >
        <View style={{ flex: 1 }}>
          <Button
            testID="home-start-recording-button"
            label={t("library", "home.startRecording")}
            variant="accent"
            fullWidth
            onPress={() => router.push("/record/setup")}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            testID="home-create-project-button"
            label={t("library", "home.createProject")}
            variant="secondary"
            fullWidth
            onPress={() => router.push("/(tabs)/library")}
          />
        </View>
      </View>

      <Card
        title={t("library", "home.recentProjects")}
        testID="home-recent-projects"
      >
        {projects.length === 0 ? (
          <Text style={[typography.caption, { color: colors.textTertiary }]}>
            {t("library", "empty.projects")}
          </Text>
        ) : (
          projects.slice(0, 5).map((project) => (
            <View key={project.id} style={{ paddingVertical: spacing.xs }}>
              <Text style={[typography.body, { color: colors.textPrimary }]}>
                {project.name}
              </Text>
              <Text
                style={[typography.caption, { color: colors.textTertiary }]}
              >
                {syncStatusLabel(project.local_sync_status)}
              </Text>
            </View>
          ))
        )}
      </Card>

      <View style={{ height: spacing.md }} />

      <Card
        title={t("library", "home.recentSessions")}
        testID="home-recent-sessions"
      >
        {sessions.length === 0 ? (
          <Text style={[typography.caption, { color: colors.textTertiary }]}>
            {t("library", "empty.sessions")}
          </Text>
        ) : (
          sessions.slice(0, 5).map((session) => (
            <View key={session.id} style={{ paddingVertical: spacing.xs }}>
              <Text
                testID={`home-session-${session.id}`}
                style={[typography.bodyMedium, { color: colors.textPrimary }]}
                onPress={() =>
                  router.push({
                    pathname: "/session/[id]",
                    params: { id: session.id },
                  })
                }
              >
                {session.title}
              </Text>
              <Text
                style={[typography.caption, { color: colors.textTertiary }]}
              >
                {formatDurationMs(session.total_recorded_duration_ms)} •{" "}
                {session.status} • {syncStatusLabel(session.local_sync_status)}
              </Text>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}
