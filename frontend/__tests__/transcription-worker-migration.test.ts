import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "..", relativePath), "utf8");

const normalizeSql = (sql: string): string =>
  sql.replace(/\s+/g, " ").trim().toLowerCase();

describe("Milestone 2B.1B transcription request/worker migration", () => {
  const migration = readRepositoryFile(
    "supabase/migrations/0014_transcription_request_worker_v1.sql",
  );
  const behavior = readRepositoryFile(
    "supabase/tests/0014_transcription_request_worker_behavior.sql",
  );
  const nullablePrimaryMigration = readRepositoryFile(
    "supabase/migrations/0015_transcription_nullable_primary_en_id.sql",
  );
  const nullablePrimaryBehavior = readRepositoryFile(
    "supabase/tests/0015_transcription_nullable_primary_en_id_behavior.sql",
  );
  const config = readRepositoryFile("supabase/config.toml");
  const normalized = normalizeSql(migration);
  const normalizedBehavior = normalizeSql(behavior);
  const normalizedNullablePrimaryMigration = normalizeSql(
    nullablePrimaryMigration,
  );
  const normalizedNullablePrimaryBehavior = normalizeSql(
    nullablePrimaryBehavior,
  );

  it("is append-only after migration 0013", () => {
    const files = readdirSync(
      resolve(process.cwd(), "..", "supabase/migrations"),
    )
      .filter((file) => file.endsWith(".sql"))
      .sort();

    expect(files.slice(-3)).toEqual([
      "0013_transcription_foundation_v1.sql",
      "0014_transcription_request_worker_v1.sql",
      "0015_transcription_nullable_primary_en_id.sql",
    ]);
  });

  it("adds nullable primary support through an append-only narrow migration", () => {
    expect(normalizedNullablePrimaryMigration).toContain(
      "create or replace function public.transcription_language_summary_matches_request",
    );
    expect(normalizedNullablePrimaryMigration).toContain(
      "jsonb_typeof(p_language_summary->'primarylanguage') not in ('string','null')",
    );
    expect(normalizedNullablePrimaryMigration).toContain(
      "normalized_primary is null",
    );
    expect(normalizedNullablePrimaryMigration).toContain(
      "array['en','id']::text[]",
    );
    expect(nullablePrimaryMigration).not.toMatch(/^\s*alter\s+table\b/im);
    expect(nullablePrimaryMigration).not.toMatch(/^\s*drop\s+table\b/im);

    for (const marker of [
      "transcription_nullable_primary_multilingual_check=pass",
      "transcription_nullable_primary_single_language_rejection_check=pass",
      "transcription_nullable_primary_auto_detect_rejection_check=pass",
      "transcription_nullable_primary_pair_requirement_check=pass",
      "transcription_nullable_primary_detection_rejection_check=pass",
      "transcription_string_primary_regression_check=pass",
      "project_recall_transcription_nullable_primary_behavior=pass",
    ]) {
      expect(normalizedNullablePrimaryBehavior).toContain(marker);
    }
    expect(normalizedNullablePrimaryBehavior).toContain("begin;");
    expect(normalizedNullablePrimaryBehavior).toContain("rollback;");
  });

  it("adds the submitting state and makes only leased jobs retain a lease", () => {
    expect(normalized).toContain(
      "status in ('queued','submitting','processing','succeeded','failed','cancelled')",
    );
    expect(normalized).toContain(
      "status = 'leased' and lease_owner is not null and lease_expires_at is not null",
    );
    expect(normalized).toContain(
      "status <> 'leased' and lease_owner is null and lease_expires_at is null",
    );
    expect(normalized).toContain(
      "last_error_code = 'transcription_provider_submission_outcome_unknown'",
    );
    expect(normalized).toContain(
      "create or replace function public.begin_transcription_submission",
    );
    expect(normalized).toContain("set attempt_count = attempt_count + 1");
    expect(normalized).not.toContain(
      "attempt_count = attempt_count + case when selected_job.status = 'queued'",
    );
    expect(normalized).toContain(
      "add constraint transcription_runs_execution_state_check",
    );
    expect(normalized).toContain(
      "provider_cleanup_status = 'succeeded' and provider_cleanup_next_attempt_at is null",
    );
    expect(normalized).toContain(
      "add constraint transcription_runs_terminal_cleanup_check",
    );
  });

  it("keeps immutable request intent and validates canonical private Storage paths", () => {
    expect(normalized).toContain(
      "create or replace function public.is_canonical_transcription_storage_path",
    );
    expect(normalized).toContain(
      "create or replace function public.transcription_request_payload_is_valid",
    );
    expect(normalized).toContain(
      "create trigger guard_processing_job_request_intent",
    );
    expect(normalized).toContain(
      "message = 'transcription_request_intent_immutable'",
    );
  });

  it("creates authenticated request and service-role-only worker RPCs", () => {
    for (const functionName of [
      "request_transcription_job",
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
      "confirm_transcription_provider_absence",
    ]) {
      expect(normalized).toContain(
        `create or replace function public.${functionName}`,
      );
    }

    expect(normalized).toContain(
      "grant execute on function public.request_transcription_job(uuid) to authenticated",
    );
    expect(normalized).toContain(
      "grant execute on function %s to service_role",
    );
  });

  it("resolves PL/pgSQL output-column ambiguity in request idempotency insert", () => {
    const requestStart = normalized.indexOf(
      "create or replace function public.request_transcription_job",
    );
    const requestEnd = normalized.indexOf(
      "revoke all on function public.request_transcription_job(uuid)",
      requestStart,
    );
    const requestBody = normalized.slice(requestStart, requestEnd);

    expect(requestStart).toBeGreaterThanOrEqual(0);
    expect(requestEnd).toBeGreaterThan(requestStart);
    expect(requestBody).toContain("#variable_conflict use_column");
    expect(requestBody).toContain(
      "on conflict (workspace_id, idempotency_key) do nothing",
    );
  });

  it("claims work atomically, reuses queued runs, and bounds recovery", () => {
    expect(normalized).toContain("for update skip locked");
    expect(normalized).toContain(
      "create unique index if not exists idx_processing_jobs_one_active_recording",
    );
    expect(normalized).toContain(
      "job.status in ('queued','leased','processing')",
    );
    expect(normalized).toContain(
      "for update of recording, session_record, member",
    );
    expect(normalized).toContain(
      "prior_run.provider_cleanup_status <> 'succeeded'",
    );
    expect(normalized).toContain(
      "where prior_run.recording_id = job.recording_id",
    );
    expect(normalized).toContain(
      "create index if not exists idx_transcription_runs_recording_cleanup",
    );
    expect(normalized).toContain("limit p_limit");
    expect(normalized).toContain(
      "where run.processing_job_id = selected_job.id and run.status = 'queued'",
    );
    expect(normalized).toContain(
      "provider_processing_deadline_at <= now()",
    );
    expect(normalized).toContain(
      "provider_cleanup_lease_expires_at <= now()",
    );
    expect(normalized).toContain(
      "recording.duration_ms > 0",
    );
    expect(normalized).toContain(
      "public.claim_transcription_jobs(text,integer,integer)",
    );
    expect(normalized).not.toContain(
      "public.claim_transcription_jobs(text,integer,integer,integer)",
    );
    expect(normalized).toContain(
      "p_limit integer default 1, p_lease_seconds integer default 45",
    );
  });

  it("performs result ingestion and provider cleanup using durable transactions", () => {
    expect(normalized).toContain(
      "create or replace function public.complete_transcription_job",
    );
    expect(normalized).toContain(
      "update public.transcript_versions set is_current = false",
    );
    expect(normalized).toContain(
      "insert into public.transcript_segments",
    );
    expect(normalized).toContain(
      "provider_cleanup_status = 'pending'",
    );
    expect(normalized).toContain(
      "create or replace function public.claim_transcription_cleanup",
    );
    expect(normalized).toContain(
      "encode(digest(p_plain_text, 'sha256'), 'hex') <> p_checksum_sha256",
    );
    expect(
      migration.match(/set search_path = public, extensions, pg_temp/g),
    ).toHaveLength(2);
    expect(normalized).toContain("p_checksum_sha256 is null");
    expect(normalized).toContain(
      "message = 'transcription_result_invalid'",
    );
    expect(normalized).toContain(
      "create or replace function public.transcription_jsonb_integer_between",
    );
    expect(normalized).toContain(
      "create or replace function public.transcription_jsonb_number_between",
    );
    expect(normalized).toContain(
      "provider_cleanup_status = 'succeeded'",
    );
  });

  it("blocks unsafe metadata and session/account deletion while provider work remains", () => {
    expect(normalized).toContain(
      "create or replace function public.transcription_provider_metadata_is_safe",
    );
    expect(normalized).toContain(
      "create trigger guard_session_delete_transcription_provider_state",
    );
    expect(normalized).toContain(
      "create or replace function public.guard_processing_job_delete_transcription_provider_state",
    );
    expect(normalized).toContain(
      "create trigger guard_processing_job_delete_transcription_provider_state",
    );
    expect(normalized).toContain(
      "message = 'transcription_provider_submission_in_progress'",
    );
    expect(normalized).toContain(
      "message = 'transcription_provider_cleanup_required'",
    );
    expect(normalized).toContain(
      "create or replace function public.remove_unsubmitted_transcription_requests_on_membership_loss",
    );
    expect(normalized).toContain(
      "create trigger remove_unsubmitted_transcription_requests_on_membership_loss",
    );
    expect(normalized).toContain(
      "where job.workspace_id = lost_workspace_id and job.created_by = lost_user_id and not exists",
    );
    expect(normalized).toContain(
      "create or replace function public.prune_transcription_job_after_membership_loss",
    );
    expect(normalized).toContain(
      "from public.transcript_versions version join public.transcription_runs run on run.id = version.transcription_run_id",
    );
    expect(normalized).toContain(
      "member.membership_status = 'active' for share",
    );
    expect(normalized).not.toContain(
      "job.status in ('queued','leased')",
    );

    const submissionFailureStart = normalized.indexOf(
      "create or replace function public.record_transcription_submission_failure",
    );
    const pollResultStart = normalized.indexOf(
      "create or replace function public.record_transcription_poll_result",
      submissionFailureStart,
    );
    const submissionFailureBody = normalized.slice(
      submissionFailureStart,
      pollResultStart,
    );

    expect(submissionFailureStart).toBeGreaterThanOrEqual(0);
    expect(pollResultStart).toBeGreaterThan(submissionFailureStart);
    expect(
      submissionFailureBody.match(
        /prune_transcription_job_after_membership_loss\(p_job_id\)/g,
      ),
    ).toHaveLength(2);
  });

  it("configures a JWT user endpoint and token-protected worker endpoint", () => {
    expect(config).toContain("[functions.transcription-request]");
    expect(config).toContain("[functions.transcription-worker]");
    expect(config).toMatch(
      /\[functions\.transcription-request\][\s\S]*verify_jwt = true/,
    );
    expect(config).toMatch(
      /\[functions\.transcription-worker\][\s\S]*verify_jwt = false/,
    );
  });

  it("ships disposable runtime behavior checks and keeps the feature disabled", () => {
    for (const marker of [
      "transcription_feature_disabled_request_check=pass",
      "transcription_request_idempotency_check=pass",
      "transcription_active_recording_job_reuse_check=pass",
      "transcription_membership_loss_cancellation_check=pass",
      "transcription_membership_loss_terminal_provider_free_check=pass",
      "transcription_membership_loss_post_submission_failure_check=pass",
      "transcription_membership_loss_post_cleanup_check=pass",
      "transcription_pre_submission_retry_check=pass",
      "transcription_null_retryable_rejection_check=pass",
      "transcription_pre_submission_attempt_accounting_check=pass",
      "transcription_queued_run_reuse_check=pass",
      "transcription_ambiguous_submission_recovery_check=pass",
      "transcription_confirmed_absence_check=pass",
      "transcription_confirmed_absence_retry_check=pass",
      "transcription_submission_reconciliation_check=pass",
      "transcription_provider_deadline_check=pass",
      "transcription_cleanup_manual_review_check=pass",
      "transcription_poll_attempt_accounting_check=pass",
      "transcription_completion_intent_mismatch_check=pass",
      "transcription_atomic_completion_check=pass",
      "transcription_cleanup_retry_check=pass",
      "transcription_new_request_blocked_by_cleanup_check=pass",
      "transcription_retry_blocked_by_cleanup_check=pass",
      "transcription_retry_after_cleanup_check=pass",
      "transcription_recording_delete_gate_check=pass",
      "transcription_session_delete_gate_check=pass",
      "transcription_metadata_secret_rejection_check=pass",
      "transcription_feature_flag_disabled=pass",
      "project_recall_transcription_request_worker_behavior=pass",
    ]) {
      expect(normalizedBehavior).toContain(marker);
    }
    expect(normalizedBehavior).toContain("begin;");
    expect(normalizedBehavior).toContain("rollback;");
    expect(normalized).toContain("where flag_key = 'transcription_enabled'");
    expect(normalized).toContain("set enabled = false");
  });

  it("contains no actual provider or privileged credentials", () => {
    const workerSource = readRepositoryFile(
      "supabase/functions/transcription-worker/index.ts",
    );
    const requestSource = readRepositoryFile(
      "supabase/functions/transcription-request/index.ts",
    );
    const combined = `${migration}\n${behavior}\n${nullablePrimaryMigration}\n${nullablePrimaryBehavior}\n${workerSource}\n${requestSource}`;
    expect(combined).not.toMatch(/sb_secret_[A-Za-z0-9_-]{16,}/);
    expect(combined).not.toMatch(/assemblyai[_-]?api[_-]?key\s*[:=]\s*["'][^"']+/i);
    expect(combined).not.toContain("SUPABASE_SERVICE_ROLE_KEY=");
    expect(requestSource).not.toContain("ASSEMBLYAI_API_KEY");
    expect(requestSource).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
