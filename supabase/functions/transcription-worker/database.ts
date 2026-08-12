import type { SupabaseClient } from "@supabase/supabase-js";

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

const rpcError = (name: string): Error =>
  new Error(`TRANSCRIPTION_DATABASE_RPC_FAILED:${name}`);

const requireNoError = <T>(
  name: string,
  response: { data: T | null; error: unknown },
): T | null => {
  if (response.error) throw rpcError(name);
  return response.data;
};

const parseRecovery = (value: unknown): RecoveryResult => {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw rpcError("recover_expired_transcription_work");
  }
  const candidate = row as Record<string, unknown>;
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

export const createTranscriptionWorkerDatabase = (
  client: SupabaseClient,
): TranscriptionWorkerDatabase => ({
  recoverExpired: async (limit) => {
    const response = await client.rpc("recover_expired_transcription_work", {
      p_limit: limit,
    });
    return parseRecovery(
      requireNoError("recover_expired_transcription_work", response),
    );
  },

  claimJobs: async (input): Promise<TranscriptionClaim[]> => {
    const response = await client.rpc("claim_transcription_jobs", {
      p_worker_id: input.workerId,
      p_limit: input.limit,
      p_lease_seconds: input.leaseSeconds,
    });
    const data = requireNoError("claim_transcription_jobs", response);
    if (data === null) return [];
    if (!Array.isArray(data)) throw rpcError("claim_transcription_jobs");
    return data.map(parseTranscriptionClaim);
  },

  beginSubmission: async (input) => {
    const response = await client.rpc("begin_transcription_submission", {
      p_job_id: input.jobId,
      p_run_id: input.runId,
      p_worker_id: input.workerId,
    });
    return requireBoolean(
      "begin_transcription_submission",
      requireNoError("begin_transcription_submission", response),
    );
  },

  markSubmitted: async (input) => {
    const response = await client.rpc("mark_transcription_job_submitted", {
      p_job_id: input.jobId,
      p_run_id: input.runId,
      p_worker_id: input.workerId,
      p_provider_job_id: input.providerJobId,
      p_provider_metadata: input.providerMetadata,
      p_poll_after_seconds: input.pollAfterSeconds,
      p_processing_timeout_seconds: input.processingTimeoutSeconds,
    });
    return requireBoolean(
      "mark_transcription_job_submitted",
      requireNoError("mark_transcription_job_submitted", response),
    );
  },

  recordSubmissionFailure: async (input) => {
    const response = await client.rpc("record_transcription_submission_failure", {
      p_job_id: input.jobId,
      p_run_id: input.runId,
      p_worker_id: input.workerId,
      p_error_code: input.errorCode,
      p_safe_error: input.safeError,
      p_retryable: input.retryable,
      p_provider_job_id: input.providerJobId,
      p_retry_after_seconds: input.retryAfterSeconds,
    });
    return requireState<SubmissionFailureState>(
      "record_transcription_submission_failure",
      requireNoError("record_transcription_submission_failure", response),
      [
        "already_submitted",
        "reconcile_provider_job",
        "retry_submission",
        "failed",
      ],
    );
  },

  recordPollResult: async (input) => {
    const response = await client.rpc("record_transcription_poll_result", {
      p_job_id: input.jobId,
      p_run_id: input.runId,
      p_worker_id: input.workerId,
      p_provider_metadata: input.providerMetadata,
      p_poll_after_seconds: input.pollAfterSeconds,
    });
    return requireBoolean(
      "record_transcription_poll_result",
      requireNoError("record_transcription_poll_result", response),
    );
  },

  recordPollFailure: async (input) => {
    const response = await client.rpc("record_transcription_poll_failure", {
      p_job_id: input.jobId,
      p_run_id: input.runId,
      p_worker_id: input.workerId,
      p_error_code: input.errorCode,
      p_safe_error: input.safeError,
      p_retryable: input.retryable,
      p_provider_terminal: input.providerTerminal,
      p_retry_after_seconds: input.retryAfterSeconds,
    });
    return requireState<PollFailureState>(
      "record_transcription_poll_failure",
      requireNoError("record_transcription_poll_failure", response),
      ["retry_poll", "retry_new_run", "failed"],
    );
  },

  completeJob: async (input) => {
    const response = await client.rpc("complete_transcription_job", {
      p_job_id: input.jobId,
      p_run_id: input.runId,
      p_worker_id: input.workerId,
      p_provider_job_id: input.providerJobId,
      p_plain_text: input.transcript.plainText,
      p_language_summary: input.transcript.languageSummary,
      p_segments: input.transcript.segments,
      p_provider_metadata: input.transcript.providerMetadata,
      p_checksum_sha256: input.checksumSha256,
    });
    return requireUuid(
      "complete_transcription_job",
      requireNoError("complete_transcription_job", response),
    );
  },

  claimCleanup: async (input): Promise<CleanupClaim[]> => {
    const response = await client.rpc("claim_transcription_cleanup", {
      p_worker_id: input.workerId,
      p_limit: input.limit,
      p_lease_seconds: input.leaseSeconds,
    });
    const data = requireNoError("claim_transcription_cleanup", response);
    if (data === null) return [];
    if (!Array.isArray(data)) throw rpcError("claim_transcription_cleanup");
    return data.map(parseCleanupClaim);
  },

  completeCleanup: async (input) => {
    const response = await client.rpc("complete_transcription_cleanup", {
      p_run_id: input.runId,
      p_worker_id: input.workerId,
      p_provider_job_id: input.providerJobId,
    });
    return requireBoolean(
      "complete_transcription_cleanup",
      requireNoError("complete_transcription_cleanup", response),
    );
  },

  failCleanup: async (input) => {
    const response = await client.rpc("fail_transcription_cleanup", {
      p_run_id: input.runId,
      p_worker_id: input.workerId,
      p_error_code: input.errorCode,
      p_safe_error: input.safeError,
      p_retryable: input.retryable,
      p_retry_after_seconds: input.retryAfterSeconds,
    });
    return requireState<CleanupFailureState>(
      "fail_transcription_cleanup",
      requireNoError("fail_transcription_cleanup", response),
      ["retry_cleanup", "manual_review"],
    );
  },
});
