import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Milestone 2B.3A mobile transcript result source boundary", () => {
  const coordinator = read("src/services/sync/ProjectSyncCoordinator.tsx");
  const resultWorker = read("src/services/sync/transcription-result-worker.ts");
  const resultClient = read("src/services/transcription/result-client.ts");
  const repository = read("src/services/sqlite/repository.ts");
  const migration = read("../supabase/migrations/0013_transcription_foundation_v1.sql");

  it("uses authenticated RLS reads and never invokes the provider/worker", () => {
    expect(resultClient).toContain('.from("processing_jobs")');
    expect(resultClient).toContain('.from("transcription_runs")');
    expect(resultClient).toContain('.from("transcript_versions")');
    expect(resultClient).toContain('.from("transcript_segments")');
    expect(resultClient).not.toContain("ASSEMBLYAI_API_KEY");
    expect(resultClient).not.toContain("PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN");
    expect(resultClient).not.toContain('functions.invoke("transcription-worker"');
    expect(resultClient).not.toContain("api.assemblyai.com");
  });

  it("paginates segment reads and atomically replaces one version's segments", () => {
    expect(resultClient).toContain("SEGMENT_PAGE_SIZE = 500");
    expect(resultClient).toContain(".range(offset, offset + SEGMENT_PAGE_SIZE - 1)");
    expect(repository).toContain("runSerializedLocalTransaction");
    expect(repository).toContain("DELETE FROM local_transcript_segments WHERE transcript_version_id = ?");
    expect(repository).toContain("SET is_current = 0");
  });

  it("wires result sync to lifecycle/network and request submission", () => {
    expect(coordinator).toContain("requestTranscriptionResultSync");
    expect(coordinator).toContain("subscribeTranscriptionRequestSubmissions");
    expect(resultWorker).toContain("getNextTranscriptionResultWakeAt");
  });

  it("relies on existing authenticated read-only RLS policies", () => {
    expect(migration).toContain("processing_jobs_member_select");
    expect(migration).toContain("transcription_runs_member_select");
    expect(migration).toContain("transcript_versions_member_select");
    expect(migration).toContain("transcript_segments_member_select");
    expect(migration).toContain("grant select");
    expect(migration).toContain("to authenticated;");
    expect(migration).toContain("to service_role;");
  });
});
