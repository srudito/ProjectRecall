import { buildIdempotencyKey, nextBackoffMs, shouldGiveUp } from "@/src/services/upload-queue/backoff";

describe("upload backoff", () => {
  it("returns 0 for attempt <= 0", () => {
    expect(nextBackoffMs(0)).toBe(0);
    expect(nextBackoffMs(-1)).toBe(0);
  });

  it("grows exponentially without jitter", () => {
    const opts = { initialDelayMs: 1_000, backoffFactor: 2, jitterRatio: 0, maxDelayMs: 60_000 };
    expect(nextBackoffMs(1, opts)).toBe(1_000);
    expect(nextBackoffMs(2, opts)).toBe(2_000);
    expect(nextBackoffMs(3, opts)).toBe(4_000);
    expect(nextBackoffMs(4, opts)).toBe(8_000);
  });

  it("caps at maxDelayMs", () => {
    const opts = { initialDelayMs: 1_000, backoffFactor: 2, jitterRatio: 0, maxDelayMs: 5_000 };
    expect(nextBackoffMs(10, opts)).toBe(5_000);
  });

  it("applies deterministic jitter using injected random", () => {
    const opts = { initialDelayMs: 1_000, backoffFactor: 2, jitterRatio: 0.5, maxDelayMs: 100_000, random: () => 0 };
    // random()=0 → factor = 1 + (-1)*0.5 = 0.5
    expect(nextBackoffMs(1, opts)).toBe(500);
    const opts2 = { ...opts, random: () => 1 };
    // random()=1 → factor = 1 + 1*0.5 = 1.5
    expect(nextBackoffMs(1, opts2)).toBe(1_500);
  });

  it("shouldGiveUp respects maxAttempts", () => {
    expect(shouldGiveUp(4, 5)).toBe(false);
    expect(shouldGiveUp(5, 5)).toBe(true);
    expect(shouldGiveUp(10, 5)).toBe(true);
  });

  it("idempotency key is deterministic and stable", () => {
    const key = buildIdempotencyKey(["session", "abc", "asset", 42]);
    expect(key).toBe("session:abc:asset:42");
    expect(buildIdempotencyKey(["session", "abc", "asset", 42])).toBe(key);
  });
});
