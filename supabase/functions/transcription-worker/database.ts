import type {
  NormalizedTranscriptLanguageSummary,
} from "../_shared/transcription/provider.ts";

import {
  parseCleanupClaim,
  parseTranscriptionClaim,
  type CleanupClaim,
  type CleanupFailureState,
  type PollFailureState,
  type RecoveryResult,
  type SubmissionFailureState,
  type TranscriptionClaim,
  type TranscriptionWorkerDatabase,
} from "./core.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkerDatabaseRequest =
  | {
      operation: "recoverExpired";
      parameters: { limit: number };
    }
  | {
      operation: "claimJobs";
      parameters: {
        workerId: string;
        limit: number;
        leaseSeconds: number;
      };
    }
  | {
      operation: "beginSubmission";
      parameters: {
        jobId: string;
        runId: string;
        workerId: string;
      };
    }
  | {
      operation: "markSubmitted";
      parameters: {
        jobId: string;
        runId: string;
        workerId: string;
        providerJobId: string;
        providerMetadata: Readonly<Record<string, unknown>>;
        pollAfterSeconds: number;
        processingTimeoutSeconds: number;
      };
    }
  | {
      operation: "recordSubmissionFailure";
      parameters: {
        jobId: string;
        runId: string;
        workerId: string;
        errorCode: string;
        safeError: string;
        retryable: boolean;
        providerJobId: string | null;
        retryAfterSeconds: number;
      };
    }
  | {
      operation: "recordPollResult";
      parameters: {
        jobId: string;
        runId: string;
        workerId: string;
        providerMetadata: Readonly<Record<string, unknown>>;
        pollAfterSeconds: number;
      };
    }
  | {
      operation: "recordPollFailure";
      parameters: {
        jobId: string;
        runId: string;
        workerId: string;
        errorCode: string;
        safeError: string;
        retryable: boolean;
        providerTerminal: boolean;
        retryAfterSeconds: number;
      };
    }
  | {
      operation: "completeJob";
      parameters: {
        jobId: string;
        runId: string;
        workerId: string;
        providerJobId: string;
        plainText: string;
        languageSummary: NormalizedTranscriptLanguageSummary;
        segments: readonly unknown[];
        providerMetadata: Readonly<Record<string, unknown>>;
        checksumSha256: string;
      };
    }
  | {
      operation: "claimCleanup";
      parameters: {
        workerId: string;
        limit: number;
        leaseSeconds: number;
      };
    }
  | {
      operation: "completeCleanup";
      parameters: {
        runId: string;
        workerId: string;
        providerJobId: string;
      };
    }
  | {
      operation: "failCleanup";
      parameters: {
        runId: string;
        workerId: string;
        errorCode: string;
        safeError: string;
        retryable: boolean;
        retryAfterSeconds: number;
      };
    };

export type WorkerDatabaseOperation = WorkerDatabaseRequest["operation"];

export interface WorkerDatabaseExecutor {
  execute(request: WorkerDatabaseRequest): Promise<readonly unknown[]>;
}

export class TranscriptionWorkerDatabaseError extends Error {
  readonly operation: WorkerDatabaseOperation;

  constructor(operation: WorkerDatabaseOperation) {
    super("TRANSCRIPTION_DATABASE_CALL_FAILED");
    this.name = "TranscriptionWorkerDatabaseError";
    this.operation = operation;
  }
}

const rpcError = (name: string): Error =>
  new Error(`TRANSCRIPTION_DATABASE_RPC_FAILED:${name}`);

const requireRows = (name: string, value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw rpcError(name);
  return value;
};

const requireSingleRow = (name: string, value: unknown): unknown => {
  const rows = requireRows(name, value);
  if (rows.length !== 1) throw rpcError(name);
  return rows[0];
};

const parseRecovery = (value: unknown): RecoveryResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rpcError("recover_expired_transcription_work");
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = [
    "ambiguous_jobs",
    "cleanup_requeued_runs",
    "deadline_failed_jobs",
    "repoll_jobs",
    "requeued_jobs",
  ];
  if (Object.keys(candidate).sort().join(",") !== expectedKeys.join(",")) {
    throw rpcError("recover_expired_transcription_work");
  }
  const integer = (key: string): number => {
    const item = candidate[key];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) {
      throw rpcError("recover_expired_transcription_work");
    }
    return item;
  };
  return {
    requeuedJobs: integer("requeued_jobs"),
    ambiguousJobs: integer("ambiguous_jobs"),
    repollJobs: integer("repoll_jobs"),
    deadlineFailedJobs: integer("deadline_failed_jobs"),
    cleanupRequeuedRuns: integer("cleanup_requeued_runs"),
  };
};

const requireBoolean = (name: string, value: unknown): boolean => {
  if (typeof value !== "boolean") throw rpcError(name);
  return value;
};

const requireUuid = (name: string, value: unknown): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw rpcError(name);
  }
  return value.toLowerCase();
};

