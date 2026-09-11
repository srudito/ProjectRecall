import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED,
  isTranscriptionMutationReleasedForEnvironment,
} from "@/src/config/transcription-release";
import { createTranscriptEditWorker } from "@/src/services/sync/transcript-edit-worker";
import { createTranscriptionRequestWorker } from "@/src/services/sync/transcription-request-worker";

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("C2G.1 production transcription mutation release lock", () => {
  it("keeps production source-locked while preserving development and preview", () => {
    expect(TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED).toBe(false);
    expect(isTranscriptionMutationReleasedForEnvironment("development")).toBe(true);
    expect(isTranscriptionMutationReleasedForEnvironment(" preview ")).toBe(true);
    expect(isTranscriptionMutationReleasedForEnvironment("test")).toBe(true);
    expect(isTranscriptionMutationReleasedForEnvironment("production")).toBe(false);
    expect(isTranscriptionMutationReleasedForEnvironment("prod")).toBe(false);
    expect(isTranscriptionMutationReleasedForEnvironment("")).toBe(false);
  });

  it("does not inspect connectivity, auth, SQLite, or remote request state while locked", async () => {
    const connection = jest.fn(async () => {
      throw new Error("A locked request worker must not inspect connectivity.");
    });
    const worker = createTranscriptionRequestWorker({
      platform: "android",
      isMutationReleased: () => false,
      getConnectionState: connection,
    });

    await expect(worker.run()).resolves.toEqual({
      state: "release_locked",
      processed: 0,
      submitted: 0,
      retried: 0,
      deferred: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(connection).not.toHaveBeenCalled();
  });

  it("does not recover, claim, schedule, or submit edit rows while locked", async () => {
    const connection = jest.fn(async () => {
      throw new Error("A locked edit worker must not inspect connectivity.");
    });
    const resetSubmitting = jest.fn(async () => {
      throw new Error("A locked edit worker must not touch SQLite.");
    });
    const worker = createTranscriptEditWorker({
      platform: "android",
      isMutationReleased: () => false,
      isDeletionPending: () => false,
      isAppActive: () => true,
      getCurrentUserId: () => "11111111-1111-4111-8111-111111111111",
      getConnectionState: connection,
      resetSubmitting,
    });

    await expect(worker.run()).resolves.toEqual({
      state: "release_locked",
      processed: 0,
      succeeded: 0,
      retried: 0,
      deferred: 0,
      conflicts: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(connection).not.toHaveBeenCalled();
    expect(resetSubmitting).not.toHaveBeenCalled();
    worker.dispose();
  });

  it("places the lock before every client mutation entry point", () => {
    const availability = read("src/services/transcription/feature-availability.ts");
    const service = read("src/services/transcription/service.ts");
    const requestWorker = read("src/services/sync/transcription-request-worker.ts");
    const editWorker = read("src/services/sync/transcript-edit-worker.ts");
    const coordinator = read("src/services/sync/ProjectSyncCoordinator.tsx");
    const session = read("app/session/[id].tsx");

    const availabilityBody = availability.indexOf(
      "export const resolveTranscriptionFeatureEnabled",
    );
    expect(availability.indexOf("isTranscriptionMutationReleased()", availabilityBody))
      .toBeLessThan(availability.indexOf("const client =", availabilityBody));

    const queueBody = service.indexOf("export const queueRecordingTranscription");
    expect(service.indexOf("isTranscriptionMutationReleased()", queueBody))
      .toBeLessThan(service.indexOf("upsertTranscriptionRequestIntent(", queueBody));

    const requestExecute = requestWorker.indexOf("const execute = async");
    expect(requestWorker.indexOf("dependencies.isMutationReleased()", requestExecute))
      .toBeLessThan(requestWorker.indexOf("getConnectionState()", requestExecute));
    expect(editWorker).toContain('return "release_locked"');
    expect(coordinator).toContain("if (isTranscriptionMutationReleased())");
    expect(session).toContain(
      "onEdit={transcriptionMutationsReleased ? openEditor : undefined}",
    );

    // Locking new writes must not remove read/result convergence for already
    // submitted work or existing local transcripts.
    expect(coordinator).toContain("requestTranscriptionResultSync();");
    expect(coordinator).toContain("requestTranscriptCurrentVersionSync();");
  });

  it("makes the production release validator enforce the source lock", () => {
    const validator = read("scripts/validate-release-readiness.js");
    expect(validator).toContain(
      "TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED",
    );
    expect(validator).toContain(
      "Production transcription mutations must remain source-locked",
    );
    expect(validator).toContain("app/session/[id].tsx");
  });
});
