import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  constantTimeTokenMatches,
  classifySupabaseApiKey,
  resolvePrivilegedApiKey,
  resolvePublishableApiKey,
} from "../../supabase/functions/_shared/supabase/server";
import {
  parseTranscriptionRequestBody,
  parseTranscriptionRequestResult,
  normalizeTranscriptionRequestError,
} from "../../supabase/functions/transcription-request/core";
import {
  createTranscriptionWorker,
  DEFAULT_CLEANUP_CLAIM_LIMIT,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  DEFAULT_WORKER_CLAIM_LIMIT,
  parseCleanupClaim,
  parseTranscriptionClaim,
  type RecoveryResult,
  type TranscriptionClaim,
  type TranscriptionWorkerDatabase,
} from "../../supabase/functions/transcription-worker/core";
import {
  TranscriptionProviderError,
  type NormalizedTranscript,
  type TranscriptionProvider,
} from "../../supabase/functions/_shared/transcription/provider";

const readSourceTree = (root: string): string => {
  const output: string[] = [];
  const visit = (path: string): void => {
    const metadata = statSync(path);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        visit(resolve(path, entry));
      }
      return;
    }
    if (/\.(?:ts|tsx|js|json)$/.test(path)) {
      output.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return output.join("\n");
};

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const RECORDING_ID = "55555555-5555-4555-8555-555555555555";
const PROVIDER_JOB_ID = "66666666-6666-4666-8666-666666666666";
const WORKER_ID = "transcription-worker:77777777-7777-4777-8777-777777777777";

const recovery: RecoveryResult = {
  requeuedJobs: 0,
  ambiguousJobs: 0,
  repollJobs: 0,
  deadlineFailedJobs: 0,
  cleanupRequeuedRuns: 0,
};

const claim = (action: "submit" | "poll" = "submit"): TranscriptionClaim => ({
  jobId: JOB_ID,
  runId: RUN_ID,
  action,
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  recordingId: RECORDING_ID,
  privateStoragePath: `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/recording.m4a`,
  mimeType: "audio/mp4",
  durationMs: 1_000,
  requestPayload: {
    contractVersion: 1,
    languageMode: "SINGLE_LANGUAGE",
    requestedLanguages: ["id"],
    speakerDiarization: false,
  },
  providerKey: "assemblyai",
  providerModel: "universal-2",
  providerRegion: "EU",
  providerJobId: action === "poll" ? PROVIDER_JOB_ID : null,
  leaseExpiresAt: "2026-08-10T10:01:00.000Z",
});

const multilingualPollClaim = (): TranscriptionClaim => ({
  ...claim("poll"),
  requestPayload: {
    contractVersion: 1,
    languageMode: "MULTILINGUAL",
    requestedLanguages: ["en", "id"],
    speakerDiarization: false,
  },
});

const transcript: NormalizedTranscript = {
  providerKey: "assemblyai",
  providerModel: "universal-2",
  providerJobId: PROVIDER_JOB_ID,
  plainText: "Halo dunia.",
  languageSummary: {
    primaryLanguage: "id",
    detectedLanguages: ["id"],
    confidence: 0.99,
    detectionEnabled: false,
  },
  segments: [
    {
      segmentIndex: 0,
      startMs: 0,
      endMs: 500,
      text: "Halo",
      confidence: 0.99,
      languageCode: "id",
      speakerLabel: null,
      providerSegmentId: `${PROVIDER_JOB_ID}:word:0`,
    },
  ],
  providerMetadata: {
    status: "completed",
    speechModelUsed: "universal-2",
    audioDurationSeconds: 1,
    languageConfidence: 0.99,
    speakerLabels: false,
    wordCount: 1,
    utteranceCount: 0,
    region: "EU",
  },
};

