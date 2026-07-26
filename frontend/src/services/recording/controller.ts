// Recording controller.
//
// Owns the expo-audio recorder instance, the recording state machine, and the
// offset tracker. Exposes a small imperative surface used by the UI.
//
// Real device behaviour (background recording, screen lock, foreground service
// notification) requires a development build. This module preserves the
// recorder object across app lifecycle so that resuming the app after
// backgrounding does not silently lose the session.

import * as FileSystem from "expo-file-system/legacy";

import { AppError, ErrorCode } from "@/src/domain/errors";
import { canTransition, nextState, RecordingEvent, RecordingState } from "./state-machine";
import { createOffsetTracker, OffsetTracker } from "./offset-tracker";

// expo-audio APIs are surface-tested here — imports are optional so this file
// can run in Jest with a mock.
// eslint-disable-next-line @typescript-eslint/no-var-requires
let ExpoAudio: any;
try {
  // Lazy require so jest tests without native env still load the file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ExpoAudio = require("expo-audio");
} catch {
  ExpoAudio = null;
}

export interface RecordingSnapshot {
  state: RecordingState;
  offsetMs: number;
  fileUri: string | null;
  isMetered: boolean;
  meter: number | null; // -160..0 dBFS when available
  error?: { code: string; message?: string } | null;
}

export interface RecordingController {
  getSnapshot(): RecordingSnapshot;
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<{ fileUri: string; durationMs: number; fileSize: number } | null>;
  discard(): Promise<void>;
  subscribe(listener: (snap: RecordingSnapshot) => void): () => void;
}

export const createRecordingController = (): RecordingController => {
  let state: RecordingState = RecordingState.IDLE;
  let recorder: any = null;
  let fileUri: string | null = null;
  let error: RecordingSnapshot["error"] = null;
  let meter: number | null = null;
  const tracker: OffsetTracker = createOffsetTracker();
  const listeners = new Set<(snap: RecordingSnapshot) => void>();

  const isMetered = false;

  const buildSnapshot = (): RecordingSnapshot => ({
    state,
    offsetMs: tracker.currentOffsetMs(),
    fileUri,
    isMetered,
    meter,
    error,
  });

  const emit = () => {
    const snap = buildSnapshot();
    listeners.forEach((l) => l(snap));
  };

  const transition = (event: RecordingEvent): boolean => {
    if (!canTransition(state, event)) return false;
    const next = nextState(state, event);
    if (next != null) {
      state = next;
      emit();
      return true;
    }
    return false;
  };

  const requestPermission = async (): Promise<boolean> => {
    if (!ExpoAudio) throw new AppError(ErrorCode.MICROPHONE_UNAVAILABLE);
    transition(RecordingEvent.REQUEST_PERMISSION);
    try {
      const perm = await ExpoAudio.requestRecordingPermissionsAsync();
      const granted = perm?.granted === true || perm?.status === "granted";
      if (!granted) {
        error = { code: ErrorCode.MICROPHONE_PERMISSION_DENIED };
        transition(RecordingEvent.PERMISSION_DENIED);
        return false;
      }
      transition(RecordingEvent.PERMISSION_GRANTED);
      return true;
    } catch (e) {
      error = { code: ErrorCode.MICROPHONE_PERMISSION_DENIED, message: String(e) };
      transition(RecordingEvent.PERMISSION_DENIED);
      return false;
    }
  };

  const start = async (): Promise<void> => {
    if (!ExpoAudio) throw new AppError(ErrorCode.MICROPHONE_UNAVAILABLE);
    // If we're idle but haven't requested permission, do it now.
    if (state === RecordingState.IDLE) {
      const ok = await requestPermission();
      if (!ok) throw new AppError(ErrorCode.MICROPHONE_PERMISSION_DENIED);
    }
    if (state !== RecordingState.PREPARING) {
      throw new AppError(ErrorCode.RECORDING_PREPARE_FAILED, "Recorder not in preparing state");
    }
    try {
      const RecordingPresets = ExpoAudio.RecordingPresets ?? {};
      const preset = RecordingPresets.HIGH_QUALITY ?? RecordingPresets.LOW_QUALITY ?? {};
      recorder = new ExpoAudio.AudioRecorder(preset);
      await recorder.prepareToRecordAsync();
      recorder.record();
      tracker.reset();
      tracker.start();
      error = null;
      transition(RecordingEvent.PREPARE_SUCCESS);
    } catch (e) {
      error = { code: ErrorCode.RECORDING_PREPARE_FAILED, message: String(e) };
      transition(RecordingEvent.PREPARE_FAILED);
      throw new AppError(ErrorCode.RECORDING_PREPARE_FAILED, String(e));
    }
  };

  const pause = async (): Promise<void> => {
    if (!recorder) return;
    if (state !== RecordingState.RECORDING) return;
    try {
      recorder.pause();
      tracker.pause();
      transition(RecordingEvent.PAUSE);
    } catch (e) {
      error = { code: ErrorCode.RECORDING_PAUSE_FAILED, message: String(e) };
      throw new AppError(ErrorCode.RECORDING_PAUSE_FAILED, String(e));
    }
  };

  const resume = async (): Promise<void> => {
    if (!recorder) return;
    if (state !== RecordingState.PAUSED) return;
    try {
      recorder.record();
      tracker.resume();
      transition(RecordingEvent.RESUME);
    } catch (e) {
      error = { code: ErrorCode.RECORDING_RESUME_FAILED, message: String(e) };
      throw new AppError(ErrorCode.RECORDING_RESUME_FAILED, String(e));
    }
  };

  const stop = async (): Promise<{ fileUri: string; durationMs: number; fileSize: number } | null> => {
    if (!recorder) return null;
    transition(RecordingEvent.STOP);
    try {
      await recorder.stop();
      const durationMs = tracker.stop();
      const uri: string | null = recorder.uri ?? null;
      fileUri = uri;
      let fileSize = 0;
      if (uri && FileSystem.getInfoAsync) {
        try {
          const info = await FileSystem.getInfoAsync(uri);
          if (info.exists && "size" in info && typeof info.size === "number") {
            fileSize = info.size;
          }
        } catch {
          fileSize = 0;
        }
      }
      transition(RecordingEvent.STOP_SUCCESS);
      recorder = null;
      if (!uri) return null;
      return { fileUri: uri, durationMs, fileSize };
    } catch (e) {
      error = { code: ErrorCode.RECORDING_STOP_FAILED, message: String(e) };
      transition(RecordingEvent.STOP_FAILED);
      throw new AppError(ErrorCode.RECORDING_STOP_FAILED, String(e));
    }
  };

  const discard = async (): Promise<void> => {
    if (recorder) {
      try {
        await recorder.stop();
      } catch {
        // ignore
      }
      recorder = null;
    }
    if (fileUri) {
      try {
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
      } catch {
        // ignore
      }
      fileUri = null;
    }
    tracker.reset();
    state = RecordingState.IDLE;
    error = null;
    emit();
  };

  const subscribe = (listener: (snap: RecordingSnapshot) => void): (() => void) => {
    listeners.add(listener);
    listener(buildSnapshot());
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getSnapshot: buildSnapshot,
    requestPermission,
    start,
    pause,
    resume,
    stop,
    discard,
    subscribe,
  };
};
