import {
  RecordingPresets,
  useAudioRecorder,
} from "expo-audio";
import { useLayoutEffect } from "react";

import type { AudioRecorderAdapter } from "@/src/services/recording/controller";
import { useRecordingStore } from "@/src/stores/recording-store";

/**
 * Creates the expo-audio recorder through its supported React hook and keeps it
 * attached to the app-wide recording controller for the lifetime of the root
 * layout. Directly constructing `AudioRecorder` is unsupported on web and was
 * the source of `AudioRecorder is not a constructor`.
 */
export function RecordingAudioCoordinator() {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const attachRecorder = useRecordingStore((state) => state.attachRecorder);

  useLayoutEffect(() => {
    attachRecorder(recorder as AudioRecorderAdapter);

    return () => {
      attachRecorder(null);
    };
  }, [attachRecorder, recorder]);

  return null;
}
