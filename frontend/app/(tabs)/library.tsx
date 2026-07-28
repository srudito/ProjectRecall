import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Field } from "@/src/components/Field";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import {
  createProject,
  fetchProjects,
  fetchSessions,
  retryProjectSync,
} from "@/src/services/session/service";
import type {
  ProjectRecord,
  SessionRecord,
} from "@/src/services/sqlite/repository";
import { subscribeMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { resolvePersonalWorkspace } from "@/src/services/workspace/service";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

type Tab = "projects" | "sessions";

type Filter =
  | "all"
  | "localOnly"
  | "pending"
  | "syncing"
  | "synced"
  | "failed";

const FILTER_TO_STATUS: Record<Filter, string | null> = {
  all: null,
  localOnly: "local_only",
  pending: "pending",
  syncing: "synchronizing",
  synced: "synchronized",
  failed: "failed",
};

export default function Library() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography, radii } = useTheme();
  const user = useAuthStore((state) => state.user);

  const [tab, setTab] = useState<Tab>("projects");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  const [submittingProject, setSubmittingProject] = useState(false);
  const [retryingProjectId, setRetryingProjectId] = useState<string | null>(
    null,
  );
  const [projectError, setProjectError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const projectSubmitInFlight = useRef(false);
  const projectRetryInFlight = useRef(false);

  const refresh = useCallback(async () => {
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
      setProjectError(t("library", "library.projectLoadFailed"));
    }
  }, [t, user?.id]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  useEffect(() => {
    return subscribeMetadataSyncChanges(() => {
      void refresh();
    });
  }, [refresh]);

  const filteredSessions = sessions.filter((session) => {
    const selectedStatus = FILTER_TO_STATUS[filter];

    const passesFilter =
      selectedStatus === null
        ? true
        : session.local_sync_status === selectedStatus;

    const normalizedQuery = query.trim().toLowerCase();

    const passesSearch =
      normalizedQuery.length === 0
        ? true
        : session.title.toLowerCase().includes(normalizedQuery);

    return passesFilter && passesSearch;
  });

  const submitNewProject = async () => {
    const projectName = newName.trim();

    if (!user?.id) {
      setProjectError(t("library", "library.authenticationRequired"));
      return;
    }
    if (!projectName || projectSubmitInFlight.current) return;

    projectSubmitInFlight.current = true;
    setSubmittingProject(true);
    setProjectError(null);

    try {
      const workspace = await resolvePersonalWorkspace(user.id);
      const project = await createProject({
        workspaceId: workspace.id,
        createdBy: user.id,
        name: projectName,
      });

      setProjects((current) => {
        const withoutDuplicate = current.filter((item) => item.id !== project.id);
        return [project, ...withoutDuplicate];
      });
      setNewName("");
      setCreatingProject(false);
      await refresh();
    } catch {
      setProjectError(t("library", "library.projectCreateFailed"));
    } finally {
      projectSubmitInFlight.current = false;
      setSubmittingProject(false);
    }
  };

  const retryFailedProject = async (project: ProjectRecord) => {
    if (projectRetryInFlight.current) return;

    projectRetryInFlight.current = true;
    setRetryingProjectId(project.id);
    setProjectError(null);
    try {
      const pending = await retryProjectSync(project);
      setProjects((current) =>
        current.map((item) => (item.id === pending.id ? pending : item)),
      );
    } catch {
      setProjectError(t("library", "library.projectRetryFailed"));
    } finally {
      projectRetryInFlight.current = false;
      setRetryingProjectId(null);
    }
  };

  const syncStatusLabel = (status: string): string => {
    const supported = [
      "local_only",
      "pending",
      "synchronizing",
      "synchronized",
      "failed",
    ];
    const key = supported.includes(status) ? status : "local_only";
    return t("library", `library.syncStatus.${key}`);
  };

  const renderTabs = () => {
    const items: { key: Tab; label: string }[] = [
      {
        key: "projects",
        label: t("library", "library.tabs.projects"),
      },
      {
        key: "sessions",
        label: t("library", "library.tabs.sessions"),
      },
    ];

    return (
      <View
        style={{
          flexDirection: "row",
          gap: spacing.xs,
          marginBottom: spacing.md,
        }}
      >
        {items.map((item) => {
          const selected = tab === item.key;

          return (
            <TouchableOpacity
              key={item.key}
              testID={`library-tab-${item.key}`}
              onPress={() => setTab(item.key)}
              style={{
                flex: 1,
                alignItems: "center",
                paddingVertical: spacing.sm,
                borderRadius: radii.md,
                backgroundColor: selected
                  ? colors.primary
                  : colors.surface,
                borderWidth: 1,
                borderColor: selected
                  ? colors.primary
                  : colors.border,
              }}
            >
              <Text
                style={[
                  typography.bodyMedium,
                  {
                    color: selected
                      ? colors.textOnPrimary
                      : colors.textPrimary,
                  },
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  const renderFilters = () => {
    const items: { key: Filter; label: string }[] = [
      {
        key: "all",
        label: t("library", "library.filters.all"),
      },
      {
        key: "localOnly",
        label: t("library", "library.filters.localOnly"),
      },
      {
        key: "pending",
        label: t("library", "library.filters.pending"),
      },
      {
        key: "syncing",
        label: t("library", "library.filters.syncing"),
      },
      {
        key: "synced",
        label: t("library", "library.filters.synced"),
      },
      {
        key: "failed",
        label: t("library", "library.filters.failed"),
      },
    ];

    return (
      <FlatList
        horizontal
        data={items}
        keyExtractor={(item) => item.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: spacing.xxs,
          gap: spacing.xs,
          paddingVertical: 8,
        }}
        renderItem={({ item }) => {
          const selected = filter === item.key;

          return (
            <TouchableOpacity
              testID={`library-filter-${item.key}`}
              onPress={() => setFilter(item.key)}
              style={{
                paddingHorizontal: spacing.md,
                paddingVertical: 8,
                borderRadius: 20,
                borderWidth: 1,
                borderColor: selected
                  ? colors.accent
                  : colors.border,
                backgroundColor: selected
                  ? colors.accent
                  : colors.surface,
                flexShrink: 0,
                height: 36,
                justifyContent: "center",
              }}
            >
              <Text
                style={[
                  typography.caption,
                  {
                    color: selected
                      ? "#fff"
                      : colors.textPrimary,
                    fontWeight: "500",
                  },
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          );
        }}
        style={{ height: 56 }}
      />
    );
  };

  return (
    <Screen testID="library-screen">
      <Text
        style={[
          typography.displayMedium,
          {
            color: colors.textPrimary,
            marginBottom: spacing.md,
          },
        ]}
      >
        {t("library", "library.title")}
      </Text>

      {renderTabs()}

      {tab === "projects" ? (
        <View style={{ flex: 1 }}>
          <Button
            testID="library-create-project-button"
            label={t("library", "library.createProject")}
            onPress={() => {
              setProjectError(null);
              setCreatingProject(true);
            }}
          />

          {creatingProject ? (
            <View style={{ marginTop: spacing.md }}>
              <Field
                testID="library-new-project-name-input"
                label={t("common", "labels.project")}
                placeholder="Project name"
                value={newName}
                onChangeText={setNewName}
                autoFocus
              />

              <Button
                testID="library-new-project-submit-button"
                label={t("common", "actions.save")}
                onPress={submitNewProject}
                loading={submittingProject}
                disabled={!newName.trim()}
              />

              <Button
                testID="library-new-project-cancel-button"
                label={t("common", "actions.cancel")}
                variant="ghost"
                onPress={() => {
                  setProjectError(null);
                  setCreatingProject(false);
                }}
                disabled={submittingProject}
              />
            </View>
          ) : null}

          {projectError ? (
            <Text
              testID="library-project-error"
              accessibilityRole="alert"
              style={[
                typography.caption,
                { color: colors.recording, marginTop: spacing.sm },
              ]}
            >
              {projectError}
            </Text>
          ) : null}

          <View style={{ marginTop: spacing.md }}>
            {projects.length === 0 ? (
              <Text
                style={[
                  typography.caption,
                  { color: colors.textTertiary },
                ]}
              >
                {t("library", "empty.projects")}
              </Text>
            ) : (
              projects.map((project) => (
                <Card
                  key={project.id}
                  testID={`library-project-${project.id}`}
                  style={{ marginBottom: spacing.sm }}
                >
                  <Text
                    style={[
                      typography.bodyMedium,
                      { color: colors.textPrimary },
                    ]}
                  >
                    {project.name}
                  </Text>

                  {project.description ? (
                    <Text
                      style={[
                        typography.caption,
                        {
                          color: colors.textTertiary,
                          marginTop: spacing.xxs,
                        },
                      ]}
                    >
                      {project.description}
                    </Text>
                  ) : null}
                  <Text
                    testID={`library-project-sync-${project.id}`}
                    style={[
                      typography.caption,
                      {
                        color:
                          project.local_sync_status === "failed"
                            ? colors.recording
                            : project.local_sync_status === "synchronized"
                              ? colors.success
                              : colors.textTertiary,
                        marginTop: spacing.xxs,
                      },
                    ]}
                  >
                    {syncStatusLabel(project.local_sync_status)}
                  </Text>
                  {project.local_sync_status === "failed" ? (
                    <Button
                      testID={`library-project-retry-${project.id}`}
                      label={t("library", "library.retrySync")}
                      variant="ghost"
                      onPress={() => {
                        void retryFailedProject(project);
                      }}
                      loading={retryingProjectId === project.id}
                      disabled={retryingProjectId !== null}
                      style={{ marginTop: spacing.xs }}
                    />
                  ) : null}
                </Card>
              ))
            )}
          </View>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <Field
            testID="library-search-input"
            placeholder={t("library", "library.search")}
            value={query}
            onChangeText={setQuery}
          />

          {renderFilters()}

          <FlatList
            data={filteredSessions}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{
              paddingTop: spacing.sm,
              paddingBottom: spacing.xl,
            }}
            ListEmptyComponent={
              <Text
                style={[
                  typography.caption,
                  { color: colors.textTertiary },
                ]}
              >
                {t("library", "empty.sessions")}
              </Text>
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                testID={`library-session-${item.id}`}
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
                    {formatDurationMs(
                      item.total_recorded_duration_ms,
                    )}{" "}
                    • {syncStatusLabel(item.local_sync_status)}
                  </Text>
                </Card>
              </TouchableOpacity>
            )}
          />
        </View>
      )}
    </Screen>
  );
}