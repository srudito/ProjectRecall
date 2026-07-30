import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { sessionsForProject } from "@/src/services/project/project-context";
import {
  fetchProject,
  fetchSessions,
} from "@/src/services/session/service";
import type {
  ProjectRecord,
  SessionRecord,
} from "@/src/services/sqlite/repository";
import { subscribeMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

const supportedSyncStatuses = new Set([
  "local_only",
  "pending",
  "synchronizing",
  "synchronized",
  "failed",
]);

export default function ProjectDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const { colors, typography, spacing } = useTheme();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedProjectIdRef = useRef<string | null>(null);

  const loadProject = useCallback(async () => {
    if (!id) {
      setProject(null);
      setSessions([]);
      setLoading(false);
      return;
    }

    const projectId = String(id);
    const isInitialLoad = loadedProjectIdRef.current !== projectId;
    if (isInitialLoad) {
      setLoading(true);
    }

    try {
      const loadedProject = await fetchProject(projectId);
      setProject(loadedProject);

      if (!loadedProject) {
        setSessions([]);
        return;
      }

      const workspaceSessions = await fetchSessions(
        loadedProject.workspace_id,
      );
      setSessions(
        sessionsForProject(workspaceSessions, loadedProject.id),
      );
    } catch {
      if (isInitialLoad) {
        setProject(null);
      }
      setSessions([]);
    } finally {
      loadedProjectIdRef.current = projectId;
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void loadProject();
    }, [loadProject]),
  );

  useEffect(
    () =>
      subscribeMetadataSyncChanges(() => {
        void loadProject();
      }),
    [loadProject],
  );

  const onBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace("/(tabs)/library");
  };

  const syncStatusLabel = (status: string): string => {
    const key = supportedSyncStatuses.has(status)
      ? status
      : "local_only";
    return t("library", `library.syncStatus.${key}`);
  };

  if (loading) {
    return (
      <Screen testID="project-detail-screen">
        <Text style={[typography.body, { color: colors.textSecondary }]}>
          {t("common", "status.loading")}
        </Text>
      </Screen>
    );
  }

  if (!project) {
    return (
      <Screen testID="project-detail-screen">
        <Text style={[typography.title, { color: colors.textPrimary }]}>
          {t("library", "library.projectDetail.notFound")}
        </Text>
        <Button
          testID="project-back-button"
          label={t("common", "actions.back")}
          variant="ghost"
          onPress={onBack}
          style={{ marginTop: spacing.md }}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="project-detail-screen">
      <FlatList
        data={sessions}
        keyExtractor={(session) => session.id}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: spacing.xl }}
        ListHeaderComponent={
          <View>
            <Button
              testID="project-back-button"
              label={t("common", "actions.back")}
              variant="ghost"
              onPress={onBack}
              style={{ marginBottom: spacing.sm }}
            />
            <Text
              style={[
                typography.title,
                { color: colors.textPrimary },
              ]}
            >
              {project.name}
            </Text>

            <Card
              testID="project-overview"
              style={{ marginTop: spacing.md }}
            >
              <Text
                style={[
                  typography.caption,
                  { color: colors.textTertiary },
                ]}
              >
                {t("library", "library.projectDetail.status")}
              </Text>
              <Text
                style={[
                  typography.bodyMedium,
                  { color: colors.textPrimary },
                ]}
              >
                {project.status === "archived"
                  ? t("library", "library.projectContext.archived")
                  : t("library", "library.projectContext.active")}
              </Text>

              <View style={{ height: spacing.md }} />

              <Text
                style={[
                  typography.caption,
                  { color: colors.textTertiary },
                ]}
              >
                {t("library", "library.projectDetail.description")}
              </Text>
              <Text
                style={[
                  typography.body,
                  { color: colors.textPrimary },
                ]}
              >
                {project.description ||
                  t("library", "library.projectDetail.noDescription")}
              </Text>

              <View style={{ height: spacing.md }} />

              <Text
                style={[
                  typography.caption,
                  { color: colors.textTertiary },
                ]}
              >
                {t("library", "library.projectDetail.sessionCount", {
                  count: sessions.length,
                })}
              </Text>
            </Card>

            <Text
              style={[
                typography.headline,
                {
                  color: colors.textPrimary,
                  marginTop: spacing.lg,
                  marginBottom: spacing.sm,
                },
              ]}
            >
              {t("library", "library.projectDetail.sessions")}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <Text
            testID="project-sessions-empty"
            style={[
              typography.caption,
              { color: colors.textTertiary },
            ]}
          >
            {t("library", "library.projectDetail.empty")}
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            testID={`project-session-${item.id}`}
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: "/session/[id]",
                params: { id: item.id },
              })
            }
          >
            <Card style={{ marginBottom: spacing.sm }}>
              <Text
                style={[
                  typography.bodyMedium,
                  { color: colors.textPrimary },
                ]}
              >
                {item.title}
              </Text>
              <Text
                style={[
                  typography.caption,
                  {
                    color: colors.textTertiary,
                    marginTop: spacing.xxs,
                  },
                ]}
              >
                {formatDurationMs(item.total_recorded_duration_ms)} •{" "}
                {syncStatusLabel(item.local_sync_status)}
              </Text>
            </Card>
          </TouchableOpacity>
        )}
      />
    </Screen>
  );
}
