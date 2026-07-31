// Recording controller.
//
// Owns the recording state machine and offset tracker. The expo-audio recorder
// itself is created by React's useAudioRecorder hook and attached through
// attachRecorder(). expo-audio does not expose AudioRecorder as a public
// cross-platform constructor, so this controller must never call
// `new AudioRecorder(...)` directly.
//
// Real device behaviour (background recording, screen lock, foreground service
// notification) requires a development build. The recorder hook is mounted at
// the application root so the native recorder object survives route changes
// and app background/foreground transitions during an active recording.

import * as FileSystem from "expo-file-system/legacy";

import { AppError, ErrorCode } from "@/src/domain/errors";

import { createOffsetTracker } from "./offset-tracker";
import type { OffsetTracker } from "./offset-tracker";
import {
  canTransition,
  nextState,
  RecordingEvent,
  RecordingState,
} from "./state-machine";

/**
 * Permission and audio-session functions do not require React hooks.
 *
 * The module is loaded lazily so pure Jest tests can import this controller
 * without requiring a native Expo runtime.
 */
type ExpoAudioModule = typeof import("expo-audio");

let ExpoAudio: ExpoAudioModule | null = null;

try {
  // Intentional lazy native-module loading for Jest compatibility.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ExpoAudio = require("expo-audio") as ExpoAudioModule;
} catch {
  ExpoAudio = null;
}

/**
 * Narrow recorder surface used by the controller.
 *
 * The real implementation is returned by expo-audio's useAudioRecorder hook.
 * Tests can provide a small fake without loading a native module.
 */
export interface AudioRecorderAdapter {
  readonly uri: string | null;

  prepareToRecordAsync(options?: unknown): Promise<void>;

  record(options?: unknown): void | Promise<void>;

  pause(): void;

  stop(): Promise<void>;

  getStatus?(): {
    canRecord?: boolean;
    durationMillis?: number;
    isRecording?: boolean;
    metering?: number;
    url?: string | null;
  };
}

export interface RecordingSnapshot {
  state: RecordingState;
  offsetMs: number;
  fileUri: string | null;
  isMetered: boolean;

  /**
   * Metering value in dBFS, usually approximately -160 through 0,
   * when the platform and recorder expose it.
   */
  meter: number | null;

  error?: {
    code: string;
    message?: string;
  } | null;
}

export interface RecordingController {
  getSnapshot(): RecordingSnapshot;

  attachRecorder(recorder: AudioRecorderAdapter | null): void;

  requestPermission(): Promise<boolean>;

  start(): Promise<void>;

  pause(): Promise<void>;

  resume(): Promise<void>;

  stop(): Promise<{
    fileUri: string;
    durationMs: number;
    fileSize: number;
  } | null>;

  discard(): Promise<void>;

  subscribe(
    listener: (snapshot: RecordingSnapshot) => void,
  ): () => void;
}

