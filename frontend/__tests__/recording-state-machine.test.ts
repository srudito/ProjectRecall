import {
  canTransition,
  isActive,
  isTerminal,
  nextState,
  RecordingEvent,
  RecordingState,
} from "@/src/services/recording/state-machine";

describe("recording state machine", () => {
  it("starts idle and allows request-permission", () => {
    expect(canTransition(RecordingState.IDLE, RecordingEvent.REQUEST_PERMISSION)).toBe(true);
    expect(nextState(RecordingState.IDLE, RecordingEvent.REQUEST_PERMISSION)).toBe(
      RecordingState.REQUESTING_PERMISSION,
    );
  });

  it("rejects starting from recording (double-start prevention)", () => {
    expect(canTransition(RecordingState.RECORDING, RecordingEvent.START)).toBe(false);
    expect(canTransition(RecordingState.RECORDING, RecordingEvent.PREPARE)).toBe(false);
  });

  it("rejects double-stop (STOP from STOPPING)", () => {
    expect(canTransition(RecordingState.STOPPING, RecordingEvent.STOP)).toBe(false);
  });

  it("cannot pause when not recording", () => {
    expect(canTransition(RecordingState.IDLE, RecordingEvent.PAUSE)).toBe(false);
    expect(canTransition(RecordingState.PAUSED, RecordingEvent.PAUSE)).toBe(false);
    expect(canTransition(RecordingState.SAVED, RecordingEvent.PAUSE)).toBe(false);
  });

  it("cannot resume when not paused", () => {
    expect(canTransition(RecordingState.IDLE, RecordingEvent.RESUME)).toBe(false);
    expect(canTransition(RecordingState.RECORDING, RecordingEvent.RESUME)).toBe(false);
  });

  it("allows pause and resume from valid states", () => {
    expect(nextState(RecordingState.RECORDING, RecordingEvent.PAUSE)).toBe(RecordingState.PAUSED);
    expect(nextState(RecordingState.PAUSED, RecordingEvent.RESUME)).toBe(RecordingState.RECORDING);
  });

  it("supports stop from recording and paused, then success/failure", () => {
    expect(nextState(RecordingState.RECORDING, RecordingEvent.STOP)).toBe(RecordingState.STOPPING);
    expect(nextState(RecordingState.PAUSED, RecordingEvent.STOP)).toBe(RecordingState.STOPPING);
    expect(nextState(RecordingState.STOPPING, RecordingEvent.STOP_SUCCESS)).toBe(RecordingState.SAVED);
    expect(nextState(RecordingState.STOPPING, RecordingEvent.STOP_FAILED)).toBe(RecordingState.FAILED);
  });

  it("resets from terminal states back to idle", () => {
    expect(nextState(RecordingState.SAVED, RecordingEvent.RESET)).toBe(RecordingState.IDLE);
    expect(nextState(RecordingState.FAILED, RecordingEvent.RESET)).toBe(RecordingState.IDLE);
  });

  it("classifies active and terminal states", () => {
    expect(isActive(RecordingState.RECORDING)).toBe(true);
    expect(isActive(RecordingState.PAUSED)).toBe(true);
    expect(isActive(RecordingState.STOPPING)).toBe(true);
    expect(isActive(RecordingState.IDLE)).toBe(false);
    expect(isTerminal(RecordingState.SAVED)).toBe(true);
    expect(isTerminal(RecordingState.FAILED)).toBe(true);
    expect(isTerminal(RecordingState.RECORDING)).toBe(false);
  });
});
