import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createTranscriptionWorkerDatabase,
  TranscriptionWorkerDatabaseError,
  type WorkerDatabaseExecutor,
  type WorkerDatabaseRequest,
} from "../../supabase/functions/transcription-worker/database";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const RECORDING_ID = "55555555-5555-4555-8555-555555555555";
const PROVIDER_JOB_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const WORKER_ID = "transcription-worker:88888888-8888-4888-8888-888888888888";
const LEASE_EXPIRES_AT = "2026-09-12T12:00:00.000Z";

const claimRow = {
  job_id: JOB_ID,
  run_id: RUN_ID,
  action: "submit",
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  recording_id: RECORDING_ID,
  private_storage_path: `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/recording.m4a`,
  mime_type: "audio/mp4",
  duration_ms: 1000,
  request_payload: {
    contractVersion: 1,
    languageMode: "SINGLE_LANGUAGE",
    requestedLanguages: ["id"],
    speakerDiarization: false,
  },
  provider_key: "assemblyai",
  provider_model: "universal-2",
  provider_region: "EU",
  provider_job_id: null,
  lease_expires_at: LEASE_EXPIRES_AT,
};

const cleanupRow = {
  run_id: RUN_ID,
  provider_key: "assemblyai",
  provider_region: "EU",
  provider_job_id: PROVIDER_JOB_ID,
  lease_expires_at: LEASE_EXPIRES_AT,
};

const executor = (rows: readonly unknown[] = []): {
  executor: WorkerDatabaseExecutor;
  execute: jest.Mock<Promise<readonly unknown[]>, [WorkerDatabaseRequest]>;
} => {
  const execute = jest.fn(async (_request: WorkerDatabaseRequest) => rows);
  return {
    executor: { execute },
    execute,
  };
};

const expectSingleCall = (
  execute: jest.Mock,
  operation: WorkerDatabaseRequest["operation"],
): WorkerDatabaseRequest => {
  expect(execute).toHaveBeenCalledTimes(1);
  const request = execute.mock.calls[0]?.[0] as WorkerDatabaseRequest;
  expect(request.operation).toBe(operation);
  return request;
};

