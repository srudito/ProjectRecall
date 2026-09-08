import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranscriptEditor } from "@/src/hooks/use-transcript-editor";
import { useI18n } from "@/src/i18n/I18nProvider";
import { presentTranscriptEditor, transcriptEditorErrorKey } from "@/src/services/transcription/editor-presentation";
import type { TranscriptEditorScope } from "@/src/services/transcription/editor-types";
import { useTheme } from "@/src/theme/ThemeProvider";

import { Button } from "./Button";

interface Props {
  scope: Readonly<TranscriptEditorScope>;
  onClosed: () => void;
}

/** Mount only for an explicit editor opening; the reader never owns this writer. */
export function TranscriptEditorModal({ scope, onClosed }: Props) {
  const { t } = useI18n();
  const { colors, spacing, radii, typography } = useTheme();
  const editor = useTranscriptEditor(scope);
  const snapshot = editor.snapshot;
  const presentation = presentTranscriptEditor(snapshot, editor.action, editor.loading);
  const [showCurrent, setShowCurrent] = useState(false);
  const life = useRef({ active: false, generation: 0, dialog: false, dialogToken: 0, closed: false });
  const onClosedRef = useRef(onClosed);
  useEffect(() => { onClosedRef.current = onClosed; }, [onClosed]);
  useLayoutEffect(() => {
    const state = life.current;
    state.active = true;
    state.generation += 1;
    return () => { state.active = false; state.generation += 1; state.dialog = false; };
  }, []);
  const finish = () => {
    if (!life.current.active || life.current.closed) return;
    life.current.closed = true;
    onClosedRef.current();
  };
  useEffect(() => {
    if (snapshot?.phase === "invalidated" && life.current.active && !life.current.closed) {
      life.current.closed = true;
      onClosedRef.current();
    }
  }, [snapshot?.phase]);

  // A native Alert can outlive a scope, screen or account. Every callback must
  // still belong to this modal lifetime; destructive actions also carry revision.
  const confirm = (title: string, body: string, label: string, action: () => void) => {
    if (!life.current.active || life.current.dialog || life.current.closed) return;
    life.current.dialog = true;
    const generation = life.current.generation;
    const dialogToken = ++life.current.dialogToken;
    const valid = () => life.current.active && !life.current.closed &&
      life.current.generation === generation && life.current.dialogToken === dialogToken;
    Alert.alert(title, body, [
      { text: t("common", "actions.cancel"), style: "cancel", onPress: () => {
        if (valid()) life.current.dialog = false;
      } },
      { text: label, style: "destructive", onPress: () => {
        if (!valid()) return;
        life.current.dialog = false;
        action();
      } },
    ], { cancelable: true, onDismiss: () => { if (valid()) life.current.dialog = false; } });
  };
  const closeEditor = async () => {
    const generation = life.current.generation;
    const confirmedRevision = snapshot?.revision ?? 0;
    const result = await editor.close();
    if (!life.current.active || life.current.generation !== generation) return;
    if (result.ok) { finish(); return; }
    if (result.code === "EDITOR_BUSY") return;
    confirm(t("session", "editor.closeFailedTitle"), t("session", "editor.closeFailedBody"),
      t("session", "editor.leaveUnsaved"), () => {
        void editor.abandon(confirmedRevision).then((abandoned) => {
          if (abandoned.ok && life.current.generation === generation) finish();
        });
      });
  };
  const requestClose = () => {
    if (!presentation.canClose || life.current.dialog) return;
    if (snapshot?.hasFrozenSave || snapshot?.draftConflict) {
      confirm(t("session", "editor.leavePendingTitle"),
        t("session", snapshot.draftConflict ? "editor.leaveConflictBody" : "editor.leavePendingBody"),
        t("session", "editor.close"), () => { void closeEditor(); });
    } else { void closeEditor(); }
  };
  const requestDiscard = () => {
    if (!presentation.canDiscard || !snapshot) return;
    const confirmedRevision = snapshot.revision;
    confirm(t("session", "editor.discardTitle"), t("session", "editor.discardBody"),
      t("session", "editor.discard"), () => { void editor.discard(confirmedRevision); });
  };
  const bodyText = [typography.body, { color: colors.textPrimary }];
  const caption = [typography.caption, { color: colors.textSecondary }];
  const currentText = snapshot?.currentText;

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen"
      onRequestClose={requestClose} testID="transcript-editor-modal">
      <SafeAreaView edges={["top", "bottom", "left", "right"]}
        style={{ flex: 1, backgroundColor: colors.background }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View style={{ padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text accessibilityRole="header" style={[typography.title, { color: colors.textPrimary }]}>
              {t("session", "editor.title")}
            </Text>
            <Text style={caption}>{t("session", "editor.draftHint")}</Text>
          </View>
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}>
            {editor.loading ? <Text testID="transcript-editor-loading" style={caption}>
              {t("common", "status.loading")}
            </Text> : null}
            {editor.errorCode ? <Text testID="transcript-editor-error" accessibilityRole="alert"
              style={[typography.caption, { color: colors.recording }]}>
              {t("session", transcriptEditorErrorKey(editor.errorCode))}
            </Text> : null}
            {snapshot?.phase === "unavailable" ? <Text testID="transcript-editor-unavailable" style={bodyText}>
              {t("session", "editor.unavailable")}
            </Text> : null}
            {!presentation.ready && presentation.canReload ? <Button testID="transcript-editor-reload"
              label={t("session", "editor.reload")} variant="secondary"
              onPress={() => { void editor.reload(); }} /> : null}
            {presentation.ready && snapshot ? <>
              <Text testID="transcript-editor-local-status" accessibilityLiveRegion="polite" style={caption}>
                {t("session", presentation.localKey)}
              </Text>
              <Text testID="transcript-editor-sync-status" style={caption}>
                {t("session", presentation.syncKey)}
              </Text>
              {presentation.conflictKey ? <Text testID="transcript-editor-conflict" accessibilityRole="alert"
                style={[typography.caption, { color: colors.warning }]}>
                {t("session", presentation.conflictKey)}
              </Text> : null}
              {presentation.frozenKey ? <Text testID="transcript-editor-frozen" style={caption}>
                {t("session", presentation.frozenKey)}
              </Text> : null}
              <TextInput testID="transcript-editor-input" multiline scrollEnabled
                accessibilityLabel={t("session", "editor.inputLabel")}
                accessibilityHint={t("session", "editor.draftHint")}
                value={snapshot.text} onChangeText={editor.setText}
                editable={presentation.canEdit} textAlignVertical="top"
                autoCorrect={false} autoCapitalize="none"
                style={[typography.body, { color: colors.textPrimary, backgroundColor: colors.surface,
                  borderColor: colors.border, borderWidth: 1, borderRadius: radii.md,
                  padding: spacing.sm, minHeight: 240, height: 280 }]} />
              {presentation.canFlush ? <Button testID="transcript-editor-flush"
                label={t("session", "editor.retryDraft")} variant="secondary"
                onPress={() => { void editor.flush(); }} /> : null}
              {presentation.canRetryFrozen ? <Button testID="transcript-editor-retry-save"
                label={t("session", "editor.retrySave")} variant="secondary"
                onPress={() => { void editor.save(); }} /> : null}
              <Button testID="transcript-editor-toggle-current" variant="ghost"
                label={t("session", showCurrent ? "editor.hideCurrent" : "editor.showCurrent")}
                onPress={() => setShowCurrent((shown) => !shown)} />
              {showCurrent ? <View testID="transcript-editor-current-panel" style={{ gap: spacing.xs }}>
                <Text style={caption}>{t("session", "editor.currentHint")}</Text>
                <Text selectable testID="transcript-editor-current-text" style={bodyText}>
                  {currentText === null || currentText === undefined ? t("session", "editor.currentUnavailable") : currentText}
                </Text>
                <Button testID="transcript-editor-request-latest" variant="secondary"
                  label={t("session", "editor.requestLatest")} disabled={editor.action !== null}
                  onPress={editor.requestLatest} />
              </View> : null}
              <Button testID="transcript-editor-discard" variant="ghost"
                label={t("session", "editor.discard")} disabled={!presentation.canDiscard}
                onPress={requestDiscard} />
            </> : null}
          </ScrollView>
          <View style={{ padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border,
            flexDirection: "row", gap: spacing.sm }}>
            <Button testID="transcript-editor-save" label={t("session", "editor.save")}
              style={{ flex: 1 }} disabled={!presentation.canSave} loading={editor.action === "save"}
              onPress={() => { void editor.save(); }} />
            <Button testID="transcript-editor-close" label={t("session", "editor.close")}
              style={{ flex: 1 }} variant="secondary" disabled={!presentation.canClose}
              loading={editor.action === "close"} onPress={requestClose} />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
