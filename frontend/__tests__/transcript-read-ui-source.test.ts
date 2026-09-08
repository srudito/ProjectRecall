import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("Milestone 2B.3C timestamped transcript browser source boundary", () => {
  const sessionScreen = read("app/session/[id].tsx");
  const transcriptPanel = read("src/components/SessionTranscriptPanel.tsx");
  const readModel = read("src/services/transcription/read-model.ts");

  it("retains the native transcript tab and continuous local text view", () => {
    expect(sessionScreen).toContain('key: "overview"');
    expect(sessionScreen).toContain('key: "timeline"');
    expect(sessionScreen).toContain('key: "evidence"');
    expect(sessionScreen).toContain('key: "transcript" as const');
    expect(sessionScreen).toContain('Platform.OS === "web"');
    expect(sessionScreen).toContain("<SessionTranscriptPanel");
    expect(transcriptPanel).toContain('testID="session-transcript-text"');
    expect(transcriptPanel).toContain("selectable");
  });

  it("adds accessible continuous/timestamped controls and bounded segment rendering", () => {
    expect(transcriptPanel).toContain('type TranscriptViewMode = "continuous" | "segments"');
    expect(transcriptPanel).toContain("SEGMENT_BATCH_SIZE = 100");
    expect(transcriptPanel).toContain(
      'testID={`session-transcript-view-${mode}`}',
    );
    expect(transcriptPanel).toContain("accessibilityState={{ selected }}");
    expect(transcriptPanel).toContain(
      'testID="session-transcript-segment-list"',
    );
    expect(transcriptPanel).toContain(
      'testID="session-transcript-show-more"',
    );
    expect(transcriptPanel).toContain("segment.timestampLabel");
    expect(transcriptPanel).toContain("segment.speakerLabel");
    expect(transcriptPanel).toContain("segment.languageCode");
  });

  it("builds timestamp rows from validated local SQLite segments", () => {
    expect(readModel).toContain("getCurrentTranscriptVersionForSession");
    expect(readModel).toContain("listTranscriptSegmentsForVersion");
    expect(readModel).toContain("buildLocalTranscriptSegmentRows");
    expect(readModel).toContain("formatTranscriptSegmentTimeRange");
    expect(readModel).toContain("formatDurationMs");
    expect(readModel).toContain("seenIds");
  });

  it("does not introduce remote reads, provider calls, playback seeking, or direct transcript mutation", () => {
    const combined = `${transcriptPanel}
${readModel}`;
    for (const forbidden of [
      "getSupabase",
      "@supabase/supabase-js",
      "functions.invoke",
      "ASSEMBLYAI_API_KEY",
      "PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN",
      "api.assemblyai.com",
      "seekTo",
      "setPositionAsync",
      "updateTranscript",
      "exportTranscript",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });
  it("hosts the writer outside the tab and uses labelled immutable evidence", () => {
    expect(sessionScreen).toContain("<TranscriptEditorModal");
    expect(sessionScreen).toContain("editorScope.userId === userId");
    expect(sessionScreen).toContain("editorScope.workspaceId === session.workspace_id");
    expect(transcriptPanel).toContain("loadLocalTranscriptReadModelWithEvidence");
    expect(transcriptPanel).toContain("evidence.segmentRows");
    expect(transcriptPanel).toContain("transcript.evidenceProvenance");
    expect(transcriptPanel).toContain("transcript.evidenceUnavailable");
    const ui = read("src/components/TranscriptEditorModal.tsx") + read("src/hooks/use-transcript-editor.ts");
    for (const forbidden of ["getSupabase", ".rpc(", "enqueueGuardedTranscriptEditSnapshot", "updateTranscript", "setPositionAsync"]) {
      expect(ui).not.toContain(forbidden);
    }
    expect(ui).toContain("onRequestClose={requestClose}");
    expect(ui).not.toContain("maxLength=");
  });

});
