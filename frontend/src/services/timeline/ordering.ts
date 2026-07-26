// Timeline ordering.
//
// Sort by:
//   1. recording_offset_ms
//   2. created_at
//   3. stable deterministic event id
//
// The comparator is a pure function so it can be unit tested exhaustively.

export interface TimelineOrderInput {
  id: string;
  recording_offset_ms: number;
  created_at: string; // ISO timestamp
}

export const compareTimeline = (a: TimelineOrderInput, b: TimelineOrderInput): number => {
  if (a.recording_offset_ms !== b.recording_offset_ms) {
    return a.recording_offset_ms - b.recording_offset_ms;
  }
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
};

export const sortTimeline = <T extends TimelineOrderInput>(items: readonly T[]): T[] => {
  return [...items].sort(compareTimeline);
};