describe("direct PostgreSQL transcription worker database adapter", () => {
  it("maps recovery through one executor call and validates its exact shape", async () => {
    const harness = executor([
      {
        requeued_jobs: 1,
        ambiguous_jobs: 2,
        repoll_jobs: 3,
        deadline_failed_jobs: 4,
        cleanup_requeued_runs: 5,
      },
    ]);
    const database = createTranscriptionWorkerDatabase(harness.executor);

    await expect(database.recoverExpired(20)).resolves.toEqual({
      requeuedJobs: 1,
      ambiguousJobs: 2,
      repollJobs: 3,
      deadlineFailedJobs: 4,
      cleanupRequeuedRuns: 5,
    });

    expect(expectSingleCall(harness.execute, "recoverExpired").parameters).toEqual({
      limit: 20,
    });
  });

  it("maps job and cleanup claims without changing JSON-friendly field types", async () => {
    const jobHarness = executor([claimRow]);
    const jobDatabase = createTranscriptionWorkerDatabase(jobHarness.executor);

    await expect(
      jobDatabase.claimJobs({
        workerId: WORKER_ID,
        limit: 1,
        leaseSeconds: 45,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        jobId: JOB_ID,
        durationMs: 1000,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
    ]);
    expect(expectSingleCall(jobHarness.execute, "claimJobs").parameters).toEqual({
      workerId: WORKER_ID,
      limit: 1,
      leaseSeconds: 45,
    });

    const cleanupHarness = executor([cleanupRow]);
    const cleanupDatabase = createTranscriptionWorkerDatabase(
      cleanupHarness.executor,
    );
    await expect(
      cleanupDatabase.claimCleanup({
        workerId: WORKER_ID,
        limit: 1,
        leaseSeconds: 45,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        providerJobId: PROVIDER_JOB_ID,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      }),
    ]);
    expect(
      expectSingleCall(cleanupHarness.execute, "claimCleanup").parameters,
    ).toEqual({
      workerId: WORKER_ID,
      limit: 1,
      leaseSeconds: 45,
    });
  });

  it("maps all scalar state transitions through one fixed operation", async () => {
    const cases: {
      operation: WorkerDatabaseRequest["operation"];
      rows: readonly unknown[];
      invoke: (database: ReturnType<typeof createTranscriptionWorkerDatabase>) =>
        Promise<unknown>;
      expected: unknown;
    }[] = [
      {
        operation: "beginSubmission",
        rows: [true],
        invoke: (database) =>
          database.beginSubmission({
            jobId: JOB_ID,
            runId: RUN_ID,
            workerId: WORKER_ID,
          }),
        expected: true,
      },
      {
        operation: "markSubmitted",
        rows: [true],
        invoke: (database) =>
          database.markSubmitted({
            jobId: JOB_ID,
            runId: RUN_ID,
            workerId: WORKER_ID,
            providerJobId: PROVIDER_JOB_ID,
            providerMetadata: {
              status: "queued",
              region: "EU",
              speechModelRequested: "universal-2",
            },
            pollAfterSeconds: 15,
            processingTimeoutSeconds: 3600,
          }),
        expected: true,
      },
      {
        operation: "recordSubmissionFailure",
        rows: ["retry_submission"],
        invoke: (database) =>
          database.recordSubmissionFailure({
            jobId: JOB_ID,
            runId: RUN_ID,
            workerId: WORKER_ID,
            errorCode: "TRANSCRIPTION_PROVIDER_NETWORK_FAILED",
            safeError: "Provider unavailable.",
            retryable: true,
            providerJobId: null,
            retryAfterSeconds: 30,
          }),
        expected: "retry_submission",
      },
      {
        operation: "recordPollResult",
        rows: [true],
        invoke: (database) =>
          database.recordPollResult({
            jobId: JOB_ID,
            runId: RUN_ID,
            workerId: WORKER_ID,
            providerMetadata: { status: "processing", region: "EU" },
            pollAfterSeconds: 15,
          }),
        expected: true,
      },
      {
        operation: "recordPollFailure",
        rows: ["retry_poll"],
        invoke: (database) =>
          database.recordPollFailure({
            jobId: JOB_ID,
            runId: RUN_ID,
            workerId: WORKER_ID,
            errorCode: "TRANSCRIPTION_PROVIDER_NETWORK_FAILED",
            safeError: "Provider unavailable.",
            retryable: true,
            providerTerminal: false,
            retryAfterSeconds: 30,
          }),
        expected: "retry_poll",
      },
      {
        operation: "completeCleanup",
        rows: [true],
        invoke: (database) =>
          database.completeCleanup({
            runId: RUN_ID,
            workerId: WORKER_ID,
            providerJobId: PROVIDER_JOB_ID,
          }),
        expected: true,
      },
      {
        operation: "failCleanup",
        rows: ["retry_cleanup"],
        invoke: (database) =>
          database.failCleanup({
            runId: RUN_ID,
            workerId: WORKER_ID,
            errorCode: "TRANSCRIPTION_PROVIDER_DELETION_FAILED",
            safeError: "Provider cleanup failed.",
            retryable: true,
            retryAfterSeconds: 60,
          }),
        expected: "retry_cleanup",
      },
    ];

    for (const testCase of cases) {
      const harness = executor(testCase.rows);
      const database = createTranscriptionWorkerDatabase(harness.executor);
      await expect(testCase.invoke(database)).resolves.toEqual(testCase.expected);
      expectSingleCall(harness.execute, testCase.operation);
    }
  });

  it("hands completion JSON to one operation and accepts only a UUID result", async () => {
    const harness = executor([VERSION_ID]);
    const database = createTranscriptionWorkerDatabase(harness.executor);
    const transcript = {
      providerKey: "assemblyai" as const,
      providerModel: "universal-2" as const,
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

    await expect(
      database.completeJob({
        jobId: JOB_ID,
        runId: RUN_ID,
        workerId: WORKER_ID,
        providerJobId: PROVIDER_JOB_ID,
        transcript,
        checksumSha256: "a".repeat(64),
      }),
    ).resolves.toBe(VERSION_ID);

    const request = expectSingleCall(harness.execute, "completeJob");
    expect(request.parameters).toMatchObject({
      jobId: JOB_ID,
      runId: RUN_ID,
      workerId: WORKER_ID,
      providerJobId: PROVIDER_JOB_ID,
      plainText: "Halo dunia.",
      languageSummary: transcript.languageSummary,
      segments: transcript.segments,
      providerMetadata: transcript.providerMetadata,
      checksumSha256: "a".repeat(64),
    });
  });

  it("fails closed on cardinality, enum, UUID, claim-count, and unsafe bigint drift", async () => {
    const cases: (() => Promise<unknown>)[] = [
      () => createTranscriptionWorkerDatabase(executor([]).executor).beginSubmission({
        jobId: JOB_ID,
        runId: RUN_ID,
        workerId: WORKER_ID,
      }),
      () =>
        createTranscriptionWorkerDatabase(executor([true, true]).executor)
          .beginSubmission({
            jobId: JOB_ID,
            runId: RUN_ID,
            workerId: WORKER_ID,
          }),
      () =>
        createTranscriptionWorkerDatabase(executor(["unexpected"]).executor)
          .recordPollFailure({
            jobId: JOB_ID,
            runId: RUN_ID,
            workerId: WORKER_ID,
            errorCode: "TRANSCRIPTION_PROVIDER_NETWORK_FAILED",
            safeError: "Provider unavailable.",
            retryable: true,
            providerTerminal: false,
            retryAfterSeconds: 30,
          }),
      () =>
        createTranscriptionWorkerDatabase(executor(["not-a-uuid"]).executor)
          .completeJob({
            jobId: JOB_ID,
            runId: RUN_ID,
            workerId: WORKER_ID,
            providerJobId: PROVIDER_JOB_ID,
            transcript: {} as never,
            checksumSha256: "a".repeat(64),
          }),
      () =>
        createTranscriptionWorkerDatabase(
          executor([claimRow, claimRow]).executor,
        ).claimJobs({ workerId: WORKER_ID, limit: 1, leaseSeconds: 45 }),
      () =>
        createTranscriptionWorkerDatabase(
          executor([
            {
              ...claimRow,
              duration_ms: Number.MAX_SAFE_INTEGER + 1,
            },
          ]).executor,
        ).claimJobs({ workerId: WORKER_ID, limit: 1, leaseSeconds: 45 }),
    ];

    for (const invoke of cases) {
      await expect(invoke()).rejects.toBeInstanceOf(
        TranscriptionWorkerDatabaseError,
      );
    }
  });

  it("never retries and never propagates raw driver details", async () => {
    const execute = jest.fn(async (_request: WorkerDatabaseRequest) => {
      throw new Error(
        "raw-driver-detail query=$1 private-value",
      );
    });
    const database = createTranscriptionWorkerDatabase({ execute });

    let caught: unknown;
    try {
      await database.recoverExpired(20);
    } catch (error) {
      caught = error;
    }

    expect(execute).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(TranscriptionWorkerDatabaseError);
    expect(caught).toMatchObject({
      message: "TRANSCRIPTION_DATABASE_CALL_FAILED",
      operation: "recoverExpired",
    });
    expect(String(caught)).not.toContain("raw-driver-detail");
    expect(String(caught)).not.toContain("private-value");
  });
});

describe("fixed direct-PostgreSQL source boundary", () => {
  const readRepositoryFile = (relativePath: string): string =>
    readFileSync(resolve(process.cwd(), "..", relativePath), "utf8");

  const postgresSource = readRepositoryFile(
    "supabase/functions/transcription-worker/postgres.ts",
  );
  const workerIndex = readRepositoryFile(
    "supabase/functions/transcription-worker/index.ts",
  );
  const denoConfig = readRepositoryFile(
    "supabase/functions/transcription-worker/deno.json",
  );

  it("pins Postgres.js and uses conservative transaction-pooler options", () => {
    expect(denoConfig).toContain('"postgres": "npm:postgres@3.4.9"');
    expect(postgresSource).toContain("max: 1");
    expect(postgresSource).toContain("prepare: false");
    expect(postgresSource).toContain('ssl: "require"');
    expect(postgresSource).toContain("connect_timeout: 10");
    expect(postgresSource).toContain("fetch_types: false");
    expect(postgresSource).toContain("debug: false");
    expect(postgresSource).toContain("onnotice: () => undefined");
    expect(postgresSource).toContain('const TRANSACTION_POOLER_PORT = "6543"');
    expect(postgresSource).toContain("\\.pooler\\.supabase\\.com");
  });

  it("uses exactly eleven fixed function calls and no dynamic/raw query escape hatch", () => {
    const functionNames = [
      "recover_expired_transcription_work",
      "claim_transcription_jobs",
      "begin_transcription_submission",
      "mark_transcription_job_submitted",
      "record_transcription_submission_failure",
      "record_transcription_poll_result",
      "record_transcription_poll_failure",
      "complete_transcription_job",
      "claim_transcription_cleanup",
      "complete_transcription_cleanup",
      "fail_transcription_cleanup",
    ];

    for (const functionName of functionNames) {
      expect(postgresSource).toContain(`public.${functionName}(`);
    }
    expect(postgresSource.match(/public\.[a-z_]+\(/g)).toHaveLength(11);
    expect(postgresSource).not.toContain("sql.unsafe");
    expect(postgresSource).not.toContain(".unsafe(");
    expect(postgresSource).not.toContain(".cancel(");
    expect(postgresSource).not.toContain("sql.end(");
    expect(postgresSource).not.toContain("for (let attempt");
    expect(postgresSource).toContain("pg_catalog.to_jsonb");
    expect(postgresSource).toContain("JSON.stringify(value,");
  });

  it("keeps the database URL out of logs and exposes only a fixed operation name", () => {
    expect(postgresSource).toContain(
      "PROJECT_RECALL_TRANSCRIPTION_WORKER_DATABASE_URL",
    );
    expect(workerIndex).not.toContain("postgres://");
    expect(workerIndex).not.toContain("error.stack");
    expect(workerIndex).not.toContain("String(error)");
    expect(workerIndex).toContain("operation: error.operation");
  });
});
