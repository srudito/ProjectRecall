// Global recording store: exposes controller + reactive snapshot.
// The controller instance is a singleton for the lifetime of the app. The
// expo-audio recorder itself is created by a React hook at the app root and
// attached to the controller through attachRecorder().

import { create } from "zustand";

import {
  AudioRecorderAdapter,
  createRecordingController,
  RecordingController,
  RecordingSnapshot,
} from "@/src/services/recording/controller";
import { RecordingState } from "@/src/services/recording/state-machine";

interface RecordingStoreValue {
  controller: RecordingController;
  snapshot: RecordingSnapshot;
  attachRecorder: (recorder: AudioRecorderAdapter | null) => void;
  bind: () => () => void;
}

const controller = createRecordingController();

export const useRecordingStore = create<RecordingStoreValue>((set) => ({
  controller,
  snapshot: {
    state: RecordingState.IDLE,
    offsetMs: 0,
    fileUri: null,
    isMetered: false,
    meter: null,
    error: null,
  },
  attachRecorder: (recorder) => {
    controller.attachRecorder(recorder);
  },
  bind: () => {
    const unsubscribe = controller.subscribe((snapshot) => set({ snapshot }));
    return unsubscribe;
  },
}));
