import postgres from "postgres";

import { requireServerEnvironment } from "../_shared/supabase/server.ts";
import type {
  WorkerDatabaseExecutor,
  WorkerDatabaseRequest,
} from "./database.ts";

const DATABASE_URL_ENV =
  "PROJECT_RECALL_TRANSCRIPTION_WORKER_DATABASE_URL";
const WORKER_DATABASE_ROLE = "project_recall_transcription_worker";
const TRANSACTION_POOLER_PORT = "6543";
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const POOLER_HOST_PATTERN = /^[a-z0-9.-]+\.pooler\.supabase\.com$/;

type PostgresClient = ReturnType<typeof postgres>;
type PayloadRow = Readonly<{ payload: unknown }>;

let cachedClient: PostgresClient | null = null;

const invalidDatabaseUrl = (): never => {
  throw new Error("TRANSCRIPTION_DATABASE_URL_INVALID");
};

const projectRefFromSupabaseUrl = (rawUrl: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return invalidDatabaseUrl();
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname.endsWith(".supabase.co")
  ) {
    return invalidDatabaseUrl();
  }

  const projectRef = parsed.hostname.slice(0, -".supabase.co".length);
  if (!PROJECT_REF_PATTERN.test(projectRef)) return invalidDatabaseUrl();
  return projectRef;
};

export const validateWorkerDatabaseUrl = (
  rawDatabaseUrl: string,
  rawSupabaseUrl: string,
): string => {
  const projectRef = projectRefFromSupabaseUrl(rawSupabaseUrl);

  let parsed: URL;
  try {
    parsed = new URL(rawDatabaseUrl);
  } catch {
    return invalidDatabaseUrl();
  }

  const sslMode = parsed.searchParams.get("sslmode");
  let searchParameterCount = 0;
  parsed.searchParams.forEach(() => {
    searchParameterCount += 1;
  });
  const expectedUsername = `${WORKER_DATABASE_ROLE}.${projectRef}`;
  let username: string;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    return invalidDatabaseUrl();
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !POOLER_HOST_PATTERN.test(parsed.hostname) ||
    parsed.port !== TRANSACTION_POOLER_PORT ||
    parsed.pathname !== "/postgres" ||
    username !== expectedUsername ||
    !parsed.password ||
    parsed.hash ||
    searchParameterCount > (sslMode === null ? 0 : 1) ||
    (sslMode !== null && sslMode !== "require")
  ) {
    return invalidDatabaseUrl();
  }

  return rawDatabaseUrl;
};

const createClient = (): PostgresClient => {
  const connectionString = validateWorkerDatabaseUrl(
    requireServerEnvironment(DATABASE_URL_ENV, Deno.env.get(DATABASE_URL_ENV)),
    requireServerEnvironment("SUPABASE_URL", Deno.env.get("SUPABASE_URL")),
  );

  return postgres(connectionString, {
    max: 1,
    prepare: false,
    ssl: "require",
    connect_timeout: 10,
    fetch_types: false,
    debug: false,
    onnotice: () => undefined,
  });
};

const databaseClient = (): PostgresClient => {
  cachedClient ??= createClient();
  return cachedClient;
};

const jsonParameter = (value: unknown): string => {
  if (value === undefined) {
    throw new Error("TRANSCRIPTION_DATABASE_JSON_INVALID");
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (
        nestedValue === undefined ||
        typeof nestedValue === "function" ||
        typeof nestedValue === "symbol" ||
        typeof nestedValue === "bigint" ||
        (typeof nestedValue === "number" && !Number.isFinite(nestedValue))
      ) {
        throw new Error("TRANSCRIPTION_DATABASE_JSON_INVALID");
      }
      return nestedValue;
    });
  } catch {
    throw new Error("TRANSCRIPTION_DATABASE_JSON_INVALID");
  }

  if (serialized === undefined) {
    throw new Error("TRANSCRIPTION_DATABASE_JSON_INVALID");
  }
  return serialized;
};

const parsePayloadRows = (rows: readonly PayloadRow[]): readonly unknown[] =>
  rows.map((row) => {
    if (!row || typeof row !== "object" || typeof row.payload !== "string") {
      throw new Error("TRANSCRIPTION_DATABASE_RESULT_INVALID");
    }
    try {
      return JSON.parse(row.payload) as unknown;
    } catch {
      throw new Error("TRANSCRIPTION_DATABASE_RESULT_INVALID");
    }
  });

