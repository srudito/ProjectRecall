import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect } from "expo-router";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Field } from "@/src/components/Field";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { createProject, fetchProjects, fetchSessions } from "@/src/services/session/service";
import { ProjectRecord, SessionRecord } from "@/src/services/sqlite/repository";
import { resolvePersonalWorkspace } from "@/src/services/workspace/service";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

type Tab = "projects" | "sessions";
type Filter = "all" | "localOnly" | "pending" | "syncing" | "synced" | "failed";

const FILTER_TO_STATUS: Record<Filter, string | null> = {
  all: null,
  localOnly: "local_only",
  pending: "pending",
  syncing: "uploading",
  synced: "synchronized",
  failed: "failed",
};

export default function Library() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography, radii } = useTheme();
  const user = useAuthStore((s) => s.user);

  const [tab, setTab] = useState<Tab>("projects");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newName, setNewName] = useState("");

  const refresh = useCallback(async () => {
    const ws = await resolvePersonalWorkspace(user?.id ?? "anonymous");
    const [ps, ss] = await Promise.all([fetchProjects(ws.id), fetchSessions(ws.id)]);
    setProjects(ps);
    setSessions(ss);
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const filteredSessions = sessions.filter((s) => {
    const passesFilter =
      FILTER_TO_STATUS[filter] == null ? true : s.local_sync_status === FILTER_TO_STATUS[filter];
    const passesSearch = query.trim().length === 0 ? true : s.title.toLowerCase().includes(query.toLowerCase());
    return passesFilter && passesSearch;
  });

  const submitNewProject = async () => {
    if (newName.trim().length === 0) return;
    const ws = await resolvePersonalWorkspace(user?.id ?? "anonymous");
    await createProject({
      workspaceId: ws.id,
      createdBy: user?.id ?? "anonymous",
      name: newName.trim(),
    });
    setNewName("");
    setCreatingProject(false);
    refresh();
  };

  const renderTabs = () => {
    const items: Array<{ key: Tab; label: string }> = [
      { key: "projects", label: t("library", "library.tabs.projects") },
      { key: "sessions", label: t("library", "library.tabs.sessions") },
    ];
    return (
      <View style={{ flexDirection: "row", gap: spacing.xs, marginBottom: spacing.md }}>
        {items.map((it) => (
          <TouchableOpacity
            key={it.key}
            testID={`library-tab-${it.key}`}
            onPress={() => setTab(it.key)}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: spacing.sm,
              borderRadius: radii.md,
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

  const renderFilters = () => {
    const items: Array<{ key: Filter; label: string }> = [
      { key: "all", label: t("library", "library.filters.all") },
      { key: "localOnly", label: t("library", "library.filters.localOnly") },
      { key: "pending", label: t("library", "library.filters.pending") },
      { key: "syncing", label: t("library", "library.filters.syncing") },
      { key: "synced", label: t("library", "library.filters.synced") },
      { key: "failed", label: t("library", "library.filters.failed") },
    ];
    return (
      <FlatList
        horizontal
        data={items}
        keyExtractor={(it) => it.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.xxs, gap: spacing.xs, paddingVertical: 8 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            testID={`library-filter-${item.key}`}
            onPress={() => setFilter(item.key)}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: 8,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: filter === item.key ? colors.accent : colors.border,
              backgroundColor: filter === item.key ? colors.accent : colors.surface,
              flexShrink: 0,
              height: 36,
              justifyContent: "center",
            }}
          >
            <Text
              style={[
                typography.caption,
                { color: filter === item.key ? "#fff" : colors.textPrimary, fontWeight: "500" },
              ]}
            >
              {item.label}
            </Text>
          </TouchableOpacity>
        )}
        style={{ height: 56 }}
      />
    );
  };

  return (
    <Screen testID="library-screen">
      <Text style={[typography.displayMedium, { color: colors.textPrimary, marginBottom: spacing.md }]}>
        {t("library", "library.title")}
      </Text>
      {renderTabs()}

      {tab === "projects" ? (
        <View style={{ flex: 1 }}>
          <Button
            testID="library-create-project-button"
            label={t("library", "library.createProject")}
            onPress={() => setCreatingProject(true)}
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
              />
              <Button
                testID="library-new-project-cancel-button"
                label={t("common", "actions.cancel")}
                variant="ghost"
                onPress={() => setCreatingProject(false)}
              />
            </View>
          ) : null}

          <View style={{ marginTop: spacing.md }}>
            {projects.length === 0 ? (
              <Text style={[typography.caption, { color: colors.textTertiary }]}>
                {t("library", "empty.projects")}
              </Text>
            ) : (
              projects.map((p) => (
                <Card key={p.id} testID={`library-project-${p.id}`} style={{ marginBottom: spacing.sm }}>
                  <Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>{p.name}</Text>
                  {p.description ? (
                    <Text style={[typography.caption, { color: colors.textTertiary, marginTop: spacing.xxs }]}>
                      {p.description}
                    </Text>
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
            keyExtractor={(it) => it.id}
            contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}
            ListEmptyComponent={
              <Text style={[typography.caption, { color: colors.textTertiary }]}>
                {t("library", "empty.sessions")}
              </Text>
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                testID={`library-session-${item.id}`}
                onPress={() => router.push({ pathname: "/session/[id]", params: { id: item.id } })}
              >
                <Card style={{ marginBottom: spacing.sm }}>
                  <Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>{item.title}</Text>
                  <Text style={[typography.caption, { color: colors.textTertiary, marginTop: spacing.xxs }]}>
                    {formatDurationMs(item.total_recorded_duration_ms)} • {item.local_sync_status}
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
