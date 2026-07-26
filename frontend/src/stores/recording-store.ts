// Global recording store: exposes controller + reactive snapshot.
// The controller instance is a singleton for the lifetime of the app.

import { create } from "zustand";

import { createRecordingController, RecordingController, RecordingSnapshot } from "@/src/services/recording/controller";
import { RecordingState } from "@/src/services/recording/state-machine";

interface RecordingStoreValue {
  controller: RecordingController;
  snapshot: RecordingSnapshot;
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
  bind: () => {
    const unsubscribe = controller.subscribe((snapshot) => set({ snapshot }));
    return unsubscribe;
  },
}));
