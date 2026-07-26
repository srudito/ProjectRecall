import { compareTimeline, sortTimeline } from "@/src/services/timeline/ordering";

describe("timeline ordering", () => {
  it("sorts by recording_offset_ms ascending", () => {
    const sorted = sortTimeline([
      { id: "b", recording_offset_ms: 2_000, created_at: "2024-01-01T00:00:02Z" },
      { id: "a", recording_offset_ms: 1_000, created_at: "2024-01-01T00:00:01Z" },
      { id: "c", recording_offset_ms: 3_000, created_at: "2024-01-01T00:00:03Z" },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("ties broken by created_at then id", () => {
    const sorted = sortTimeline([
      { id: "z", recording_offset_ms: 1_000, created_at: "2024-01-01T00:00:00Z" },
      { id: "a", recording_offset_ms: 1_000, created_at: "2024-01-01T00:00:00Z" },
      { id: "m", recording_offset_ms: 1_000, created_at: "2023-12-31T00:00:00Z" },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["m", "a", "z"]);
  });

  it("comparator is total and stable across equal keys", () => {
    expect(
      compareTimeline(
        { id: "x", recording_offset_ms: 1, created_at: "t" },
        { id: "x", recording_offset_ms: 1, created_at: "t" },
      ),
    ).toBe(0);
  });
});
