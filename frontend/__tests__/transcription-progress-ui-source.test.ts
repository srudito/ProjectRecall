import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("Milestone 2B.4A.1 transcription progress UI wiring", () => {
  it("derives progress messaging from durable local request diagnostics", () => {
    const control = read(
      "src/components/RecordingTranscriptionRequestControl.tsx",
    );

    expect(control).toContain("resolveTranscriptionRequestPresentation");
    expect(control).toContain("request.last_error_code");
    expect(control).toContain("presentation.detailKey");
    expect(control).toContain("presentation?.showSafeError");
    expect(control).not.toContain("{request?.last_safe_error ? (");
  });

  it("uses the local current transcript as the ready signal", () => {
    const control = read(
      "src/components/RecordingTranscriptionRequestControl.tsx",
    );

    expect(control).toContain("getCurrentTranscriptVersionForSession");
    expect(control).toContain("setTranscriptReady(currentVersion != null)");
    expect(control).not.toContain('.from("transcript_versions")');
    expect(control).not.toContain("functions.invoke");
  });

  it("does not change result-worker retry or polling semantics", () => {
    const worker = read("src/services/sync/transcription-result-worker.ts");

    expect(worker).toContain('reason === "result"');
    expect(worker).toContain("return 3_000");
    expect(worker).toContain('reason === "cleanup"');
    expect(worker).toContain("return 10_000");
    expect(worker).toContain("nextBackoffMs(attempt");
  });
});