const database = (
  overrides: Partial<TranscriptionWorkerDatabase> = {},
): TranscriptionWorkerDatabase => ({
  recoverExpired: jest.fn(async () => recovery),
  claimJobs: jest.fn(async () => []),
  beginSubmission: jest.fn(async () => true),
  markSubmitted: jest.fn(async () => true),
  recordSubmissionFailure: jest.fn(async () => "failed"),
  recordPollResult: jest.fn(async () => true),
  recordPollFailure: jest.fn(async () => "failed"),
  completeJob: jest.fn(async () => "88888888-8888-4888-8888-888888888888"),
  claimCleanup: jest.fn(async () => []),
  completeCleanup: jest.fn(async () => true),
  failCleanup: jest.fn(async () => "retry_cleanup"),
  ...overrides,
});

const provider = (
  overrides: Partial<TranscriptionProvider> = {},
): TranscriptionProvider => ({
  providerKey: "assemblyai",
  providerModel: "universal-2",
  submit: jest.fn(async () => ({
    providerKey: "assemblyai",
    providerModel: "universal-2",
    providerJobId: PROVIDER_JOB_ID,
    status: "queued" as const,
    providerMetadata: {
      status: "queued",
      region: "EU",
      speechModelRequested: "universal-2",
    },
  })),
  getStatus: jest.fn(async () => ({
    status: "processing" as const,
    providerJobId: PROVIDER_JOB_ID,
    providerMetadata: { status: "processing", region: "EU" },
  })),
  deleteArtifact: jest.fn(async () => ({
    providerJobId: PROVIDER_JOB_ID,
    deleted: true,
    alreadyAbsent: false,
  })),
  ...overrides,
});

describe("transcription request boundary", () => {
  it("accepts only an exact recordingId request body", () => {
    expect(parseTranscriptionRequestBody({ recordingId: RECORDING_ID })).toEqual({
      recordingId: RECORDING_ID,
    });
    for (const value of [
      null,
      {},
      { recordingId: RECORDING_ID, workspaceId: WORKSPACE_ID },
      { recordingId: ` ${RECORDING_ID}` },
      { recordingId: "not-a-uuid" },
    ]) {
      expect(() => parseTranscriptionRequestBody(value)).toThrow(
        expect.objectContaining({ code: "TRANSCRIPTION_REQUEST_INVALID" }),
      );
    }
  });

  it("normalizes safe RPC result fields and fail-closed error markers", () => {
    expect(
      parseTranscriptionRequestResult([
        {
          job_id: JOB_ID,
          job_status: "queued",
          workspace_id: WORKSPACE_ID,
          session_id: SESSION_ID,
          recording_id: RECORDING_ID,
          created: true,
        },
      ]),
    ).toMatchObject({ jobId: JOB_ID, created: true });

    expect(
      normalizeTranscriptionRequestError({
        code: "P0001",
        message: "TRANSCRIPTION_FEATURE_DISABLED",
      }),
    ).toMatchObject({ code: "TRANSCRIPTION_FEATURE_DISABLED", status: 403 });
  });
});

