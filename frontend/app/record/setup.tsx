import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, ScrollView, Text, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Field } from "@/src/components/Field";
import { Screen } from "@/src/components/Screen";
import { SpokenLanguageMode } from "@/src/domain/enums";
import { spokenLanguageCatalog } from "@/src/i18n/languages";
import { useI18n } from "@/src/i18n/I18nProvider";
import { createSession, fetchProjects } from "@/src/services/session/service";
import { validateSpokenLanguageSelection } from "@/src/services/language/precedence";
import type { ProjectRecord } from "@/src/services/sqlite/repository";
import { subscribeMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { resolvePersonalWorkspace } from "@/src/services/workspace/service";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";

export default function RecordSetup() {
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography, radii } = useTheme();
  const user = useAuthStore((s) => s.user);

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SpokenLanguageMode>(SpokenLanguageMode.AUTO_DETECT);
  const [selectedLangs, setSelectedLangs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    if (!user?.id) {
      setProjects([]);
      return;
    }

    try {
      const workspace = await resolvePersonalWorkspace(user.id);
      setProjects(await fetchProjects(workspace.id));
    } catch {
      setError(t("errors", "AUTH_SESSION_EXPIRED"));
    }
  }, [t, user?.id]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(
    () =>
      subscribeMetadataSyncChanges(() => {
        void loadProjects();
      }),
    [loadProjects],
  );

  const toggleLang = (tag: string) => {
    if (mode === SpokenLanguageMode.SINGLE_LANGUAGE) {
      setSelectedLangs([tag]);
    } else {
      setSelectedLangs((prev) =>
        prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag],
      );
    }
  };

  const start = async () => {
    setError(null);
    if (!user?.id) {
      setError(t("errors", "AUTH_SESSION_EXPIRED"));
      return;
    }

    const validation = validateSpokenLanguageSelection(mode, selectedLangs);
    if (!validation.valid) {
      setError(t("errors", "LANGUAGE_SELECTION_INVALID"));
      return;
    }

    try {
      const ws = await resolvePersonalWorkspace(user.id);
      const session = await createSession({
        workspaceId: ws.id,
        createdBy: user.id,
        projectId,
        title: title.trim() || "Untitled session",
        spokenLanguageMode: mode,
        expectedSpokenLanguages: selectedLangs,
      });
      router.replace({ pathname: "/record/active", params: { sessionId: session.id } });
    } catch {
      setError(t("errors", "DATABASE_WRITE_FAILED"));
    }
  };

  const modeButtons: { key: SpokenLanguageMode; label: string; help: string }[] = [
    { key: SpokenLanguageMode.AUTO_DETECT, label: t("onboarding", "spokenLanguage.modeAuto"), help: t("onboarding", "spokenLanguage.modeAutoHelp") },
    { key: SpokenLanguageMode.SINGLE_LANGUAGE, label: t("onboarding", "spokenLanguage.modeSingle"), help: t("onboarding", "spokenLanguage.modeSingleHelp") },
    { key: SpokenLanguageMode.MULTILINGUAL, label: t("onboarding", "spokenLanguage.modeMultiple"), help: t("onboarding", "spokenLanguage.modeMultipleHelp") },
  ];

  const showLangPicker = mode !== SpokenLanguageMode.AUTO_DETECT;
  const quickTags = ["en", "id"];

  return (
    <Screen scrollable testID="record-setup-screen">
      <Text style={[typography.title, { color: colors.textPrimary, marginBottom: spacing.md }]}>
        {t("recording", "setup.title")}
      </Text>

      <Field
        testID="record-setup-title-input"
        label={t("recording", "setup.titleLabel")}
        placeholder={t("recording", "setup.titlePlaceholder")}
        value={title}
        onChangeText={setTitle}
      />

      <Text style={[typography.caption, { color: colors.textSecondary, marginBottom: spacing.xs }]}>
        {t("recording", "setup.projectLabel")}
      </Text>
      <FlatList
        horizontal
        data={[
          { id: "none", name: t("recording", "setup.selectProject") },
          ...projects.map((project) => ({ id: project.id, name: project.name })),
        ]}
        keyExtractor={(it) => it.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.xs, paddingVertical: spacing.xs }}
        renderItem={({ item }) => {
          const isNone = item.id === "none";
          const active = isNone ? projectId === null : projectId === item.id;
          return (
            <TouchableOpacity
              testID={`record-setup-project-${item.id}`}
              onPress={() => setProjectId(isNone ? null : item.id)}
              style={{
                paddingHorizontal: spacing.md,
                paddingVertical: 8,
                borderRadius: 18,
                borderWidth: 1,
                borderColor: active ? colors.accent : colors.border,
                backgroundColor: active ? colors.accent : colors.surface,
                flexShrink: 0,
                height: 36,
                justifyContent: "center",
              }}
            >
              <Text style={{ color: active ? "#fff" : colors.textPrimary, fontSize: 13, fontWeight: "500" }}>
                {item.name}
              </Text>
            </TouchableOpacity>
          );
        }}
        style={{ height: 56, marginBottom: spacing.md }}
      />

      <Card title={t("recording", "setup.languageSection")} testID="record-setup-language-card">
        {modeButtons.map((m) => {
          const active = m.key === mode;
          return (
            <TouchableOpacity
              key={m.key}
              testID={`record-setup-mode-${m.key}`}
              onPress={() => {
                setMode(m.key);
                if (m.key === SpokenLanguageMode.AUTO_DETECT) setSelectedLangs([]);
              }}
              style={{
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.md,
                borderRadius: radii.md,
                borderWidth: 1,
                borderColor: active ? colors.accent : colors.border,
                backgroundColor: active ? "rgba(32,168,154,0.1)" : colors.surface,
                marginBottom: spacing.xs,
              }}
            >
              <Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>{m.label}</Text>
              <Text style={[typography.caption, { color: colors.textTertiary }]}>{m.help}</Text>
            </TouchableOpacity>
          );
        })}

        {showLangPicker ? (
          <>
            <Text style={[typography.caption, { color: colors.textSecondary, marginTop: spacing.sm }]}>
              Quick choices
            </Text>
            <View style={{ flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs, flexWrap: "wrap" }}>
              {quickTags.map((tag) => {
                const active = selectedLangs.includes(tag);
                return (
                  <TouchableOpacity
                    key={tag}
                    testID={`record-setup-quick-lang-${tag}`}
                    onPress={() => toggleLang(tag)}
                    style={{
                      paddingHorizontal: spacing.md,
                      paddingVertical: 6,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: active ? colors.accent : colors.border,
                      backgroundColor: active ? colors.accent : colors.surface,
                    }}
                  >
                    <Text style={{ color: active ? "#fff" : colors.textPrimary, fontSize: 12 }}>
                      {tag === "en" ? "English" : "Bahasa Indonesia"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[typography.caption, { color: colors.textSecondary, marginTop: spacing.md }]}>
              Full catalog
            </Text>
            <ScrollView style={{ maxHeight: 220, marginTop: spacing.xs }}>
              {spokenLanguageCatalog.map((l) => {
                const active = selectedLangs.includes(l.tag);
                return (
                  <TouchableOpacity
                    key={l.tag}
                    testID={`record-setup-lang-${l.tag}`}
                    onPress={() => toggleLang(l.tag)}
                    style={{
                      paddingVertical: spacing.sm,
                      paddingHorizontal: spacing.sm,
                      borderRadius: 8,
                      backgroundColor: active ? "rgba(32,168,154,0.15)" : "transparent",
                      flexDirection: "row",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ color: colors.textPrimary, fontSize: 14 }}>{l.nativeName}</Text>
                    <Text style={{ color: colors.textTertiary, fontSize: 12 }}>{l.tag}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </>
        ) : null}
      </Card>

      {error ? (
        <Text
          testID="record-setup-error"
          style={[typography.caption, { color: colors.recording, marginTop: spacing.md }]}
        >
          {error}
        </Text>
      ) : null}

      <View style={{ height: spacing.lg }} />
      <Button
        testID="record-setup-start-button"
        label={t("recording", "setup.startRecording")}
        variant="accent"
        fullWidth
        onPress={start}
      />
      <Button
        testID="record-setup-back-button"
        label={t("common", "actions.back")}
        variant="ghost"
        onPress={() => router.back()}
      />
    </Screen>
  );
}
