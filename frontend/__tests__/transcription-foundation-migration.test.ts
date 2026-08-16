import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "..", relativePath), "utf8");

const normalizeSql = (sql: string): string =>
  sql.replace(/\s+/g, " ").trim().toLowerCase();

describe("Milestone 2 batch-transcription foundation migration", () => {
  const migrationPath =
    "supabase/migrations/0013_transcription_foundation_v1.sql";
  const migration = readRepositoryFile(migrationPath);
  const behaviorVerification = readRepositoryFile(
    "supabase/tests/0013_transcription_foundation_behavior.sql",
  );
  const normalized = normalizeSql(migration);
  const normalizedBehaviorVerification = normalizeSql(behaviorVerification);

  it("is the next append-only migration after the verified Milestone 1 set", () => {
    const migrationFiles = readdirSync(
      resolve(process.cwd(), "..", "supabase/migrations"),
    )
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

    const foundationIndex = migrationFiles.indexOf(
      "0013_transcription_foundation_v1.sql",
    );

    expect(foundationIndex).toBeGreaterThan(0);
    expect(migrationFiles[foundationIndex - 1]).toBe(
      "0012_profile_account_deletion_gate.sql",
    );
    expect(migrationFiles[foundationIndex + 1]).toBe(
      "0014_transcription_request_worker_v1.sql",
    );
  });

  it("locks and fails closed if the disabled Milestone 1 foundation already has data", () => {
    expect(normalized).toContain(
      "lock table public.processing_jobs, public.transcription_runs, public.transcript_versions in access exclusive mode",
    );
    expect(normalized).toContain(
      "message = 'transcription_foundation_already_in_use'",
    );
    expect(normalized).toContain("exists (select 1 from public.processing_jobs)");
    expect(normalized).toContain("exists (select 1 from public.transcription_runs)");
    expect(normalized).toContain("exists (select 1 from public.transcript_versions)");
  });

  it("binds jobs and runs to canonical recording/session/workspace scope", () => {
    expect(normalized).toContain(
      "foreign key (recording_id, session_id, workspace_id) references public.recordings(id, session_id, workspace_id)",
    );
    expect(normalized).toContain(
      "foreign key (processing_job_id, session_id, workspace_id, recording_id) references public.processing_jobs(id, session_id, workspace_id, recording_id)",
    );
    expect(normalized).toContain(
      "unique (workspace_id, idempotency_key)",
    );
    expect(normalized).toContain(
      "unique (processing_job_id, run_attempt)",
    );
    expect(normalized).toContain(
      "created_by uuid references auth.users(id) on delete set null",
    );
    expect(normalized).not.toContain("requested_by uuid");
  });

  it("uses one canonical scoped run foreign key with deterministic delete behavior", () => {
    expect(normalized).toContain(
      "drop constraint if exists transcript_versions_transcription_run_id_fkey",
    );
    expect(normalized).toContain(
      "foreign key (transcription_run_id, session_id, workspace_id) references public.transcription_runs(id, session_id, workspace_id) on delete set null (transcription_run_id)",
    );
    expect(
      normalized.match(
        /foreign key \(transcription_run_id, session_id, workspace_id\)/g,
      ),
    ).toHaveLength(1);
  });

  it("ships disposable PostgreSQL checks for run, job, session, workspace, and Delete Account behavior", () => {
    for (const marker of [
      "transcription_run_delete_set_null_check=pass",
      "transcription_job_delete_graph_check=pass",
      "transcription_session_delete_cascade_check=pass",
      "transcription_workspace_delete_cascade_check=pass",
      "delete_account_owned_workspace_transcription_block=pass",
      "delete_account_shared_transcription_block=pass",
      "delete_account_active_gate_transcription_cascade_check=pass",
      "transcription_privilege_matrix_check=pass",
      "transcription_rls_read_only=pass",
      "transcript_segment_guard=pass",
      "transcription_feature_flag_disabled=pass",
      "project_recall_transcription_foundation_behavior=pass",
    ]) {
      expect(normalizedBehaviorVerification).toContain(marker);
    }

    expect(normalizedBehaviorVerification).toContain("begin;");
    expect(normalizedBehaviorVerification).toContain("rollback;");
    expect(normalizedBehaviorVerification).toContain(
      "shared_session_id, shared_workspace_id, collaborator_id",
    );
    expect(normalizedBehaviorVerification).toContain(
      "set membership_status = 'removed'",
    );
    expect(normalizedBehaviorVerification).toContain(
      "delete from public.transcription_runs where id = run_delete_run_id",
    );
    expect(normalizedBehaviorVerification).toContain(
      "where id = run_delete_version_id and transcription_run_id is null",
    );
    expect(normalizedBehaviorVerification).toContain(
      "insert into public.account_deletion_requests",
    );
    expect(normalizedBehaviorVerification).toContain(
      "delete from public.transcript_versions transcript_version where transcript_version.workspace_id = active_gate_workspace_id",
    );
    expect(normalizedBehaviorVerification).toContain(
      "delete from public.workspaces workspace where workspace.id = active_gate_workspace_id",
    );
    expect(normalizedBehaviorVerification).toContain(
      "delete from public.processing_jobs where id = job_delete_job_id",
    );
    expect(normalizedBehaviorVerification).toContain(
      "has_table_privilege( 'service_role', format('public.%i', foundation_table_name), 'insert'",
    );
    expect(normalizedBehaviorVerification).toContain(
      "from pg_catalog.pg_policies policy",
    );
    expect(normalizedBehaviorVerification).toContain(
      "where id = job_delete_version_id and transcription_run_id is null",
    );
    expect(normalizedBehaviorVerification).not.toContain(
      "transcription_run_delete_cascade_check",
    );
  });

  it("keeps every legacy processing-job smoke fixture valid after migration 0014", () => {
    const processingJobInserts = behaviorVerification.match(
      /insert\s+into\s+public\.processing_jobs\s*\([\s\S]*?\)\s*values\s*\([\s\S]*?\);/gi,
    );

    expect(processingJobInserts).toHaveLength(7);
    for (const statement of processingJobInserts ?? []) {
      const normalizedStatement = normalizeSql(statement);
      expect(normalizedStatement).toContain("request_payload");
      expect(normalizedStatement).toContain("jsonb_build_object");
      expect(normalizedStatement).toContain("'contractversion', 1");
      expect(normalizedStatement).toContain("'languagemode', 'auto_detect'");
      expect(normalizedStatement).toContain(
        "'requestedlanguages', jsonb_build_array()",
      );
      expect(normalizedStatement).toContain("'speakerdiarization', false");
    }
  });

  it("supports safe retry leases and multiple provider attempts", () => {
    expect(normalized).toContain(
      "status in ('queued','leased','processing','succeeded','failed','cancelled')",
    );
    expect(normalized).toContain(
      "status not in ('leased','processing')",
    );
    expect(normalized).toContain(
      "lease_owner is not null and lease_expires_at is not null",
    );
    expect(normalized).toContain(
      "max_attempts > 0 and attempt_count <= max_attempts",
    );
    expect(normalized).toContain("run_attempt integer not null default 1");
  });

  it("indexes transcription creator references used by Delete Account", () => {
    expect(normalized).toContain(
      "create index if not exists idx_processing_jobs_creator",
    );
    expect(normalized).toContain(
      "create index if not exists idx_transcription_runs_creator",
    );
    expect(normalized).toContain(
      "create index if not exists idx_transcript_versions_run_scope",
    );
    expect(normalized).toContain(
      "create index if not exists idx_transcript_versions_creator",
    );
  });

  it("stores versioned text and timestamped language-aware segments", () => {
    expect(migration).toContain(
      "create table if not exists public.transcript_segments",
    );
    expect(normalized).toContain("unique (session_id, version)");
    expect(normalized).toContain(
      "create unique index if not exists idx_transcript_versions_one_current",
    );
    expect(normalized).toContain("check (end_ms >= start_ms)");
    expect(normalized).toContain(
      "check (confidence is null or (confidence >= 0 and confidence <= 1))",
    );
    expect(normalized).toContain(
      "content_checksum_sha256 ~ '^[0-9a-fa-f]{64}$'",
    );
  });

  it("keeps direct transcript mutation server-only while allowing member reads", () => {
    for (const policyName of [
      "processing_jobs_member_select",
      "transcription_runs_member_select",
      "transcript_versions_member_select",
      "transcript_segments_member_select",
    ]) {
      expect(normalized).toContain(`create policy ${policyName}`);
    }

    expect(normalized).toContain(
      "revoke all privileges on table public.processing_jobs, public.transcription_runs, public.transcript_versions, public.transcript_segments from public, anon, authenticated, service_role",
    );
    expect(normalized).toContain(
      "grant select on table public.processing_jobs, public.transcription_runs, public.transcript_versions, public.transcript_segments to authenticated",
    );
    expect(normalized).toContain(
      "grant select, insert, update, delete on table public.processing_jobs, public.transcription_runs, public.transcript_versions, public.transcript_segments to service_role",
    );
  });

  it("extends account-deletion safety and keeps transcription disabled", () => {
    expect(normalized).toContain(
      "create trigger guard_account_deletion_write before insert or update on public.transcript_segments",
    );
    expect(normalized).toContain(
      "where flag_key = 'transcription_enabled'",
    );
    expect(normalized).toContain("set enabled = false");
  });

  it("is provider-neutral and contains no provider credential values or secret variable names", () => {
    expect(normalized).not.toContain("openai_api_key");
    expect(normalized).not.toContain("google_client_secret");
    expect(normalized).not.toContain("supabase_service_role_key");
    expect(normalized).not.toContain("service_role_key");
    expect(normalized).not.toContain("sb_secret_");
  });
});
