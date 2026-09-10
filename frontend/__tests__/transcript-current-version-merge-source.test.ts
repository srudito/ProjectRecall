import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("C2C current-version pull merge convergence", () => {
  const types = read("src/services/transcription/result-types.ts");
  const client = read("src/services/transcription/current-version-client.ts");
  const repository = read("src/services/sqlite/repository.ts");
  const start = repository.indexOf("const currentTranscriptMergeConflict");
  const end = repository.indexOf("export const getLocalProcessingJob", start);
  const persistence = repository.slice(start, end);

  it("carries independent exact segment counts across the authenticated boundary", () => {
    expect(types).toContain("currentExpectedSegmentCount: number");
    expect(types).toContain("evidenceExpectedSegmentCount: number | null");
    expect(client).toContain('.select(SEGMENT_SELECT, { count: "exact" })');
    expect(client).toContain("segment.segment_index !== segments.length");
    expect(client).toContain("response.count !== expectedSegmentCount");
    expect(client).toContain("TRANSCRIPT_CURRENT_SEGMENT_COUNT_MISMATCH");
  });

  it("uses the shared immutable and append-only planners before pointer authority", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(persistence).toContain("planTranscriptCacheVersion");
    expect(persistence).toContain("planTranscriptCacheSegments");
    expect(persistence).toContain('{ kind: "partial" }');
    expect(persistence).toContain('{ kind: "complete", expectedSegmentCount:');
    expect(persistence).toContain("currentExpectedSegmentCount");
    expect(persistence).toContain("evidenceExpectedSegmentCount");
  });

  it("never replaces immutable evidence and switches current rows with exact guards", () => {
    expect(persistence).not.toContain("DELETE FROM local_transcript_segments");
    expect(persistence).not.toMatch(
      /INSERT INTO local_transcript_(?:versions|segments)[\s\S]*?ON CONFLICT/,
    );
    expect(persistence).not.toContain(
      "WHERE session_id = ? AND id <> ?",
    );
    expect(persistence).toContain(
      "WHERE id = ? AND workspace_id = ? AND session_id = ? AND is_current = 1",
    );
    expect(persistence).toContain(
      "WHERE id = ? AND workspace_id = ? AND session_id = ? AND is_current = 0",
    );
  });

  it("retains current-version pull limits without activating history hydration", () => {
    expect(client).toContain("MAX_SEGMENTS = 100_000");
    expect(client).not.toContain("MAX_HISTORY_CACHE_SEGMENTS");
    expect(persistence).not.toContain("local_sync_state");
    expect(persistence).not.toContain("requestTranscriptHistory");
  });
});
