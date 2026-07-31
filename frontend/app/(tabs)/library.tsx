import { useFocusEffect, useRouter } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  SectionList,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type SectionListData,
} from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Field } from "@/src/components/Field";
import { LibraryOrganizationToolbar } from "@/src/components/LibraryOrganizationToolbar";
import type { LibrarySortOption } from "@/src/components/LibraryOrganizationToolbar";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import {
  buildProjectStats,
  buildSessionSections,
  formatLibraryDateTime,
  isLibraryViewMode,
  isProjectSortMode,
  isSessionSortMode,
  LIBRARY_PREFERENCE_KEYS,
  sessionDisplayTimestamp,
  sortProjects,
  type LibraryViewMode,
  type ProjectSortMode,
  type SessionDateGroupKey,
  type SessionSortMode,
} from "@/src/services/library/library-organization";
import {
  buildProjectLookup,
  mergeProjectReferences,
  projectDisplayNameForSession,
  referencedProjectIds,
} from "@/src/services/project/project-context";
import {
  createProject,
  fetchProjectReferences,
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
import { storage } from "@/src/utils/storage";

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
  const { t, language } = useI18n();
  const { colors, spacing, typography, radii } = useTheme();
  const user = useAuthStore((state) => state.user);

  const [tab, setTab] = useState<Tab>("projects");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectReferences, setProjectReferences] = useState<ProjectRecord[]>(
    [],
  );
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  const [submittingProject, setSubmittingProject] = useState(false);
  const [retryingProjectId, setRetryingProjectId] = useState<string | null>(
    null,
  );
  const [projectError, setProjectError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const [sessionViewMode, setSessionViewMode] =
    useState<LibraryViewMode>("card");
  const [sessionSortMode, setSessionSortMode] =
    useState<SessionSortMode>("newest");
  const [projectViewMode, setProjectViewMode] =
    useState<LibraryViewMode>("card");
  const [projectSortMode, setProjectSortMode] =
    useState<ProjectSortMode>("recent");

  const projectSubmitInFlight = useRef(false);
  const projectRetryInFlight = useRef(false);

  useEffect(() => {
    let active = true;

    void (async () => {
      const [
        storedSessionView,
        storedSessionSort,
        storedProjectView,
        storedProjectSort,
      ] = await Promise.all([
        storage.getItem<string>(
          LIBRARY_PREFERENCE_KEYS.sessionViewMode,
          "card",
        ),
        storage.getItem<string>(
          LIBRARY_PREFERENCE_KEYS.sessionSortMode,
          "newest",
        ),
        storage.getItem<string>(
          LIBRARY_PREFERENCE_KEYS.projectViewMode,
          "card",
        ),
        storage.getItem<string>(
          LIBRARY_PREFERENCE_KEYS.projectSortMode,
          "recent",
        ),
      ]);

      if (!active) return;

      if (isLibraryViewMode(storedSessionView)) {
        setSessionViewMode(storedSessionView);
      }
      if (isSessionSortMode(storedSessionSort)) {
        setSessionSortMode(storedSessionSort);
      }
      if (isLibraryViewMode(storedProjectView)) {
        setProjectViewMode(storedProjectView);
      }
      if (isProjectSortMode(storedProjectSort)) {
        setProjectSortMode(storedProjectSort);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const updateSessionViewMode = useCallback((mode: LibraryViewMode) => {
    setSessionViewMode(mode);
    void storage.setItem(LIBRARY_PREFERENCE_KEYS.sessionViewMode, mode);
  }, []);

  const updateSessionSortMode = useCallback((value: string) => {
    if (!isSessionSortMode(value)) return;
    setSessionSortMode(value);
    void storage.setItem(LIBRARY_PREFERENCE_KEYS.sessionSortMode, value);
  }, []);

  const updateProjectViewMode = useCallback((mode: LibraryViewMode) => {
    setProjectViewMode(mode);
    void storage.setItem(LIBRARY_PREFERENCE_KEYS.projectViewMode, mode);
  }, []);

  const updateProjectSortMode = useCallback((value: string) => {
    if (!isProjectSortMode(value)) return;
    setProjectSortMode(value);
    void storage.setItem(LIBRARY_PREFERENCE_KEYS.projectSortMode, value);
  }, []);

  const refresh = useCallback(async () => {
    if (!user?.id) {
      setProjects([]);
      setProjectReferences([]);
      setSessions([]);
      setProjectError(null);
      return;
    }

    try {
      const workspace = await resolvePersonalWorkspace(user.id);

      const [projectRows, sessionRows] = await Promise.all([
        fetchProjects(workspace.id),
        fetchSessions(workspace.id),
      ]);

      setProjects(projectRows);
      setProjectReferences(projectRows);
      setSessions(sessionRows);

      const activeProjectIds = new Set(
        projectRows.map((project) => project.id),
      );
      const missingReferenceIds = referencedProjectIds(sessionRows).filter(
        (projectId) => !activeProjectIds.has(projectId),
      );

      if (missingReferenceIds.length > 0) {
        const referenceRows = await fetchProjectReferences(
          missingReferenceIds,
        );
        setProjectReferences(
          mergeProjectReferences(projectRows, referenceRows),
        );
      }
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

  const projectLookup = useMemo(
    () => buildProjectLookup(projectReferences),
    [projectReferences],
  );

  const projectNameForSession = useCallback(
    (session: SessionRecord): string =>
      projectDisplayNameForSession(session, projectLookup, {
        noProject: t("library", "library.projectContext.noProject"),
        unknownProject: t(
          "library",
          "library.projectContext.unknownProject",
        ),
        archived: t("library", "library.projectContext.archived"),
      }),
    [projectLookup, t],
  );

  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const selectedStatus = FILTER_TO_STATUS[filter];

    return sessions.filter((session) => {
      const passesFilter =
        selectedStatus === null ||
        session.local_sync_status === selectedStatus;
      const projectName = projectNameForSession(session).toLowerCase();
      const passesSearch =
        normalizedQuery.length === 0 ||
        session.title.toLowerCase().includes(normalizedQuery) ||
        projectName.includes(normalizedQuery);

      return passesFilter && passesSearch;
    });
  }, [filter, projectNameForSession, query, sessions]);

  const sessionSections = useMemo(
    () =>
      buildSessionSections(
        filteredSessions,
        sessionSortMode,
        language,
      ),
    [filteredSessions, language, sessionSortMode],
  );

  const projectStats = useMemo(
    () => buildProjectStats(projects, sessions),
    [projects, sessions],
  );

  const sortedProjects = useMemo(
    () =>
      sortProjects(
        projects,
        projectSortMode,
        projectStats,
        language,
      ),
    [language, projectSortMode, projectStats, projects],
  );

  const sessionSortOptions = useMemo<LibrarySortOption[]>(
    () => [
      {
        value: "newest",
        label: t("library", "library.organization.sessionSort.newest"),
      },
      {
        value: "oldest",
        label: t("library", "library.organization.sessionSort.oldest"),
      },
      {
        value: "longest",
        label: t("library", "library.organization.sessionSort.longest"),
      },
      {
        value: "shortest",
        label: t("library", "library.organization.sessionSort.shortest"),
      },
    ],
    [t],
  );

  const projectSortOptions = useMemo<LibrarySortOption[]>(
    () => [
      {
        value: "recent",
        label: t("library", "library.organization.projectSort.recent"),
      },
      {
        value: "newest",
        label: t("library", "library.organization.projectSort.newest"),
      },
      {
        value: "name",
        label: t("library", "library.organization.projectSort.name"),
      },
    ],
    [t],
  );

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
        const withoutDuplicate = current.filter(
          (item) => item.id !== project.id,
        );
        return [project, ...withoutDuplicate];
      });
      setProjectReferences((current) =>
        mergeProjectReferences(current, [project]),
      );
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

  const syncStatusColor = (status: string): string => {
    switch (status) {
      case "synchronized":
        return colors.success;
      case "pending":
      case "synchronizing":
        return colors.warning;
      case "failed":
        return colors.recording;
      default:
        return colors.textTertiary;
    }
  };

  const dateGroupLabel = (key: SessionDateGroupKey): string => {
    if (key === "all") return "";
    return t("library", `library.organization.dateGroups.${key}`);
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
                backgroundColor: selected ? colors.primary : colors.surface,
                borderWidth: 1,
                borderColor: selected ? colors.primary : colors.border,
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
      { key: "all", label: t("library", "library.filters.all") },
      {
        key: "localOnly",
        label: t("library", "library.filters.localOnly"),
      },
      { key: "pending", label: t("library", "library.filters.pending") },
      { key: "syncing", label: t("library", "library.filters.syncing") },
      { key: "synced", label: t("library", "library.filters.synced") },
      { key: "failed", label: t("library", "library.filters.failed") },
    ];

    return (
      <View
        style={{
          height: 56,
          minHeight: 56,
          maxHeight: 56,
          flexGrow: 0,
          flexShrink: 0,
        }}
      >
        <FlatList
          horizontal
          data={items}
          keyExtractor={(item: { key: Filter; label: string }) => item.key}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{
            paddingHorizontal: spacing.xxs,
            paddingVertical: 8,
            gap: spacing.xs,
            alignItems: "center",
          }}
          renderItem={({ item }: ListRenderItemInfo<{ key: Filter; label: string }>) => {
            const selected = filter === item.key;

            return (
              <TouchableOpacity
                testID={`library-filter-${item.key}`}
                onPress={() => setFilter(item.key)}
                style={{
                  paddingHorizontal: spacing.md,
                  height: 36,
                  borderRadius: 20,
                  borderWidth: 1,
                  borderColor: selected ? colors.accent : colors.border,
                  backgroundColor: selected ? colors.accent : colors.surface,
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Text
                  style={[
                    typography.caption,
                    {
                      color: selected ? colors.textOnAccent : colors.textPrimary,
                      fontWeight: "500",
                    },
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>
    );
  };

  const renderProject = ({ item }: { item: ProjectRecord }) => {
    const isRetrying = retryingProjectId === item.id;
    const retryInProgress = retryingProjectId !== null;
    const syncFailed = item.local_sync_status === "failed";
    const stats = projectStats.get(item.id);
    const sessionCount = stats?.sessionCount ?? 0;
    const lastActivityAt = stats?.lastActivityAt ?? item.updated_at;
    const lastActivity = formatLibraryDateTime(lastActivityAt, language);

    if (projectViewMode === "compact") {
      return (
        <Card
          style={{
            marginBottom: spacing.xs,
            padding: spacing.sm,
            borderRadius: radii.md,
          }}
        >
          <TouchableOpacity
            testID={`library-project-${item.id}`}
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: "/project/[id]",
                params: { id: item.id },
              })
            }
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: spacing.sm,
              }}
            >
              <Text
                numberOfLines={1}
                style={[
                  typography.bodyMedium,
                  { color: colors.textPrimary, flex: 1 },
                ]}
              >
                {item.name}
              </Text>
              <Text
                style={[typography.caption, { color: colors.textSecondary }]}
              >
                {t("library", "library.organization.sessionCount", {
                  count: sessionCount,
                })}
              </Text>
            </View>

            <Text
              numberOfLines={1}
              style={[
                typography.caption,
                { color: colors.textTertiary, marginTop: spacing.xxs },
              ]}
            >
              {t("library", "library.organization.lastActivity", {
                date: lastActivity,
              })}
              {" • "}
              {syncStatusLabel(item.local_sync_status)}
            </Text>
          </TouchableOpacity>

          {syncFailed ? (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                testID={`library-project-retry-${item.id}`}
                label={t("library", "library.retrySync")}
                variant="secondary"
                loading={isRetrying}
                disabled={retryInProgress}
                onPress={() => {
                  void retryFailedProject(item);
                }}
              />
            </View>
          ) : null}
        </Card>
      );
    }

    return (
      <Card style={{ marginBottom: spacing.sm }}>
        <TouchableOpacity
          testID={`library-project-${item.id}`}
          accessibilityRole="button"
          onPress={() =>
            router.push({
              pathname: "/project/[id]",
              params: { id: item.id },
            })
          }
        >
          <Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>
            {item.name}
          </Text>

          {item.description ? (
            <Text
              style={[
                typography.caption,
                { color: colors.textTertiary, marginTop: spacing.xxs },
              ]}
            >
              {item.description}
            </Text>
          ) : null}

          <Text
            style={[
              typography.caption,
              { color: colors.textSecondary, marginTop: spacing.xs },
            ]}
          >
            {t("library", "library.organization.sessionCount", {
              count: sessionCount,
            })}
          </Text>

          <Text
            style={[
              typography.caption,
              { color: colors.textTertiary, marginTop: spacing.xxs },
            ]}
          >
            {t("library", "library.organization.lastActivity", {
              date: lastActivity,
            })}
          </Text>
        </TouchableOpacity>

        <Text
          testID={`library-project-sync-status-${item.id}`}
          style={[
            typography.caption,
            {
              color: syncStatusColor(item.local_sync_status),
              marginTop: spacing.xs,
            },
          ]}
        >
          {syncStatusLabel(item.local_sync_status)}
        </Text>

        {syncFailed ? (
          <View style={{ marginTop: spacing.sm }}>
            <Button
              testID={`library-project-retry-${item.id}`}
              label={t("library", "library.retrySync")}
              variant="secondary"
              loading={isRetrying}
              disabled={retryInProgress}
              onPress={() => {
                void retryFailedProject(item);
              }}
            />
          </View>
        ) : null}
      </Card>
    );
  };

  const renderSession = ({ item }: { item: SessionRecord }) => {
    const projectName = projectNameForSession(item);
    const recordedAt = formatLibraryDateTime(
      sessionDisplayTimestamp(item),
      language,
    );
    const duration = formatDurationMs(item.total_recorded_duration_ms);
    const status = syncStatusLabel(item.local_sync_status);

    if (sessionViewMode === "compact") {
      return (
        <TouchableOpacity
          testID={`library-session-${item.id}`}
          onPress={() =>
            router.push({
              pathname: "/session/[id]",
              params: { id: item.id },
            })
          }
        >
          <Card
            style={{
              marginBottom: spacing.xs,
              padding: spacing.sm,
              borderRadius: radii.md,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: spacing.sm,
              }}
            >
              <Text
                numberOfLines={1}
                style={[
                  typography.bodyMedium,
                  { color: colors.textPrimary, flex: 1 },
                ]}
              >
                {item.title}
              </Text>
              <Text
                style={[typography.caption, { color: colors.textSecondary }]}
              >
                {duration}
              </Text>
            </View>

            <Text
              numberOfLines={1}
              style={[
                typography.caption,
                { color: colors.textTertiary, marginTop: spacing.xxs },
              ]}
            >
              {projectName} • {recordedAt} • {status}
            </Text>
          </Card>
        </TouchableOpacity>
      );
    }

    return (
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
          <Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>
            {item.title}
          </Text>

          <Text
            testID={`library-session-project-${item.id}`}
            style={[
              typography.caption,
              { color: colors.textSecondary, marginTop: spacing.xxs },
            ]}
          >
            {t("library", "library.projectContext.sessionProject", {
              name: projectName,
            })}
          </Text>

          <Text
            style={[
              typography.caption,
              { color: colors.textTertiary, marginTop: spacing.xs },
            ]}
          >
            {recordedAt} • {duration}
          </Text>

          <Text
            style={[
              typography.caption,
              {
                color: syncStatusColor(item.local_sync_status),
                marginTop: spacing.xxs,
              },
            ]}
          >
            {status}
          </Text>
        </Card>
      </TouchableOpacity>
    );
  };

  return (
    <Screen testID="library-screen">
      <Text
        style={[
          typography.displayMedium,
          { color: colors.textPrimary, marginBottom: spacing.md },
        ]}
      >
        {t("library", "library.title")}
      </Text>

      {renderTabs()}

      {tab === "projects" ? (
        <FlatList
          data={sortedProjects}
          keyExtractor={(item: ProjectRecord) => item.id}
          extraData={`${retryingProjectId ?? ""}:${projectViewMode}:${projectSortMode}`}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingTop: spacing.xs,
            paddingBottom: spacing.xl,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <View style={{ marginBottom: spacing.sm }}>
              <Button
                testID="library-create-project-button"
                label={t("library", "library.createProject")}
                disabled={submittingProject}
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
                    onChangeText={(value: string) => {
                      setNewName(value);
                      if (projectError) setProjectError(null);
                    }}
                    autoFocus
                  />

                  <Button
                    testID="library-new-project-submit-button"
                    label={t("common", "actions.save")}
                    loading={submittingProject}
                    disabled={
                      submittingProject || newName.trim().length === 0
                    }
                    onPress={() => {
                      void submitNewProject();
                    }}
                  />

                  <Button
                    testID="library-new-project-cancel-button"
                    label={t("common", "actions.cancel")}
                    variant="ghost"
                    disabled={submittingProject}
                    onPress={() => {
                      setProjectError(null);
                      setNewName("");
                      setCreatingProject(false);
                    }}
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
                <LibraryOrganizationToolbar
                  testIDPrefix="library-projects"
                  viewMode={projectViewMode}
                  onViewModeChange={updateProjectViewMode}
                  sortValue={projectSortMode}
                  sortOptions={projectSortOptions}
                  onSortChange={updateProjectSortMode}
                  sortButtonLabel={t("library", "library.organization.sort")}
                  sortSheetTitle={t(
                    "library",
                    "library.organization.sortProjects",
                  )}
                  cardViewLabel={t(
                    "library",
                    "library.organization.cardView",
                  )}
                  compactViewLabel={t(
                    "library",
                    "library.organization.compactView",
                  )}
                  closeLabel={t("common", "actions.close")}
                />
              </View>
            </View>
          }
          ListEmptyComponent={
            <Text
              style={[
                typography.caption,
                { color: colors.textTertiary, marginTop: spacing.sm },
              ]}
            >
              {t("library", "empty.projects")}
            </Text>
          }
          renderItem={renderProject}
        />
      ) : (
        <View style={{ flex: 1, minHeight: 0 }}>
          <Field
            testID="library-search-input"
            placeholder={t("library", "library.search")}
            value={query}
            onChangeText={setQuery}
          />

          {renderFilters()}

          <LibraryOrganizationToolbar
            testIDPrefix="library-sessions"
            viewMode={sessionViewMode}
            onViewModeChange={updateSessionViewMode}
            sortValue={sessionSortMode}
            sortOptions={sessionSortOptions}
            onSortChange={updateSessionSortMode}
            sortButtonLabel={t("library", "library.organization.sort")}
            sortSheetTitle={t(
              "library",
              "library.organization.sortSessions",
            )}
            cardViewLabel={t("library", "library.organization.cardView")}
            compactViewLabel={t(
              "library",
              "library.organization.compactView",
            )}
            closeLabel={t("common", "actions.close")}
          />

          <SectionList<SessionRecord, { key: SessionDateGroupKey }>
            sections={sessionSections}
            keyExtractor={(item: SessionRecord) => item.id}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{
              paddingTop: spacing.xs,
              paddingBottom: spacing.xl,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            stickySectionHeadersEnabled={false}
            ListEmptyComponent={
              <Text
                style={[
                  typography.caption,
                  { color: colors.textTertiary, marginTop: spacing.sm },
                ]}
              >
                {query.trim().length > 0 || filter !== "all"
                  ? t("library", "empty.search")
                  : t("library", "empty.sessions")}
              </Text>
            }
            renderSectionHeader={({
              section,
            }: {
              section: SectionListData<
                SessionRecord,
                { key: SessionDateGroupKey }
              >;
            }) =>
              section.key === "all" ? null : (
                <Text
                  style={[
                    typography.overline,
                    {
                      color: colors.textSecondary,
                      marginTop: spacing.sm,
                      marginBottom: spacing.xs,
                    },
                  ]}
                >
                  {dateGroupLabel(section.key)}
                </Text>
              )
            }
            renderItem={renderSession}
          />
        </View>
      )}
    </Screen>
  );
}