export const createRecordingController = (): RecordingController => {
  let state: RecordingState = RecordingState.IDLE;
  let recorder: AudioRecorderAdapter | null = null;
  let fileUri: string | null = null;
  let error: RecordingSnapshot["error"] = null;

  const tracker: OffsetTracker = createOffsetTracker();
  const listeners = new Set<
    (snapshot: RecordingSnapshot) => void
  >();

  let startOperation: Promise<void> | null = null;
  let resumeOperation: Promise<void> | null = null;

  const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });

  const getRecorderStatus = () => {
    try {
      return recorder?.getStatus?.() ?? null;
    } catch {
      return null;
    }
  };

  const buildSnapshot = (): RecordingSnapshot => {
    const recorderStatus = getRecorderStatus();

    const meter =
      typeof recorderStatus?.metering === "number"
        ? recorderStatus.metering
        : null;

    return {
      state,
      offsetMs: tracker.currentOffsetMs(),
      fileUri,
      isMetered: meter !== null,
      meter,
      error,
    };
  };

  const emit = (): void => {
    const snapshot = buildSnapshot();

    listeners.forEach((listener) => {
      listener(snapshot);
    });
  };

  const transition = (event: RecordingEvent): boolean => {
    if (!canTransition(state, event)) {
      return false;
    }

    const targetState = nextState(state, event);

    if (targetState == null) {
      return false;
    }

    state = targetState;
    emit();

    return true;
  };

  const attachRecorder = (
    nextRecorder: AudioRecorderAdapter | null,
  ): void => {
    recorder = nextRecorder;
    emit();
  };

  const requestPermission = async (): Promise<boolean> => {
    if (!ExpoAudio) {
      throw new AppError(ErrorCode.MICROPHONE_UNAVAILABLE);
    }

    transition(RecordingEvent.REQUEST_PERMISSION);

    try {
      const permission =
        await ExpoAudio.requestRecordingPermissionsAsync();

      const granted =
        permission.granted === true ||
        permission.status === "granted";

      if (!granted) {
        error = {
          code: ErrorCode.MICROPHONE_PERMISSION_DENIED,
        };

        transition(RecordingEvent.PERMISSION_DENIED);

        return false;
      }

      error = null;
      transition(RecordingEvent.PERMISSION_GRANTED);

      return true;
    } catch (cause) {
      error = {
        code: ErrorCode.MICROPHONE_PERMISSION_DENIED,
        message: String(cause),
      };

      transition(RecordingEvent.PERMISSION_DENIED);

      return false;
    }
  };

  const waitForRecorderStatus = async (
    predicate: (status: ReturnType<typeof getRecorderStatus>) => boolean,
    timeoutMs = 1000,
  ): Promise<boolean> => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (predicate(getRecorderStatus())) {
        return true;
      }

      await sleep(25);
    }

    return predicate(getRecorderStatus());
  };

  const activateRecorder = async (): Promise<void> => {
    if (!recorder) {
      throw new Error("Audio recorder is not ready");
    }

    const before = getRecorderStatus();

    // A duplicate caller can arrive while the first native call has already
    // started recording but before the JavaScript state transition is emitted.
    if (before?.isRecording) {
      return;
    }

    if (before?.canRecord === false) {
      throw new Error("Audio recorder is not prepared");
    }

    const invokeRecord = async (): Promise<void> => {
      await Promise.resolve(recorder?.record());
    };

    try {
      await invokeRecord();
    } catch (cause) {
      // Android MediaRecorder can reject a start during a short native-state
      // race. Never call record twice blindly: re-check the native state first
      // and retry only once while the recorder is still prepared.
      await sleep(75);

      const afterFailure = getRecorderStatus();
      if (afterFailure?.isRecording) {
        return;
      }

      if (afterFailure?.canRecord !== true) {
        throw cause;
      }

      await invokeRecord();
    }

    const recordingStarted = await waitForRecorderStatus(
      (status) => status?.isRecording === true,
      750,
    );

    if (!recordingStarted) {
      throw new Error("Audio recorder did not enter the recording state");
    }
  };

  const performStart = async (): Promise<void> => {
    if (!ExpoAudio || !recorder) {
      throw new AppError(
        ErrorCode.MICROPHONE_UNAVAILABLE,
        "Audio recorder is not ready",
      );
    }

    // Allow a new recording or a retry after a terminal state. Clear the
    // previous session's telemetry before emitting IDLE so a new screen never
    // inherits the old elapsed time or terminal error. This does not delete the
    // previously recorded file; it only releases the controller reference.
    if (
      state === RecordingState.SAVED ||
      state === RecordingState.FAILED
    ) {
      tracker.reset();
      fileUri = null;
      error = null;
      transition(RecordingEvent.RESET);
    }

    // If idle, request permission before preparing the recorder.
    if (state === RecordingState.IDLE) {
      const permissionGranted = await requestPermission();

      if (!permissionGranted) {
        throw new AppError(
          ErrorCode.MICROPHONE_PERMISSION_DENIED,
        );
      }
    }

    if (state !== RecordingState.PREPARING) {
      throw new AppError(
        ErrorCode.RECORDING_PREPARE_FAILED,
        "Recorder not in preparing state",
      );
    }

    try {
      await ExpoAudio.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,

        // Keep the Expo audio session active when Android moves the
        // application to the background or the screen is locked.
        shouldPlayInBackground: true,

        // Keep microphone recording alive through Android's foreground
        // recording service.
        allowsBackgroundRecording: true,
      });

      await recorder.prepareToRecordAsync();

      const prepared = await waitForRecorderStatus(
        (status) => status?.canRecord === true,
        750,
      );

      if (!prepared) {
        throw new Error("Audio recorder did not become ready");
      }

      await activateRecorder();

      tracker.reset();
      tracker.start();

      fileUri = null;
      error = null;

      transition(RecordingEvent.PREPARE_SUCCESS);
    } catch (cause) {
      error = {
        code: ErrorCode.RECORDING_PREPARE_FAILED,
        message: String(cause),
      };

      if (state === RecordingState.PREPARING) {
        transition(RecordingEvent.PREPARE_FAILED);
      } else {
        emit();
      }

      throw new AppError(
        ErrorCode.RECORDING_PREPARE_FAILED,
        String(cause),
      );
    }
  };

  const start = async (): Promise<void> => {
    if (startOperation) {
      return startOperation;
    }

    startOperation = performStart();

    try {
      await startOperation;
    } finally {
      startOperation = null;
    }
  };

  const pause = async (): Promise<void> => {
    if (
      !recorder ||
      state !== RecordingState.RECORDING
    ) {
      return;
    }

    try {
      recorder.pause();
      tracker.pause();

      transition(RecordingEvent.PAUSE);
    } catch (cause) {
      error = {
        code: ErrorCode.RECORDING_PAUSE_FAILED,
        message: String(cause),
      };

      emit();

      throw new AppError(
        ErrorCode.RECORDING_PAUSE_FAILED,
        String(cause),
      );
    }
  };

  const performResume = async (): Promise<void> => {
    if (
      !recorder ||
      state !== RecordingState.PAUSED
    ) {
      return;
    }

    try {
      await activateRecorder();
      tracker.resume();

      transition(RecordingEvent.RESUME);
    } catch (cause) {
      error = {
        code: ErrorCode.RECORDING_RESUME_FAILED,
        message: String(cause),
      };

      emit();

      throw new AppError(
        ErrorCode.RECORDING_RESUME_FAILED,
        String(cause),
      );
    }
  };

  const resume = async (): Promise<void> => {
    if (resumeOperation) {
      return resumeOperation;
    }

    resumeOperation = performResume();

    try {
      await resumeOperation;
    } finally {
      resumeOperation = null;
    }
  };

  const stop = async (): Promise<{
    fileUri: string;
    durationMs: number;
    fileSize: number;
  } | null> => {
    if (!recorder) {
      return null;
    }

    if (
      state !== RecordingState.RECORDING &&
      state !== RecordingState.PAUSED
    ) {
      return null;
    }

    transition(RecordingEvent.STOP);

    try {
      await recorder.stop();

      const trackedDurationMs = tracker.stop();
      const recorderStatus = getRecorderStatus();

      const recorderDurationMs =
        typeof recorderStatus?.durationMillis === "number"
          ? recorderStatus.durationMillis
          : 0;

      const durationMs = Math.max(
        trackedDurationMs,
        recorderDurationMs,
      );

      const uri =
        recorder.uri ??
        recorderStatus?.url ??
        null;

      fileUri = uri;

      let fileSize = 0;

      if (uri) {
        try {
          const info = await FileSystem.getInfoAsync(uri);

          if (
            info.exists &&
            "size" in info &&
            typeof info.size === "number"
          ) {
            fileSize = info.size;
          }
        } catch {
          // File-size lookup failure should not invalidate the recording.
          fileSize = 0;
        }
      }

      error = null;
      transition(RecordingEvent.STOP_SUCCESS);

      if (!uri) {
        return null;
      }

      return {
        fileUri: uri,
        durationMs,
        fileSize,
      };
    } catch (cause) {
      error = {
        code: ErrorCode.RECORDING_STOP_FAILED,
        message: String(cause),
      };

      transition(RecordingEvent.STOP_FAILED);

      throw new AppError(
        ErrorCode.RECORDING_STOP_FAILED,
        String(cause),
      );
    }
  };

  const discard = async (): Promise<void> => {
    if (recorder) {
      try {
        const recorderStatus = getRecorderStatus();

        if (recorderStatus?.isRecording) {
          await recorder.stop();
        }
      } catch {
        // Ignore recorder cleanup failures.
      }
    }

    if (fileUri) {
      try {
        await FileSystem.deleteAsync(fileUri, {
          idempotent: true,
        });
      } catch {
        // Ignore local-file cleanup failures.
      }

      fileUri = null;
    }

    tracker.reset();

    state = RecordingState.IDLE;
    error = null;

    emit();
  };

  const subscribe = (
    listener: (snapshot: RecordingSnapshot) => void,
  ): (() => void) => {
    listeners.add(listener);
    listener(buildSnapshot());

    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getSnapshot: buildSnapshot,
    attachRecorder,
    requestPermission,
    start,
    pause,
    resume,
    stop,
    discard,
    subscribe,
  };
};