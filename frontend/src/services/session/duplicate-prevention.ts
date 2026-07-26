// Duplicate prevention for bookmarks based on rapid taps.
//
// Two bookmarks within `windowMs` of each other at the same offset are
// considered a duplicate. Pure function so we can test it independently.

export interface BookmarkSignature {
  recording_offset_ms: number;
  created_at_ms: number; // milliseconds since epoch
}

export const isDuplicateBookmark = (
  candidate: BookmarkSignature,
  existing: readonly BookmarkSignature[],
  windowMs = 500,
): boolean => {
  return existing.some(
    (b) =>
      Math.abs(b.recording_offset_ms - candidate.recording_offset_ms) <= windowMs &&
      Math.abs(b.created_at_ms - candidate.created_at_ms) <= windowMs,
  );
};
