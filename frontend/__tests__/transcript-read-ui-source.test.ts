import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("Milestone 2B.3B local transcript reader source boundary", () => {
  const sessionScreen = read("app/session/[id].tsx");
  const transcriptPanel = read("src/components/SessionTranscriptPanel.tsx");
  const readModel = read("src/services/transcription/read-model.ts");

  it("adds a native transcript tab without changing the existing three tabs", () => {
    expect(sessionScreen).toContain('key: "overview"');
    expect(sessionScreen).toContain('key: "timeline"');
    expect(sessionScreen).toContain('key: "evidence"');
    expect(sessionScreen).toContain('key: "transcript" as const');
    expect(sessionScreen).toContain('Platform.OS === "web"');
    expect(sessionScreen).toContain("<SessionTranscriptPanel");
  });

  it("renders only local cached transcript data and refreshes on sync events", () => {
    expect(transcriptPanel).toContain("loadLocalTranscriptReadModel");
    expect(transcriptPanel).toContain("subscribeTranscriptionSyncChanges");
    expect(transcriptPanel).toContain("selectable");
    expect(transcriptPanel).toContain('testID="session-transcript-text"');
    expect(transcriptPanel).toContain(
      'testID="session-transcript-offline-badge"',
    );
    expect(readModel).toContain("getCurrentTranscriptVersionForSession");
    expect(readModel).toContain("listTranscriptSegmentsForVersion");
  });

  it("does not introduce a provider, Edge Function, or Supabase read path", () => {
    const combined = `${transcriptPanel}
${readModel}`;
    expect(combined).not.toContain("getSupabase");
    expect(combined).not.toContain("@supabase/supabase-js");
    expect(combined).not.toContain("functions.invoke");
    expect(combined).not.toContain("ASSEMBLYAI_API_KEY");
    expect(combined).not.toContain(
      "PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN",
    );
    expect(combined).not.toContain("api.assemblyai.com");
  });
});