describe("server credential and worker-token boundary", () => {
  const jwt = (role: string): string => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    return `${encode({ alg: "HS256" })}.${encode({ role })}.signature`;
  };

  it("keeps publishable and privileged Supabase keys in distinct classes", () => {
    expect(classifySupabaseApiKey("sb_publishable_public_test_value")).toBe(
      "publishable",
    );
    expect(classifySupabaseApiKey("sb_secret_server_test_value")).toBe(
      "privileged",
    );
    expect(classifySupabaseApiKey(jwt("anon"))).toBe("publishable");
    expect(classifySupabaseApiKey(jwt("service_role"))).toBe("privileged");
    expect(resolvePublishableApiKey({ publishableKey: "sb_secret_wrong" })).toBeNull();
    expect(resolvePrivilegedApiKey({ legacyServiceRoleKey: "sb_publishable_wrong" })).toBeNull();
    expect(
      resolvePrivilegedApiKey({
        secretKeysJson: JSON.stringify({ default: "sb_secret_server_test_value" }),
      }),
    ).toBe("sb_secret_server_test_value");
    expect(
      resolvePublishableApiKey({
        publishableKeysJson: JSON.stringify({
          secondary: "sb_publishable_secondary_test_value",
          default: "sb_publishable_public_test_value",
        }),
      }),
    ).toBe("sb_publishable_public_test_value");
    expect(
      resolvePublishableApiKey({
        publishableKeysJson: JSON.stringify({ default: "sb_secret_server_test_value" }),
      }),
    ).toBeNull();
    expect(classifySupabaseApiKey(" sb_secret_server_test_value")).toBe(
      "unknown",
    );
    expect(classifySupabaseApiKey("sb_publishable_short")).toBe("unknown");
    expect(
      resolvePublishableApiKey({ publishableKey: jwt("service_role") }),
    ).toBeNull();
    expect(
      resolvePrivilegedApiKey({ legacyServiceRoleKey: jwt("anon") }),
    ).toBeNull();
  });

  it("compares worker tokens without exposing either token", async () => {
    expect(await constantTimeTokenMatches("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(await constantTimeTokenMatches("a".repeat(64), "b".repeat(64))).toBe(false);
  });
});

describe("durable transcription worker", () => {
  it("uses conservative first-rollout worker limits", () => {
    expect(DEFAULT_WORKER_CLAIM_LIMIT).toBe(1);
    expect(DEFAULT_CLEANUP_CLAIM_LIMIT).toBe(1);
    expect(DEFAULT_SIGNED_URL_TTL_SECONDS).toBe(3600);
    expect(() =>
      createTranscriptionWorker({
        database: database(),
        createSignedAudioUrl: jest.fn(),
        getProvider: jest.fn(),
        checksumSha256: jest.fn(),
        workerId: WORKER_ID,
        signedUrlTtlSeconds: 7201,
      }),
    ).toThrow("signedUrlTtlSeconds");
  });

  it("does not construct a provider when there is no durable work", async () => {
    const getProvider = jest.fn(() => provider());
    const worker = createTranscriptionWorker({
      database: database(),
      createSignedAudioUrl: jest.fn(),
      getProvider,
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    const result = await worker.run();

    expect(result.claimed).toBe(0);
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("creates the signed URL before durable submitting state and provider POST", async () => {
    const calls: string[] = [];
    const db = database({
      claimJobs: jest.fn(async () => [claim("submit")]),
      beginSubmission: jest.fn(async () => {
        calls.push("begin");
        return true;
      }),
      markSubmitted: jest.fn(async () => {
        calls.push("persist");
        return true;
      }),
    });
    const p = provider({
      submit: jest.fn(async () => {
        calls.push("provider");
        return {
          providerKey: "assemblyai",
          providerModel: "universal-2",
          providerJobId: PROVIDER_JOB_ID,
          status: "queued" as const,
          providerMetadata: {
            status: "queued",
            region: "EU",
            speechModelRequested: "universal-2",
          },
        };
      }),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(async () => {
        calls.push("signed-url");
        return "https://signed.example/audio";
      }),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    const result = await worker.run();

    expect(calls).toEqual(["signed-url", "begin", "provider", "persist"]);
    expect(result.submitted).toBe(1);
  });

  it("persists ambiguous submission outcomes instead of blind resubmission", async () => {
    const db = database({ claimJobs: jest.fn(async () => [claim("submit")]) });
    const p = provider({
      submit: jest.fn(async () => {
        throw new TranscriptionProviderError({
          code: "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
          retryable: false,
          safeMessage: "The transcription provider submission result could not be confirmed.",
          providerJobId: PROVIDER_JOB_ID,
        });
      }),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(async () => "https://signed.example/audio"),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    await worker.run();

    expect(db.recordSubmissionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: false,
        providerJobId: PROVIDER_JOB_ID,
      }),
    );
    expect(p.submit).toHaveBeenCalledTimes(1);
  });

  it("atomically hands normalized completed results to the database", async () => {
    const db = database({ claimJobs: jest.fn(async () => [claim("poll")]) });
    const p = provider({
      getStatus: jest.fn(async () => ({
        status: "completed" as const,
        providerJobId: PROVIDER_JOB_ID,
        transcript,
      })),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(async () => "a".repeat(64)),
      workerId: WORKER_ID,
    });

    const result = await worker.run();

    expect(result.completed).toBe(1);
    expect(db.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        providerJobId: PROVIDER_JOB_ID,
        transcript,
        checksumSha256: "a".repeat(64),
      }),
    );
  });

  it("reconciles a manual EN-ID response that reports only the primary language", async () => {
    const db = database({
      claimJobs: jest.fn(async () => [multilingualPollClaim()]),
    });
    const p = provider({
      getStatus: jest.fn(async () => ({
        status: "completed" as const,
        providerJobId: PROVIDER_JOB_ID,
        transcript,
      })),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(async () => "a".repeat(64)),
      workerId: WORKER_ID,
    });

    const result = await worker.run();

    expect(result.completed).toBe(1);
    expect(db.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: expect.objectContaining({
          languageSummary: {
            primaryLanguage: "id",
            detectedLanguages: ["en", "id"],
            confidence: 0.99,
            detectionEnabled: false,
          },
          segments: [
            expect.objectContaining({
              languageCode: null,
            }),
          ],
        }),
      }),
    );
  });

  it("preserves an English locale primary while reconciling the EN-ID pair", async () => {
    const db = database({
      claimJobs: jest.fn(async () => [multilingualPollClaim()]),
    });
    const p = provider({
      getStatus: jest.fn(async () => ({
        status: "completed" as const,
        providerJobId: PROVIDER_JOB_ID,
        transcript: {
          ...transcript,
          languageSummary: {
            ...transcript.languageSummary,
            primaryLanguage: "en-us",
            detectedLanguages: ["en", "id"],
          },
          segments: transcript.segments.map((segment) => ({
            ...segment,
            languageCode: null,
          })),
        },
      })),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(async () => "a".repeat(64)),
      workerId: WORKER_ID,
    });

    const result = await worker.run();

    expect(result.completed).toBe(1);
    expect(db.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: expect.objectContaining({
          languageSummary: expect.objectContaining({
            primaryLanguage: "en-us",
            detectedLanguages: ["en-us", "id"],
          }),
        }),
      }),
    );
  });

  it("persists a sanitized provider-result diagnostic without raw payload data", async () => {
    const recordPollFailure = jest.fn(async () => "failed" as const);
    const db = database({
      claimJobs: jest.fn(async () => [claim("poll")]),
      recordPollFailure,
    });
    const p = provider({
      getStatus: jest.fn(async () => {
        throw new TranscriptionProviderError({
          code: "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
          diagnosticCode: "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
          retryable: false,
          safeMessage: "The transcription provider returned an invalid result.",
          providerJobId: PROVIDER_JOB_ID,
        });
      }),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    const result = await worker.run();

    expect(result.failed).toBe(1);
    expect(db.recordPollFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
        safeError: "The transcription provider returned an invalid result.",
        providerTerminal: false,
      }),
    );
    expect(JSON.stringify(recordPollFailure.mock.calls)).not.toContain(
      "audio_url",
    );
  });

  it("persists a claim-language diagnostic for an incompatible EN-ID result", async () => {
    const db = database({
      claimJobs: jest.fn(async () => [multilingualPollClaim()]),
    });
    const p = provider({
      getStatus: jest.fn(async () => ({
        status: "completed" as const,
        providerJobId: PROVIDER_JOB_ID,
        transcript: {
          ...transcript,
          languageSummary: {
            ...transcript.languageSummary,
            primaryLanguage: "fr",
            detectedLanguages: ["fr"],
          },
          segments: transcript.segments.map((segment) => ({
            ...segment,
            languageCode: "fr",
          })),
        },
      })),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    const result = await worker.run();

    expect(result.failed).toBe(1);
    expect(db.recordPollFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "TRANSCRIPTION_PROVIDER_RESULT_CLAIM_LANGUAGE_INVALID",
        safeError: "The transcription provider returned an invalid result.",
        providerTerminal: true,
      }),
    );
    expect(db.completeJob).not.toHaveBeenCalled();
  });

  it("retries provider cleanup without losing the durable provider ID", async () => {
    const db = database({
      claimCleanup: jest.fn(async () => [
        parseCleanupClaim({
          run_id: RUN_ID,
          provider_key: "assemblyai",
          provider_region: "EU",
          provider_job_id: PROVIDER_JOB_ID,
          lease_expires_at: "2026-08-10T10:01:00.000Z",
        }),
      ]),
    });
    const p = provider({
      deleteArtifact: jest.fn(async () => {
        throw new TranscriptionProviderError({
          code: "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN",
          retryable: true,
          safeMessage: "The transcription provider deletion result could not be confirmed.",
          providerJobId: PROVIDER_JOB_ID,
        });
      }),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    const result = await worker.run();

    expect(result.cleanupRetried).toBe(1);
    expect(db.failCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, retryable: true }),
    );
  });

  it("does not start provider submission when signing or durable begin fails", async () => {
    const signingDb = database({
      claimJobs: jest.fn(async () => [claim("submit")]),
    });
    const signingProvider = provider();
    const signingWorker = createTranscriptionWorker({
      database: signingDb,
      createSignedAudioUrl: jest.fn(async () => {
        throw new Error("private signing detail");
      }),
      getProvider: jest.fn(() => signingProvider),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    await signingWorker.run();
    expect(signingProvider.submit).not.toHaveBeenCalled();
    expect(signingDb.beginSubmission).not.toHaveBeenCalled();
    expect(signingDb.recordSubmissionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "TRANSCRIPTION_STORAGE_SIGNING_FAILED",
        retryable: true,
      }),
    );

    const beginDb = database({
      claimJobs: jest.fn(async () => [claim("submit")]),
      beginSubmission: jest.fn(async () => false),
    });
    const beginProvider = provider();
    const beginWorker = createTranscriptionWorker({
      database: beginDb,
      createSignedAudioUrl: jest.fn(async () => "https://signed.example/audio"),
      getProvider: jest.fn(() => beginProvider),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    await beginWorker.run();
    expect(beginProvider.submit).not.toHaveBeenCalled();
  });

  it("reconciles a known provider job when submitted-state persistence is uncertain", async () => {
    const db = database({
      claimJobs: jest.fn(async () => [claim("submit")]),
      markSubmitted: jest.fn(async () => {
        throw new Error("database unavailable");
      }),
      recordSubmissionFailure: jest.fn(async () => "reconcile_provider_job"),
    });
    const p = provider();
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(async () => "https://signed.example/audio"),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    await worker.run();

    expect(p.submit).toHaveBeenCalledTimes(1);
    expect(db.recordSubmissionFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        providerJobId: PROVIDER_JOB_ID,
        retryable: false,
        errorCode: "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
      }),
    );
  });

  it("does not misclassify database completion failures as provider failures", async () => {
    const db = database({
      claimJobs: jest.fn(async () => [claim("poll")]),
      completeJob: jest.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const p = provider({
      getStatus: jest.fn(async () => ({
        status: "completed" as const,
        providerJobId: PROVIDER_JOB_ID,
        transcript,
      })),
    });
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(async () => "a".repeat(64)),
      workerId: WORKER_ID,
    });

    await expect(worker.run()).rejects.toThrow("database unavailable");
    expect(db.recordPollFailure).not.toHaveBeenCalled();
  });

  it("does not convert cleanup persistence failures into provider deletion failures", async () => {
    const db = database({
      claimCleanup: jest.fn(async () => [
        parseCleanupClaim({
          run_id: RUN_ID,
          provider_key: "assemblyai",
          provider_region: "EU",
          provider_job_id: PROVIDER_JOB_ID,
          lease_expires_at: "2026-08-10T10:01:00.000Z",
        }),
      ]),
      completeCleanup: jest.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const p = provider();
    const worker = createTranscriptionWorker({
      database: db,
      createSignedAudioUrl: jest.fn(),
      getProvider: jest.fn(() => p),
      checksumSha256: jest.fn(),
      workerId: WORKER_ID,
    });

    await expect(worker.run()).rejects.toThrow("database unavailable");
    expect(p.deleteArtifact).toHaveBeenCalledWith(PROVIDER_JOB_ID);
    expect(db.failCleanup).not.toHaveBeenCalled();
  });

  it("rejects non-canonical durable language payloads before provider use", () => {
    for (const requestedLanguages of [
      ["en-US"],
      ["id", "en"],
      ["en", "en"],
    ]) {
      expect(() =>
        parseTranscriptionClaim({
          job_id: JOB_ID,
          run_id: RUN_ID,
          action: "submit",
          workspace_id: WORKSPACE_ID,
          session_id: SESSION_ID,
          recording_id: RECORDING_ID,
          private_storage_path: `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/recording.m4a`,
          mime_type: "audio/mp4",
          duration_ms: 10,
          request_payload: {
            contractVersion: 1,
            languageMode:
              requestedLanguages.length === 2 ? "MULTILINGUAL" : "SINGLE_LANGUAGE",
            requestedLanguages,
            speakerDiarization: false,
          },
          provider_key: "assemblyai",
          provider_model: "universal-2",
          provider_region: "EU",
          provider_job_id: null,
          lease_expires_at: "2026-08-10T10:01:00.000Z",
        }),
      ).toThrow("TRANSCRIPTION_CLAIM_INVALID");
    }
  });

  it("rejects malformed claim rows before any provider call", () => {
    expect(() =>
      parseTranscriptionClaim({
        job_id: JOB_ID,
        run_id: RUN_ID,
        action: "submit",
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        recording_id: RECORDING_ID,
        private_storage_path: `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/`,
        mime_type: "audio/mp4",
        duration_ms: 10,
        request_payload: claim().requestPayload,
        provider_key: "assemblyai",
        provider_model: "universal-2",
        provider_region: "EU",
        provider_job_id: null,
        lease_expires_at: "2026-08-10T10:01:00.000Z",
      }),
    ).toThrow("TRANSCRIPTION_CLAIM_INVALID");
  });
});

describe("server-only source boundary", () => {
  it("keeps provider and worker credentials out of mobile source", () => {
    const frontendRoot = resolve(process.cwd());
    const files = [
      readSourceTree(resolve(frontendRoot, "app")),
      readSourceTree(resolve(frontendRoot, "src")),
    ];
    const workerIndex = readFileSync(
      resolve(process.cwd(), "../supabase/functions/transcription-worker/index.ts"),
      "utf8",
    );
    const requestIndex = readFileSync(
      resolve(process.cwd(), "../supabase/functions/transcription-request/index.ts"),
      "utf8",
    );
    const mobileSource = files.join("\n");
    expect(mobileSource).not.toContain("ASSEMBLYAI_API_KEY");
    expect(mobileSource).not.toContain("PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN");
    expect(mobileSource).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(mobileSource).not.toContain("sb_secret_");
    expect(workerIndex).toContain("PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN");
    expect(workerIndex).toContain("ASSEMBLYAI_API_KEY");
    expect(workerIndex).toContain("TRANSCRIPTION_WORKER_REQUEST_INVALID");
    expect(workerIndex).toContain("Object.keys(body).length !== 0");
    expect(requestIndex).toContain("SUPABASE_PUBLISHABLE_KEYS");
    expect(requestIndex).not.toContain("ASSEMBLYAI_API_KEY");
    expect(requestIndex).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
