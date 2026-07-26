import { isDuplicateBookmark } from "@/src/services/session/duplicate-prevention";

describe("bookmark duplicate prevention", () => {
  it("flags bookmarks within a short window at the same offset", () => {
    const existing = [{ recording_offset_ms: 5_000, created_at_ms: 1_000_000 }];
    expect(
      isDuplicateBookmark({ recording_offset_ms: 5_020, created_at_ms: 1_000_100 }, existing, 500),
    ).toBe(true);
  });

  it("does not flag bookmarks far apart in time", () => {
    const existing = [{ recording_offset_ms: 5_000, created_at_ms: 1_000_000 }];
    expect(
      isDuplicateBookmark({ recording_offset_ms: 5_000, created_at_ms: 2_000_000 }, existing, 500),
    ).toBe(false);
  });

  it("does not flag bookmarks at very different offsets", () => {
    const existing = [{ recording_offset_ms: 5_000, created_at_ms: 1_000_000 }];
    expect(
      isDuplicateBookmark({ recording_offset_ms: 15_000, created_at_ms: 1_000_100 }, existing, 500),
    ).toBe(false);
  });
});
