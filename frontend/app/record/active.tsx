import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { RecordingState } from "@/src/services/recording/state-machine";
import {
  addBookmark,
  addMediaAsset,
  addNote,
  fetchSession,
  getSessionBundle,
  markSessionRecording,
  markSessionStopped,
  recordTimelineEvent,
  saveStoppedRecording,
  setSessionStatus,
} from "@/src/services/session/service";
import { listBookmarksForSession } from "@/src/services/sqlite/repository";
import type { SessionRecord } from "@/src/services/sqlite/repository";
import { SessionStatus, TimelineEventType } from "@/src/domain/enums";
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
  const userId = user?.id ?? null;

  const controller = useRecordingStore((s) => s.controller);
  const snapshot = useRecordingStore((s) => s.snapshot);
  const bind = useRecordingStore((s) => s.bind);

  const [session, setSession] = useState<SessionRecord | null>(null);
  const [showEvidenceSheet, setShowEvidenceSheet] = useState(false);
  const [showNoteSheet, setShowNoteSheet] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [meter, setMeter] = useState<number | null>(null);
  const [bookmarkPending, setBookmarkPending] = useState(false);
  const [bookmarkFeedback, setBookmarkFeedback] = useState<string | null>(null);
  const autoStartSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unsub = bind();
    return unsub;
  }, [bind]);

  // Keep the displayed timer live. The Zustand snapshot is emitted on state
  // transitions, while the offset tracker itself advances continuously. Poll
  // the controller while recording and freeze the final value while paused or
  // stopped.
  useEffect(() => {
    const refreshTelemetry = () => {
      const current = controller.getSnapshot();
      setElapsedMs(current.offsetMs);
      setMeter(
        current.state === RecordingState.RECORDING
          ? current.meter
          : null,
      );
    };

    refreshTelemetry();

    if (snapshot.state !== RecordingState.RECORDING) {
      return;
    }

    const interval = setInterval(refreshTelemetry, 250);
    return () => clearInterval(interval);
  }, [controller, snapshot.state]);

  useEffect(() => {
    if (!bookmarkFeedback) return;

    const timeout = setTimeout(() => {
      setBookmarkFeedback(null);
    }, 2000);

    return () => clearTimeout(timeout);
  }, [bookmarkFeedback]);

  useEffect(() => {
    (async () => {
      if (!sessionId) return;
      if (!userId) {
        setStatusMsg(t("errors", "AUTH_SESSION_EXPIRED"));
        return;
      }
      setSession(null);
      setElapsedMs(0);
      setMeter(null);
      setStatusMsg(null);
      setBookmarkFeedback(null);

      const s = await fetchSession(String(sessionId));
      setSession(s);

      const canStartNewRecording =
        snapshot.state === RecordingState.IDLE ||
        snapshot.state === RecordingState.SAVED ||
        snapshot.state === RecordingState.FAILED;

      // Auto-start exactly once for each session. React development builds can
      // run mount effects more than once; without this guard two concurrent
      // calls can both reach the same native MediaRecorder and the second
      // AudioRecorder.record() call is rejected with IllegalStateException.
      if (
        s &&
        canStartNewRecording &&
        autoStartSessionIdRef.current !== s.id
      ) {
        autoStartSessionIdRef.current = s.id;

        try {
          await controller.start();
          const started = await markSessionRecording(s);
          setSession(started);
          await recordTimelineEvent(started, {
            event_type: TimelineEventType.RECORDING_STARTED,
            source_entity_type: null,
            source_entity_id: null,
            recording_offset_ms: 0,
            created_by: userId,
          });
        } catch (e) {
          // Allow an explicit retry after a failed native start.
          autoStartSessionIdRef.current = null;
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
    if (!session || !userId) {
      if (!userId) setStatusMsg(t("errors", "AUTH_SESSION_EXPIRED"));
      return;
    }

    try {
      if (snapshot.state === RecordingState.RECORDING) {
        await controller.pause();
        const paused = await setSessionStatus(session, SessionStatus.PAUSED);
        setSession(paused);
        await recordTimelineEvent(paused, {
          event_type: TimelineEventType.RECORDING_PAUSED,
          source_entity_type: null,
          source_entity_id: null,
          recording_offset_ms: controller.getSnapshot().offsetMs,
          created_by: userId,
        });
      } else if (snapshot.state === RecordingState.PAUSED) {
        await controller.resume();
        const resumed = await setSessionStatus(session, SessionStatus.RECORDING);
        setSession(resumed);
        await recordTimelineEvent(resumed, {
          event_type: TimelineEventType.RECORDING_RESUMED,
          source_entity_type: null,
          source_entity_id: null,
          recording_offset_ms: controller.getSnapshot().offsetMs,
          created_by: userId,
        });
      }
    } catch (error) {
      setStatusMsg(String(error));
    }
  };

  const onStop = async () => {
    if (!session || !userId) {
      if (!userId) setStatusMsg(t("errors", "AUTH_SESSION_EXPIRED"));
      return;
    }
    try {
      const result = await controller.stop();
      if (!result) {
        throw new Error("The recording file was not created.");
      }

      const finalOffset = result.durationMs;
      const stopped = await markSessionStopped(session, finalOffset);
      setSession(stopped);

      let recordingId: string | null = null;
      let recordingError: unknown = null;

      try {
        const recording = await saveStoppedRecording({
          session: stopped,
          createdBy: userId,
          sourceFileUri: result.fileUri,
          durationMs: result.durationMs,
          reportedFileSize: result.fileSize,
        });
        recordingId = recording.id;
      } catch (error) {
        recordingError = error;
      }

      try {
        // The microphone has already stopped, so preserve the session lifecycle
        // even if durable file persistence or cloud upload initialization fails.
        await recordTimelineEvent(stopped, {
          event_type: TimelineEventType.RECORDING_STOPPED,
          source_entity_type: recordingId ? "recording" : null,
          source_entity_id: recordingId,
          recording_offset_ms: finalOffset,
          created_by: userId,
        });
      } catch (timelineError) {
        if (!recordingError) throw timelineError;
      }

      if (recordingError) throw recordingError;

      router.replace({
        pathname: "/record/review",
        params: { sessionId: stopped.id },
      });
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const onBookmark = async () => {
    if (bookmarkPending) return;

    if (!session || !userId) {
      if (!userId) setStatusMsg(t("errors", "AUTH_SESSION_EXPIRED"));
      return;
    }

    const recordingIsActive =
      snapshot.state === RecordingState.RECORDING ||
      snapshot.state === RecordingState.PAUSED;

    if (!recordingIsActive) {
      setStatusMsg(t("recording", "bookmark.unavailable"));
      return;
    }

    setBookmarkPending(true);

    try {
      const now = Date.now();
      const offsetMs = controller.getSnapshot().offsetMs;

      // Native reads the durable local database; web reads the cloud bundle.
      const existing =
        Platform.OS === "web"
          ? (await getSessionBundle(session.id)).bookmarks
          : await listBookmarksForSession(session.id);

      const duplicate = isDuplicateBookmark(
        { recording_offset_ms: offsetMs, created_at_ms: now },
        existing.map((bookmark) => ({
          recording_offset_ms: bookmark.recording_offset_ms,
          created_at_ms: new Date(bookmark.created_at).getTime(),
        })),
      );

      if (duplicate) {
        setBookmarkFeedback(t("recording", "bookmark.duplicate"));
        return;
      }

      const bookmark = await addBookmark({
        session,
        createdBy: userId,
        label: t("recording", "bookmark.defaultLabel"),
        offsetMs,
      });

      setStatusMsg(null);
      setBookmarkFeedback(
        t("recording", "bookmark.added", {
          time: formatDurationMs(bookmark.recording_offset_ms),
        }),
      );
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setBookmarkPending(false);
    }
  };

  const onSaveNote = async () => {
    if (!userId) {
      setStatusMsg(t("errors", "AUTH_SESSION_EXPIRED"));
      return;
    }
    if (!session || noteText.trim().length === 0) {
      setShowNoteSheet(false);
      return;
    }

    try {
      await addNote({
        session,
        createdBy: userId,
        text: noteText.trim(),
        offsetMs: controller.getSnapshot().offsetMs,
      });
      setNoteText("");
      setShowNoteSheet(false);
      setStatusMsg(null);
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : String(error));
    }
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

  const ingestAsset = async (input: {
    uri: string;
    mime: string;
    fileName: string;
    size: number;
    kind: "image" | "video" | "document";
    width?: number;
    height?: number;
    durationMs?: number;
  }) => {
    if (!session || !userId) {
      if (!userId) setStatusMsg(t("errors", "AUTH_SESSION_EXPIRED"));
      return;
    }

    try {
      await addMediaAsset({
        session,
        addedBy: userId,
        assetType: input.kind,
        mimeType: input.mime,
        originalFileName: input.fileName,
        sourceFileUri: input.uri,
        reportedFileSize: input.size,
        durationMs: input.durationMs ?? null,
        imageWidth: input.width ?? null,
        imageHeight: input.height ?? null,
        offsetMs: controller.getSnapshot().offsetMs,
      });
      setStatusMsg(null);
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : String(error));
    }
  };

  const canPause = snapshot.state === RecordingState.RECORDING;
  const canResume = snapshot.state === RecordingState.PAUSED;
  const canStop = snapshot.state === RecordingState.RECORDING || snapshot.state === RecordingState.PAUSED;
  const meterProgress =
    meter == null
      ? 0
      : Math.max(0.04, Math.min(1, (meter + 60) / 60));

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
            {formatDurationMs(elapsedMs)}
          </Text>
          {meter != null && snapshot.state === RecordingState.RECORDING ? (
            <View
              testID="recording-audio-meter"
              accessibilityLabel={t("recording", "recordingIndicator")}
              style={{
                width: "70%",
                height: 6,
                marginTop: spacing.sm,
                borderRadius: 3,
                overflow: "hidden",
                backgroundColor: colors.border,
              }}
            >
              <View
                style={{
                  width: `${Math.round(meterProgress * 100)}%`,
                  height: "100%",
                  backgroundColor: colors.accent,
                }}
              />
            </View>
          ) : null}
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
              accessibilityRole="button"
              accessibilityLabel={t("recording", "active.addBookmark")}
              accessibilityState={{
                disabled: !canStop || bookmarkPending,
                busy: bookmarkPending,
              }}
              disabled={!canStop || bookmarkPending}
              activeOpacity={0.7}
              style={[
                styles.actionPill,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  opacity: !canStop || bookmarkPending ? 0.5 : 1,
                },
              ]}
              onPress={() => {
                void onBookmark();
              }}
            >
              <Ionicons name="bookmark-outline" size={18} color={colors.textPrimary} />
              <Text style={{ color: colors.textPrimary, marginLeft: 6 }}>
                {bookmarkPending
                  ? t("recording", "bookmark.adding")
                  : t("recording", "active.addBookmark")}
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

          {bookmarkFeedback ? (
            <Text
              testID="recording-bookmark-feedback"
              accessibilityLiveRegion="polite"
              style={[
                typography.caption,
                {
                  color: colors.accent,
                  textAlign: "center",
                },
              ]}
            >
              {bookmarkFeedback}
            </Text>
          ) : null}
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
