// Pure recording state machine. No side effects.
//
// States match the specification: idle → requesting_permission → preparing
// → recording ⇄ paused → stopping → saved | failed.
//
// The machine is a plain function so it can be unit-tested exhaustively
// without React, Expo, or platform APIs.

export const RecordingState = {
  IDLE: "idle",
  REQUESTING_PERMISSION: "requesting_permission",
  PREPARING: "preparing",
  RECORDING: "recording",
  PAUSED: "paused",
  STOPPING: "stopping",
  SAVED: "saved",
  FAILED: "failed",
} as const;

export type RecordingState = (typeof RecordingState)[keyof typeof RecordingState];

export const RecordingEvent = {
  REQUEST_PERMISSION: "REQUEST_PERMISSION",
  PERMISSION_GRANTED: "PERMISSION_GRANTED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  PREPARE: "PREPARE",
  PREPARE_SUCCESS: "PREPARE_SUCCESS",
  PREPARE_FAILED: "PREPARE_FAILED",
  START: "START",
  START_SUCCESS: "START_SUCCESS",
  PAUSE: "PAUSE",
  RESUME: "RESUME",
  STOP: "STOP",
  STOP_SUCCESS: "STOP_SUCCESS",
  STOP_FAILED: "STOP_FAILED",
  FAIL: "FAIL",
  RESET: "RESET",
} as const;

export type RecordingEvent = (typeof RecordingEvent)[keyof typeof RecordingEvent];

export interface Transition {
  from: RecordingState;
  event: RecordingEvent;
  to: RecordingState;
}

// Whitelist of valid transitions. Anything not listed is rejected.
export const TRANSITIONS: readonly Transition[] = [
  { from: RecordingState.IDLE, event: RecordingEvent.REQUEST_PERMISSION, to: RecordingState.REQUESTING_PERMISSION },
  { from: RecordingState.IDLE, event: RecordingEvent.PREPARE, to: RecordingState.PREPARING },
  { from: RecordingState.REQUESTING_PERMISSION, event: RecordingEvent.PERMISSION_GRANTED, to: RecordingState.PREPARING },
  { from: RecordingState.REQUESTING_PERMISSION, event: RecordingEvent.PERMISSION_DENIED, to: RecordingState.FAILED },
  { from: RecordingState.PREPARING, event: RecordingEvent.PREPARE_SUCCESS, to: RecordingState.RECORDING },
  { from: RecordingState.PREPARING, event: RecordingEvent.PREPARE_FAILED, to: RecordingState.FAILED },
  // Start is implicit after PREPARE_SUCCESS. START event kept for explicit start-after-prepare flows.
  { from: RecordingState.PREPARING, event: RecordingEvent.START, to: RecordingState.RECORDING },
  { from: RecordingState.RECORDING, event: RecordingEvent.PAUSE, to: RecordingState.PAUSED },
  { from: RecordingState.PAUSED, event: RecordingEvent.RESUME, to: RecordingState.RECORDING },
  { from: RecordingState.RECORDING, event: RecordingEvent.STOP, to: RecordingState.STOPPING },
  { from: RecordingState.PAUSED, event: RecordingEvent.STOP, to: RecordingState.STOPPING },
  { from: RecordingState.STOPPING, event: RecordingEvent.STOP_SUCCESS, to: RecordingState.SAVED },
  { from: RecordingState.STOPPING, event: RecordingEvent.STOP_FAILED, to: RecordingState.FAILED },
  // Failures may occur from most active states.
  { from: RecordingState.RECORDING, event: RecordingEvent.FAIL, to: RecordingState.FAILED },
  { from: RecordingState.PAUSED, event: RecordingEvent.FAIL, to: RecordingState.FAILED },
  { from: RecordingState.PREPARING, event: RecordingEvent.FAIL, to: RecordingState.FAILED },
  { from: RecordingState.STOPPING, event: RecordingEvent.FAIL, to: RecordingState.FAILED },
  // Reset returns to idle from terminal states.
  { from: RecordingState.SAVED, event: RecordingEvent.RESET, to: RecordingState.IDLE },
  { from: RecordingState.FAILED, event: RecordingEvent.RESET, to: RecordingState.IDLE },
];

export const canTransition = (from: RecordingState, event: RecordingEvent): boolean =>
  TRANSITIONS.some((t) => t.from === from && t.event === event);

export const nextState = (from: RecordingState, event: RecordingEvent): RecordingState | null => {
  const t = TRANSITIONS.find((x) => x.from === from && x.event === event);
  return t ? t.to : null;
};

export const isActive = (state: RecordingState): boolean =>
  state === RecordingState.RECORDING || state === RecordingState.PAUSED || state === RecordingState.STOPPING;

export const isTerminal = (state: RecordingState): boolean =>
  state === RecordingState.SAVED || state === RecordingState.FAILED;