const requireState = <T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[],
): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw rpcError(name);
  }
  return value as T;
};

const parseDatabaseTranscriptionClaim = (
  value: unknown,
): TranscriptionClaim => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rpcError("claim_transcription_jobs");
  }

  const durationMs = (value as Record<string, unknown>).duration_ms;
  if (
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0
  ) {
    throw rpcError("claim_transcription_jobs");
  }

  return parseTranscriptionClaim(value);
};

const callDatabase = async <T>(
  executor: WorkerDatabaseExecutor,
  request: WorkerDatabaseRequest,
  parse: (rows: readonly unknown[]) => T,
): Promise<T> => {
  try {
    const rows = await executor.execute(request);
    return parse(requireRows(request.operation, rows));
  } catch {
    throw new TranscriptionWorkerDatabaseError(request.operation);
  }
};

export const createTranscriptionWorkerDatabase = (
  executor: WorkerDatabaseExecutor,
): TranscriptionWorkerDatabase => ({
  recoverExpired: (limit) =>
    callDatabase(
      executor,
      {
        operation: "recoverExpired",
        parameters: { limit },
      },
      (rows) =>
        parseRecovery(
          requireSingleRow("recover_expired_transcription_work", rows),
        ),
    ),

  claimJobs: (input): Promise<TranscriptionClaim[]> =>
    callDatabase(
      executor,
      {
        operation: "claimJobs",
        parameters: input,
      },
      (rows) => {
        if (rows.length > input.limit) throw rpcError("claim_transcription_jobs");
        return rows.map(parseDatabaseTranscriptionClaim);
      },
    ),

  beginSubmission: (input) =>
    callDatabase(
      executor,
      {
        operation: "beginSubmission",
        parameters: input,
      },
      (rows) =>
        requireBoolean(
          "begin_transcription_submission",
          requireSingleRow("begin_transcription_submission", rows),
        ),
    ),

  markSubmitted: (input) =>
    callDatabase(
      executor,
      {
        operation: "markSubmitted",
        parameters: input,
      },
      (rows) =>
        requireBoolean(
          "mark_transcription_job_submitted",
          requireSingleRow("mark_transcription_job_submitted", rows),
        ),
    ),

  recordSubmissionFailure: (input) =>
    callDatabase(
      executor,
      {
        operation: "recordSubmissionFailure",
        parameters: input,
      },
      (rows) =>
        requireState<SubmissionFailureState>(
          "record_transcription_submission_failure",
          requireSingleRow("record_transcription_submission_failure", rows),
          [
            "already_submitted",
            "reconcile_provider_job",
            "retry_submission",
            "failed",
          ],
        ),
    ),

  recordPollResult: (input) =>
    callDatabase(
      executor,
      {
        operation: "recordPollResult",
        parameters: input,
      },
      (rows) =>
        requireBoolean(
          "record_transcription_poll_result",
          requireSingleRow("record_transcription_poll_result", rows),
        ),
    ),

  recordPollFailure: (input) =>
    callDatabase(
      executor,
      {
        operation: "recordPollFailure",
        parameters: input,
      },
      (rows) =>
        requireState<PollFailureState>(
          "record_transcription_poll_failure",
          requireSingleRow("record_transcription_poll_failure", rows),
          ["retry_poll", "retry_new_run", "failed"],
        ),
    ),

  completeJob: (input) =>
    callDatabase(
      executor,
      {
        operation: "completeJob",
        parameters: {
          jobId: input.jobId,
          runId: input.runId,
          workerId: input.workerId,
          providerJobId: input.providerJobId,
          plainText: input.transcript.plainText,
          languageSummary: input.transcript.languageSummary,
          segments: input.transcript.segments,
          providerMetadata: input.transcript.providerMetadata,
          checksumSha256: input.checksumSha256,
        },
      },
      (rows) =>
        requireUuid(
          "complete_transcription_job",
          requireSingleRow("complete_transcription_job", rows),
        ),
    ),

  claimCleanup: (input): Promise<CleanupClaim[]> =>
    callDatabase(
      executor,
      {
        operation: "claimCleanup",
        parameters: input,
      },
      (rows) => {
        if (rows.length > input.limit) {
          throw rpcError("claim_transcription_cleanup");
        }
        return rows.map(parseCleanupClaim);
      },
    ),

  completeCleanup: (input) =>
    callDatabase(
      executor,
      {
        operation: "completeCleanup",
        parameters: input,
      },
      (rows) =>
        requireBoolean(
          "complete_transcription_cleanup",
          requireSingleRow("complete_transcription_cleanup", rows),
        ),
    ),

  failCleanup: (input) =>
    callDatabase(
      executor,
      {
        operation: "failCleanup",
        parameters: input,
      },
      (rows) =>
        requireState<CleanupFailureState>(
          "fail_transcription_cleanup",
          requireSingleRow("fail_transcription_cleanup", rows),
          ["retry_cleanup", "manual_review"],
        ),
    ),
});
