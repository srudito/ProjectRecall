import { createOffsetTracker, reconcileDuration } from "@/src/services/recording/offset-tracker";

// A deterministic mock clock so tests are stable.
const makeClock = (start = 1_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
};

describe("offset tracker", () => {
  it("offset is zero before start", () => {
    const clock = makeClock();
    const tracker = createOffsetTracker(clock);
    expect(tracker.currentOffsetMs()).toBe(0);
    expect(tracker.isRunning()).toBe(false);
  });

  it("offset grows only while running", () => {
    const clock = makeClock();
    const tracker = createOffsetTracker(clock);
    tracker.start();
    clock.advance(1_500);
    expect(tracker.currentOffsetMs()).toBe(1_500);
    tracker.pause();
    clock.advance(9_999);
    expect(tracker.currentOffsetMs()).toBe(1_500);
    tracker.resume();
    clock.advance(500);
    expect(tracker.currentOffsetMs()).toBe(2_000);
  });

  it("paused duration is excluded (spec example: 60s + pause 30s + 10s = 70s)", () => {
    const clock = makeClock();
    const tracker = createOffsetTracker(clock);
    tracker.start();
    clock.advance(60_000);
    tracker.pause();
    clock.advance(30_000); // long pause
    tracker.resume();
    clock.advance(10_000);
    expect(tracker.currentOffsetMs()).toBe(70_000);
  });

  it("handles multiple pause/resume cycles", () => {
    const clock = makeClock();
    const tracker = createOffsetTracker(clock);
    tracker.start();
    for (let i = 0; i < 5; i++) {
      clock.advance(2_000);
      tracker.pause();
      clock.advance(1_000);
      tracker.resume();
    }
    // 5 * 2s active + 0 tail
    expect(tracker.currentOffsetMs()).toBe(10_000);
  });

  it("stop returns accumulated and freezes offset", () => {
    const clock = makeClock();
    const tracker = createOffsetTracker(clock);
    tracker.start();
    clock.advance(3_000);
    const total = tracker.stop();
    expect(total).toBe(3_000);
    clock.advance(10_000);
    expect(tracker.currentOffsetMs()).toBe(3_000);
  });

  it("snapshot/restore round-trips", () => {
    const clock = makeClock();
    const tracker = createOffsetTracker(clock);
    tracker.start();
    clock.advance(1_234);
    const snap = tracker.snapshot();
    const tracker2 = createOffsetTracker(clock);
    tracker2.restore(snap);
    expect(tracker2.currentOffsetMs()).toBe(1_234);
  });

  it("reconcileDuration prefers max between tracker and recorder", () => {
    expect(reconcileDuration(1000, 1500)).toBe(1500);
    expect(reconcileDuration(1000, 500)).toBe(1000);
    expect(reconcileDuration(1000, null)).toBe(1000);
    expect(reconcileDuration(1000, NaN)).toBe(1000);
  });
});
