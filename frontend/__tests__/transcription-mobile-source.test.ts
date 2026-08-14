import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("Milestone 2B.2 mobile transcription request source wiring", () => {
  it("invokes only the authenticated transcription-request Edge Function", () => {
    const client = read("src/services/transcription/request-client.ts");

    expect(client).toContain('client.functions.invoke("transcription-request"');
    expect(client).toContain("Authorization: `Bearer ${session.access_token}`");
    expect(client).not.toContain("ASSEMBLYAI_API_KEY");
    expect(client).not.toContain("PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN");
    expect(client).not.toContain("transcription-worker");
  });

  it("keeps the local request worker wired to lifecycle and network sync", () => {
    const coordinator = read("src/services/sync/ProjectSyncCoordinator.tsx");

    expect(coordinator).toContain(
      'import { requestTranscriptionRequestSync } from "./transcription-request-worker"',
    );
    expect(
      coordinator.match(/requestTranscriptionRequestSync\(\);/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps the recording UI provider-neutral and feature-flagged", () => {
    const panel = read("src/components/SessionRecordingPanel.tsx");
    const control = read(
      "src/components/RecordingTranscriptionRequestControl.tsx",
    );

    expect(panel).toContain("RecordingTranscriptionRequestControl");
    expect(control).toContain("resolveTranscriptionFeatureEnabled");
    expect(control).toContain("queueRecordingTranscription");
    expect(control).toContain('testID="session-recording-transcription-button"');
    expect(control).toContain('recording.upload_status !== "failed"');
    expect(control).toContain('recording.upload_status !== "cancelled"');
    expect(control).not.toContain("AssemblyAI");
    expect(control).not.toContain("ASSEMBLYAI_API_KEY");
  });

  it("retains idempotent local queue uniqueness from the Milestone 2A schema", () => {
    const migration = read("src/services/sqlite/migrations.ts");
    const repository = read("src/services/sqlite/repository.ts");

    expect(migration).toContain("UNIQUE(user_id, workspace_id, idempotency_key)");
    expect(repository).toContain(
      "ON CONFLICT(user_id, workspace_id, idempotency_key) DO UPDATE SET",
    );
    expect(repository).toContain("server_job_id");
    expect(repository).toContain("WHEN attempt_count > 0 THEN attempt_count - 1");
  });

  it("keeps feature availability as a non-authoritative cached UX hint", () => {
    const availability = read(
      "src/services/transcription/feature-availability.ts",
    );
    const worker = read("src/services/sync/transcription-request-worker.ts");

    expect(availability).toContain('from("feature_flags")');
    expect(availability).toContain('eq("flag_key", "transcription_enabled")');
    expect(availability).toContain("return readCached()");
    expect(worker).toContain(
      'normalized.code === "TRANSCRIPTION_FEATURE_DISABLED"',
    );
    expect(worker).toContain("deferOperation");
  });
});