const executeFixedQuery = async (
  sql: PostgresClient,
  request: WorkerDatabaseRequest,
): Promise<readonly unknown[]> => {
  switch (request.operation) {
    case "recoverExpired": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(worker_row)::text as payload
        from public.recover_expired_transcription_work(
          ${request.parameters.limit}::integer
        ) as worker_row
      `;
      return parsePayloadRows(rows);
    }

    case "claimJobs": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(worker_row)::text as payload
        from public.claim_transcription_jobs(
          ${request.parameters.workerId}::text,
          ${request.parameters.limit}::integer,
          ${request.parameters.leaseSeconds}::integer
        ) as worker_row
      `;
      return parsePayloadRows(rows);
    }

    case "beginSubmission": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(
          public.begin_transcription_submission(
            ${request.parameters.jobId}::uuid,
            ${request.parameters.runId}::uuid,
            ${request.parameters.workerId}::text
          )
        )::text as payload
      `;
      return parsePayloadRows(rows);
    }

    case "markSubmitted": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(
          public.mark_transcription_job_submitted(
            ${request.parameters.jobId}::uuid,
            ${request.parameters.runId}::uuid,
            ${request.parameters.workerId}::text,
            ${request.parameters.providerJobId}::text,
            ${jsonParameter(request.parameters.providerMetadata)}::jsonb,
            ${request.parameters.pollAfterSeconds}::integer,
            ${request.parameters.processingTimeoutSeconds}::integer
          )
        )::text as payload
      `;
      return parsePayloadRows(rows);
    }

    case "recordSubmissionFailure": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(
          public.record_transcription_submission_failure(
            ${request.parameters.jobId}::uuid,
            ${request.parameters.runId}::uuid,
            ${request.parameters.workerId}::text,
            ${request.parameters.errorCode}::text,
            ${request.parameters.safeError}::text,
            ${request.parameters.retryable}::boolean,
            ${request.parameters.providerJobId}::text,
            ${request.parameters.retryAfterSeconds}::integer
          )
        )::text as payload
      `;
      return parsePayloadRows(rows);
    }

    case "recordPollResult": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(
          public.record_transcription_poll_result(
            ${request.parameters.jobId}::uuid,
            ${request.parameters.runId}::uuid,
            ${request.parameters.workerId}::text,
            ${jsonParameter(request.parameters.providerMetadata)}::jsonb,
            ${request.parameters.pollAfterSeconds}::integer
          )
        )::text as payload
      `;
      return parsePayloadRows(rows);
    }

    case "recordPollFailure": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(
          public.record_transcription_poll_failure(
            ${request.parameters.jobId}::uuid,
            ${request.parameters.runId}::uuid,
            ${request.parameters.workerId}::text,
            ${request.parameters.errorCode}::text,
            ${request.parameters.safeError}::text,
            ${request.parameters.retryable}::boolean,
            ${request.parameters.providerTerminal}::boolean,
            ${request.parameters.retryAfterSeconds}::integer
          )
        )::text as payload
      `;
      return parsePayloadRows(rows);
    }

    case "completeJob": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(
          public.complete_transcription_job(
            ${request.parameters.jobId}::uuid,
            ${request.parameters.runId}::uuid,
            ${request.parameters.workerId}::text,
            ${request.parameters.providerJobId}::text,
            ${request.parameters.plainText}::text,
            ${jsonParameter(request.parameters.languageSummary)}::jsonb,
            ${jsonParameter(request.parameters.segments)}::jsonb,
            ${jsonParameter(request.parameters.providerMetadata)}::jsonb,
            ${request.parameters.checksumSha256}::text
          )
        )::text as payload
      `;
      return parsePayloadRows(rows);
    }

    case "claimCleanup": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(worker_row)::text as payload
        from public.claim_transcription_cleanup(
          ${request.parameters.workerId}::text,
          ${request.parameters.limit}::integer,
          ${request.parameters.leaseSeconds}::integer
        ) as worker_row
      `;
      return parsePayloadRows(rows);
    }

    case "completeCleanup": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(
          public.complete_transcription_cleanup(
            ${request.parameters.runId}::uuid,
            ${request.parameters.workerId}::text,
            ${request.parameters.providerJobId}::text
          )
        )::text as payload
      `;
      return parsePayloadRows(rows);
    }

    case "failCleanup": {
      const rows = await sql<PayloadRow[]>`
        select pg_catalog.to_jsonb(
          public.fail_transcription_cleanup(
            ${request.parameters.runId}::uuid,
            ${request.parameters.workerId}::text,
            ${request.parameters.errorCode}::text,
            ${request.parameters.safeError}::text,
            ${request.parameters.retryable}::boolean,
            ${request.parameters.retryAfterSeconds}::integer
          )
        )::text as payload
      `;
      return parsePayloadRows(rows);
    }
  }
};

export const createTranscriptionWorkerPostgresExecutor =
  (): WorkerDatabaseExecutor => ({
    execute: (request) => executeFixedQuery(databaseClient(), request),
  });
