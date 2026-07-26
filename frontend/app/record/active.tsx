import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { RecordingState } from "@/src/services/recording/state-machine";
import {
  addBookmark,
  addMediaAsset,
  addNote,
  getSessionBundle,
  markSessionRecording,
  markSessionStopped,
  recordTimelineEvent,
} from "@/src/services/session/service";
import { SessionRecord, getSession, listBookmarksForSession } from "@/src/services/sqlite/repository";
import { TimelineEventType } from "@/src/domain/enums";
import { throwIfInvalid } from "@/src/services/files/validation";
import { isDuplicateBookmark } from "@/src/services/session/duplicate-prevention";
import { useRecordingStore } from "@/src/stores/recording-store";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

export default function ActiveRecording() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const { colors, spacing, typography, radii } = useTheme();
  const user = useAuthStore((s) => s.user);

  const controller = useRecordingStore((s) => s.controller);
  const snapshot = useRecordingStore((s) => s.snapshot);
  const bind = useRecordingStore((s) => s.bind);

  const [session, setSession] = useState<SessionRecord | null>(null);
  const [showEvidenceSheet, setShowEvidenceSheet] = useState(false);
  const [showNoteSheet, setShowNoteSheet] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const unsub = bind();
    return unsub;
  }, [bind]);

  // 1Hz refresh so the timer updates while recording (offset is queried live).
  useEffect(() => {
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    (async () => {
      if (!sessionId) return;
      const s = await getSession(String(sessionId));
      setSession(s);
      // Auto-start.
      if (s && snapshot.state === RecordingState.IDLE) {
        try {
          await controller.start();
          const started = await markSessionRecording(s);
          setSession(started);
          await recordTimelineEvent(started, {
            event_type: TimelineEventType.RECORDING_STARTED,
            source_entity_type: null,
            source_entity_id: null,
            recording_offset_ms: 0,
            created_by: user?.id ?? "anonymous",
          });
        } catch (e) {
          setStatusMsg(String(e));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const stateLabel = useMemo(() => {
    if (snapshot.state === RecordingState.RECORDING) return t("recording", "active.recording");
    if (snapshot.state === RecordingState.PAUSED) return t("recording", "active.paused");
    return snapshot.state;
  }, [snapshot.state, t]);

  const onPauseOrResume = async () => {
    if (!session) return;
    if (snapshot.state === RecordingState.RECORDING) {
      await controller.pause();
      await recordTimelineEvent(session, {
        event_type: TimelineEventType.RECORDING_PAUSED,
        source_entity_type: null,
        source_entity_id: null,
        recording_offset_ms: controller.getSnapshot().offsetMs,
        created_by: user?.id ?? "anonymous",
      });
    } else if (snapshot.state === RecordingState.PAUSED) {
      await controller.resume();
      await recordTimelineEvent(session, {
        event_type: TimelineEventType.RECORDING_RESUMED,
        source_entity_type: null,
        source_entity_id: null,
        recording_offset_ms: controller.getSnapshot().offsetMs,
        created_by: user?.id ?? "anonymous",
      });
    }
  };

  const onStop = async () => {
    if (!session) return;
    try {
      const result = await controller.stop();
      const finalOffset = result?.durationMs ?? controller.getSnapshot().offsetMs;
      const stopped = await markSessionStopped(session, finalOffset);
      await recordTimelineEvent(stopped, {
        event_type: TimelineEventType.RECORDING_STOPPED,
        source_entity_type: "recording",
        source_entity_id: null,
        recording_offset_ms: finalOffset,
        created_by: user?.id ?? "anonymous",
      });
      router.replace({ pathname: "/record/review", params: { sessionId: stopped.id } });
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const onBookmark = async () => {
    if (!session) return;
    const now = Date.now();
    const offsetMs = controller.getSnapshot().offsetMs;
    // Dup-prevention (fast taps).
    const existing = await listBookmarksForSession(session.id);
    const dup = isDuplicateBookmark(
      { recording_offset_ms: offsetMs, created_at_ms: now },
      existing.map((b) => ({ recording_offset_ms: b.recording_offset_ms, created_at_ms: new Date(b.created_at).getTime() })),
    );
    if (dup) return;
    await addBookmark({
      session,
      createdBy: user?.id ?? "anonymous",
      label: t("recording", "bookmark.defaultLabel"),
      offsetMs,
    });
  };

  const onSaveNote = async () => {
    if (!session || noteText.trim().length === 0) {
      setShowNoteSheet(false);
      return;
    }
    await addNote({
      session,
      createdBy: user?.id ?? "anonymous",
      text: noteText.trim(),
      offsetMs: controller.getSnapshot().offsetMs,
    });
    setNoteText("");
    setShowNoteSheet(false);
  };

  const attachFromCamera = async () => {
    setShowEvidenceSheet(false);
    if (!session) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.9 });
    if (result.canceled) return;
    const asset = result.assets[0];
    await ingestAsset({ uri: asset.uri, mime: asset.mimeType ?? "image/jpeg", fileName: asset.fileName ?? `photo_${Date.now()}.jpg`, size: asset.fileSize ?? 0, width: asset.width, height: asset.height, kind: "image" });
  };

  const attachFromLibrary = async () => {
    setShowEvidenceSheet(false);
    if (!session) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.9 });
    if (result.canceled) return;
    const asset = result.assets[0];
    await ingestAsset({ uri: asset.uri, mime: asset.mimeType ?? "image/jpeg", fileName: asset.fileName ?? `photo_${Date.now()}.jpg`, size: asset.fileSize ?? 0, width: asset.width, height: asset.height, kind: "image" });
  };

  const attachVideo = async () => {
    setShowEvidenceSheet(false);
    if (!session) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos });
    if (result.canceled) return;
    const asset = result.assets[0];
    await ingestAsset({ uri: asset.uri, mime: asset.mimeType ?? "video/mp4", fileName: asset.fileName ?? `video_${Date.now()}.mp4`, size: asset.fileSize ?? 0, kind: "video", durationMs: asset.duration ?? 0 });
  };

  const attachDocument = async () => {
    setShowEvidenceSheet(false);
    if (!session) return;
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: ["application/pdf", "text/*", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] });
    if (result.canceled) return;
    const asset = result.assets[0];
    await ingestAsset({ uri: asset.uri, mime: asset.mimeType ?? "application/pdf", fileName: asset.name, size: asset.size ?? 0, kind: "document" });
  };

  const ingestAsset = async (input: { uri: string; mime: string; fileName: string; size: number; kind: "image" | "video" | "document"; width?: number; height?: number; durationMs?: number }) => {
    if (!session) return;
    try {
      const validation = throwIfInvalid({
        mimeType: input.mime,
        fileName: input.fileName,
        fileSize: input.size,
        assetType: input.kind,
      });
      // Copy into app-controlled directory.
      const dir = `${FileSystem.documentDirectory}sessions/${session.id}/assets/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const localUri = `${dir}${await Crypto.randomUUID()}_${validation.sanitizedFileName}`;
      try {
        await FileSystem.copyAsync({ from: input.uri, to: localUri });
      } catch {
        // Some pickers already give us a stable local uri; keep original if copy fails.
      }
      await addMediaAsset({
        session,
        addedBy: user?.id ?? "anonymous",
        assetType: input.kind,
        mimeType: input.mime,
        originalFileName: input.fileName,
        sanitizedFileName: validation.sanitizedFileName,
        localFileUri: localUri,
        fileSize: input.size,
        durationMs: input.durationMs ?? null,
        imageWidth: input.width ?? null,
        imageHeight: input.height ?? null,
        offsetMs: controller.getSnapshot().offsetMs,
      });
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const canPause = snapshot.state === RecordingState.RECORDING;
  const canResume = snapshot.state === RecordingState.PAUSED;
  const canStop = snapshot.state === RecordingState.RECORDING || snapshot.state === RecordingState.PAUSED;

  return (
    <Screen testID="active-recording-screen">
      <View style={{ flex: 1, justifyContent: "space-between" }}>
        <View style={{ alignItems: "center", marginTop: spacing.xl }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <View
              testID="recording-status-indicator"
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: canPause ? colors.recording : colors.textTertiary,
              }}
            />
            <Text style={[typography.overline, { color: colors.textSecondary, letterSpacing: 1.2 }]}>
              {stateLabel.toUpperCase()}
            </Text>
          </View>
          <Text
            testID="recording-elapsed-timer"
            style={[typography.timer, { color: colors.textPrimary, marginTop: spacing.md }]}
          >
            {formatDurationMs(snapshot.offsetMs)}
          </Text>
          <Text style={[typography.caption, { color: colors.textTertiary, marginTop: spacing.xs }]}>
            {t("recording", "meterUnavailable")}
          </Text>
          {statusMsg ? (
            <Text
              testID="recording-status-message"
              style={[typography.caption, { color: colors.recording, marginTop: spacing.md, textAlign: "center" }]}
            >
              {statusMsg}
            </Text>
          ) : null}
        </View>

        <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                testID="recording-pause-resume-button"
                label={canPause ? t("recording", "active.pause") : t("recording", "active.resume")}
                variant="secondary"
                fullWidth
                disabled={!canPause && !canResume}
                onPress={onPauseOrResume}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                testID="recording-stop-button"
                label={t("recording", "active.stop")}
                variant="danger"
                fullWidth
                disabled={!canStop}
                onPress={onStop}
              />
            </View>
          </View>

          <View style={{ flexDirection: "row", gap: spacing.xs }}>
            <TouchableOpacity
              testID="recording-bookmark-button"
              style={[styles.actionPill, { borderColor: colors.border, backgroundColor: colors.surface }]}
              onPress={onBookmark}
            >
              <Ionicons name="bookmark-outline" size={18} color={colors.textPrimary} />
              <Text style={{ color: colors.textPrimary, marginLeft: 6 }}>
                {t("recording", "active.addBookmark")}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              testID="recording-note-button"
              style={[styles.actionPill, { borderColor: colors.border, backgroundColor: colors.surface }]}
              onPress={() => setShowNoteSheet(true)}
            >
              <Ionicons name="create-outline" size={18} color={colors.textPrimary} />
              <Text style={{ color: colors.textPrimary, marginLeft: 6 }}>
                {t("recording", "active.addNote")}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              testID="recording-add-evidence-button"
              style={[styles.actionPill, { borderColor: colors.accent, backgroundColor: colors.accent }]}
              onPress={() => setShowEvidenceSheet(true)}
            >
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={{ color: "#fff", marginLeft: 6 }}>
                {t("recording", "active.addEvidence")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Evidence action sheet */}
      <Modal transparent visible={showEvidenceSheet} animationType="slide" onRequestClose={() => setShowEvidenceSheet(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowEvidenceSheet(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface }]} onPress={() => {}}>
            <Text style={[typography.headline, { color: colors.textPrimary, marginBottom: spacing.md }]}>
              {t("recording", "evidenceSheet.title")}
            </Text>
            <SheetItem testID="evidence-sheet-take-photo" icon="camera-outline" label={t("recording", "evidenceSheet.takePhoto")} onPress={attachFromCamera} colors={colors} />
            <SheetItem testID="evidence-sheet-select-photo" icon="image-outline" label={t("recording", "evidenceSheet.selectPhoto")} onPress={attachFromLibrary} colors={colors} />
            <SheetItem testID="evidence-sheet-select-video" icon="videocam-outline" label={t("recording", "evidenceSheet.selectVideo")} onPress={attachVideo} colors={colors} />
            <SheetItem testID="evidence-sheet-select-document" icon="document-outline" label={t("recording", "evidenceSheet.selectDocument")} onPress={attachDocument} colors={colors} />
            <Button
              testID="evidence-sheet-cancel-button"
              label={t("common", "actions.cancel")}
              variant="ghost"
              onPress={() => setShowEvidenceSheet(false)}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Note sheet */}
      <Modal transparent visible={showNoteSheet} animationType="slide" onRequestClose={() => setShowNoteSheet(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowNoteSheet(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface }]} onPress={() => {}}>
            <Text style={[typography.headline, { color: colors.textPrimary, marginBottom: spacing.md }]}>
              {t("recording", "note.title")}
            </Text>
            <TextInput
              testID="note-sheet-input"
              value={noteText}
              onChangeText={setNoteText}
              placeholder={t("recording", "note.placeholder")}
              placeholderTextColor={colors.textTertiary}
              multiline
              style={{
                minHeight: 100,
                textAlignVertical: "top",
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radii.md,
                padding: spacing.md,
                color: colors.textPrimary,
                marginBottom: spacing.md,
              }}
            />
            <Button testID="note-sheet-save-button" label={t("recording", "note.save")} onPress={onSaveNote} />
            <Button testID="note-sheet-cancel-button" label={t("common", "actions.cancel")} variant="ghost" onPress={() => setShowNoteSheet(false)} />
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function SheetItem({ testID, icon, label, onPress, colors }: { testID: string; icon: any; label: string; onPress: () => void; colors: any }) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Ionicons name={icon} size={20} color={colors.textPrimary} />
      <Text style={{ marginLeft: 12, color: colors.textPrimary, fontSize: 15 }}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  actionPill: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 32,
  },
});
