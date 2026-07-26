// Recording-offset calculation.
//
// The offset stored on notes, bookmarks, photos, videos, and documents must
// represent the position INSIDE the recorded audio — paused time excluded.
//
// We keep a running "active" duration by tracking segments:
//   segment_start (monotonic ms) → active recording begins
//   segment_stop  (monotonic ms) → active recording pauses
// The current offset is: sum(previous segment lengths) + (now - segment_start)
// if currently recording, or just the accumulated total if paused.
//
// Uses a supplied clock so tests are deterministic.

export interface Clock {
  now(): number;
}

export const defaultClock: Clock = {
  now: () => Date.now(),
};

export interface OffsetTrackerState {
  accumulatedMs: number;
  segmentStartMs: number | null; // monotonic timestamp of current active segment start
}

export interface OffsetTracker {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): number;
  reset(): void;
  currentOffsetMs(): number;
  isRunning(): boolean;
  snapshot(): OffsetTrackerState;
  restore(state: OffsetTrackerState): void;
}

export const createOffsetTracker = (clock: Clock = defaultClock): OffsetTracker => {
  let accumulatedMs = 0;
  let segmentStartMs: number | null = null;

  const currentOffsetMs = (): number => {
    if (segmentStartMs == null) {
      return accumulatedMs;
    }
    return accumulatedMs + (clock.now() - segmentStartMs);
  };

  const start = (): void => {
    if (segmentStartMs == null) {
      segmentStartMs = clock.now();
    }
  };

  const pause = (): void => {
    if (segmentStartMs != null) {
      accumulatedMs += clock.now() - segmentStartMs;
      segmentStartMs = null;
    }
  };

  const resume = (): void => {
    if (segmentStartMs == null) {
      segmentStartMs = clock.now();
    }
  };

  const stop = (): number => {
    pause();
    return accumulatedMs;
  };

  const reset = (): void => {
    accumulatedMs = 0;
    segmentStartMs = null;
  };

  const isRunning = (): boolean => segmentStartMs != null;

  const snapshot = (): OffsetTrackerState => ({
    accumulatedMs,
    segmentStartMs,
  });

  const restore = (state: OffsetTrackerState): void => {
    accumulatedMs = state.accumulatedMs;
    segmentStartMs = state.segmentStartMs;
  };

  return { start, pause, resume, stop, reset, currentOffsetMs, isRunning, snapshot, restore };
};

// Reconcile persisted duration with the actual recorder status.
// Prefer recorderReportedMs when available; otherwise fall back to tracker value.
export const reconcileDuration = (trackerMs: number, recorderReportedMs: number | null): number => {
  if (recorderReportedMs == null || !Number.isFinite(recorderReportedMs) || recorderReportedMs < 0) {
    return trackerMs;
  }
  // Recorder-reported duration excludes paused time on both Android and iOS
  // (expo-audio). Take the max of the two as the safe value.
  return Math.max(trackerMs, Math.round(recorderReportedMs));
};
