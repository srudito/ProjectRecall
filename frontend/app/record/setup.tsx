import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Field } from "@/src/components/Field";
import { Screen } from "@/src/components/Screen";
import { SpokenLanguageMode } from "@/src/domain/enums";
import { useI18n } from "@/src/i18n/I18nProvider";
import { createSession, fetchProjects } from "@/src/services/session/service";
import type { ProjectRecord } from "@/src/services/sqlite/repository";
import { subscribeMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import {
  getTranscriptionLanguageSelectionForMode,
  resolveSupportedTranscriptionLanguageSelection,
  SUPPORTED_TRANSCRIPTION_LANGUAGE_CODES,
  type SupportedTranscriptionLanguageCode,
} from "@/src/services/transcription/language-capabilities";
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
  const [selectedLangs, setSelectedLangs] = useState<
    SupportedTranscriptionLanguageCode[]
  >([]);
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

  const selectMode = (nextMode: SpokenLanguageMode) => {
    setMode(nextMode);
    setSelectedLangs(
      getTranscriptionLanguageSelectionForMode(nextMode, selectedLangs),
    );
    setError(null);
  };

  const selectSingleLanguage = (
    language: SupportedTranscriptionLanguageCode,
  ) => {
    setSelectedLangs([language]);
    setError(null);
  };

  const languageLabel = (
    language: SupportedTranscriptionLanguageCode,
  ): string =>
    language === "en"
      ? t("recording", "setup.languageEnglish")
      : t("recording", "setup.languageIndonesian");

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace("/(tabs)/home");
  };

  const start = async () => {
    setError(null);
    if (!user?.id) {
      setError(t("errors", "AUTH_SESSION_EXPIRED"));
      return;
    }

    const languageSelection = resolveSupportedTranscriptionLanguageSelection(
      mode,
      selectedLangs,
    );
    if (!languageSelection.ok) {
      setError(t("errors", languageSelection.code));
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
        expectedSpokenLanguages: languageSelection.languages,
      });
      router.replace({ pathname: "/record/active", params: { sessionId: session.id } });
    } catch {
      setError(t("errors", "DATABASE_WRITE_FAILED"));
    }
  };

  const modeButtons: { key: SpokenLanguageMode; label: string; help: string }[] = [
    { key: SpokenLanguageMode.AUTO_DETECT, label: t("recording", "setup.modeAuto"), help: t("recording", "setup.modeAutoHelp") },
    { key: SpokenLanguageMode.SINGLE_LANGUAGE, label: t("recording", "setup.modeSingle"), help: t("recording", "setup.modeSingleHelp") },
    { key: SpokenLanguageMode.MULTILINGUAL, label: t("recording", "setup.modeCodeSwitching"), help: t("recording", "setup.modeCodeSwitchingHelp") },
  ];

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
        <Text
          testID="record-setup-language-rollout-note"
          style={[
            typography.caption,
            { color: colors.textSecondary, marginBottom: spacing.sm },
          ]}
        >
          {t("recording", "setup.languageRolloutNote")}
        </Text>
        {modeButtons.map((m) => {
          const active = m.key === mode;
          return (
            <TouchableOpacity
              key={m.key}
              testID={`record-setup-mode-${m.key}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => selectMode(m.key)}
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

        {mode === SpokenLanguageMode.AUTO_DETECT ? (
          <Text
            testID="record-setup-auto-language-hint"
            style={[
              typography.caption,
              { color: colors.textSecondary, marginTop: spacing.sm },
            ]}
          >
            {t("recording", "setup.autoLanguageHint")}
          </Text>
        ) : mode === SpokenLanguageMode.SINGLE_LANGUAGE ? (
          <View style={{ marginTop: spacing.sm }}>
            <Text style={[typography.caption, { color: colors.textSecondary }]}>
              {t("recording", "setup.singleLanguagePrompt")}
            </Text>
            <View
              style={{
                flexDirection: "row",
                gap: spacing.xs,
                marginTop: spacing.xs,
                flexWrap: "wrap",
              }}
            >
              {SUPPORTED_TRANSCRIPTION_LANGUAGE_CODES.map((language) => {
                const active = selectedLangs.includes(language);
                return (
                  <TouchableOpacity
                    key={language}
                    testID={`record-setup-language-${language}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => selectSingleLanguage(language)}
                    style={{
                      paddingHorizontal: spacing.md,
                      paddingVertical: spacing.sm,
                      borderRadius: radii.md,
                      borderWidth: 1,
                      borderColor: active ? colors.accent : colors.border,
                      backgroundColor: active ? colors.accent : colors.surface,
                    }}
                  >
                    <Text
                      style={[
                        typography.caption,
                        {
                          color: active
                            ? colors.textOnAccent
                            : colors.textPrimary,
                        },
                      ]}
                    >
                      {languageLabel(language)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : (
          <View
            testID="record-setup-code-switching-pair"
            style={{ marginTop: spacing.sm }}
          >
            <Text style={[typography.caption, { color: colors.textSecondary }]}>
              {t("recording", "setup.multilingualPairHint")}
            </Text>
            <View
              style={{
                flexDirection: "row",
                gap: spacing.xs,
                marginTop: spacing.xs,
                flexWrap: "wrap",
              }}
            >
              {SUPPORTED_TRANSCRIPTION_LANGUAGE_CODES.map((language) => (
                <View
                  key={language}
                  testID={`record-setup-code-switching-${language}`}
                  style={{
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                    borderRadius: radii.md,
                    borderWidth: 1,
                    borderColor: colors.accent,
                    backgroundColor: colors.accent,
                  }}
                >
                  <Text
                    style={[
                      typography.caption,
                      { color: colors.textOnAccent },
                    ]}
                  >
                    {languageLabel(language)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}
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
        onPress={handleBack}
      />
    </Screen>
  );
}
