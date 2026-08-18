import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "..", relativePath), "utf8");

const normalizeSql = (sql: string): string =>
  sql.replace(/\s+/g, " ").trim().toLowerCase();

describe("Milestone 2B.4B.2 transcript user-edit versioning migration", () => {
  const migrationPath =
    "supabase/migrations/0016_transcript_user_edit_versioning_v1.sql";
  const behaviorPath =
    "supabase/tests/0016_transcript_user_edit_versioning_behavior.sql";
  const migration = readRepositoryFile(migrationPath);
  const behavior = readRepositoryFile(behaviorPath);
  const normalized = normalizeSql(migration);
  const normalizedBehavior = normalizeSql(behavior);

  it("is append-only after migration 0015", () => {
    const migrationFiles = readdirSync(
      resolve(process.cwd(), "..", "supabase/migrations"),
    )
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();
    const migrationIndex = migrationFiles.indexOf(
      "0016_transcript_user_edit_versioning_v1.sql",
    );

    expect(migrationIndex).toBeGreaterThan(0);
    expect(migrationFiles[migrationIndex - 1]).toBe(
      "0015_transcription_nullable_primary_en_id.sql",
    );
    expect(
      migrationFiles.filter(
        (fileName) =>
          fileName === "0016_transcript_user_edit_versioning_v1.sql",
      ),
    ).toHaveLength(1);
  });

  it("keeps user-edit rows final, checksummed, parented, and non-self-referential", () => {
    expect(normalized).toContain(
      "add constraint transcript_versions_user_edit_shape_check",
    );
    expect(normalized).toContain("version_origin <> 'user_edit'");
    expect(normalized).toContain("version_status = 'final'");
    expect(normalized).toContain("parent_version_id is not null");
    expect(normalized).toContain("content_checksum_sha256 is not null");
    expect(normalized).toContain(
      "add constraint transcript_versions_no_self_parent_check",
    );
    expect(normalized).toContain(
      "create index if not exists idx_transcript_versions_parent",
    );
  });

  it("adds an immutable-content trigger without breaking nullable provenance cleanup", () => {
    expect(normalized).toContain(
      "create or replace function public.guard_transcript_version_immutable_v1()",
    );
    expect(normalized).toContain(
      "create trigger guard_transcript_version_immutable_v1 before update on public.transcript_versions",
    );
    expect(normalized).toContain("message = 'transcript_version_immutable'");
    expect(normalized).toContain(
      "old.transcription_run_id is not null and new.transcription_run_id is null",
    );
    expect(normalized).toContain(
      "old.created_by is not null and new.created_by is null",
    );
    expect(normalized).not.toContain(
      "old.is_current is distinct from new.is_current",
    );
  });

  it("exposes one narrow authenticated security-definer RPC", () => {
    expect(normalized).toContain(
      "create or replace function public.create_transcript_user_edit_version_v1( p_session_id uuid, p_expected_current_version_id uuid, p_client_version_id uuid, p_plain_text text )",
    );
    expect(normalized).toContain("language plpgsql security definer");
    expect(normalized).toContain("set search_path = ''");
    expect(normalized).toContain(
      "revoke all on function public.create_transcript_user_edit_version_v1( uuid, uuid, uuid, text ) from public, anon, authenticated, service_role",
    );
    expect(normalized).toContain(
      "grant execute on function public.create_transcript_user_edit_version_v1( uuid, uuid, uuid, text ) to authenticated",
    );
    expect(normalized).not.toContain(
      "grant execute on function public.create_transcript_user_edit_version_v1( uuid, uuid, uuid, text ) to anon",
    );
  });

  it("preserves feature, membership, deletion, and session serialization gates", () => {
    expect(normalized).toContain("where feature_flag.flag_key = 'transcription_enabled'");
    expect(normalized).toContain("message = 'transcript_edit_feature_disabled'");
    expect(normalized).toContain(
      "public.can_write_workspace(target_workspace_id) is not true",
    );
    expect(normalized).toContain("message = 'transcript_edit_forbidden'");
    expect(normalized).toContain(
      "from public.sessions target_session where target_session.id = p_session_id",
    );
    expect(normalized).toContain("for update");
  });

  it("uses stable UUID idempotency before stale-base compare-and-swap", () => {
    const existingVersionIndex = normalized.indexOf(
      "where transcript_version.id = p_client_version_id",
    );
    const baseConflictIndex = normalized.indexOf(
      "if current_version.id <> p_expected_current_version_id",
    );

    expect(existingVersionIndex).toBeGreaterThan(-1);
    expect(baseConflictIndex).toBeGreaterThan(existingVersionIndex);
    expect(normalized).toContain(
      "message = 'transcript_edit_idempotency_conflict'",
    );
    expect(normalized).toContain("message = 'transcript_edit_base_conflict'");
    expect(normalized).toContain("message = 'transcript_edit_unchanged'");
  });

  it("creates a new current user-edit version without fabricating timestamp segments", () => {
    expect(normalized).toContain(
      "select coalesce(max(transcript_version.version), 0) + 1 into next_version",
    );
    expect(normalized).toContain(
      "set is_current = false, updated_at = now()",
    );
    expect(normalized).toContain("current_version.transcription_run_id");
    expect(normalized).toContain("'user_edit', 'final'");
    expect(normalized).toContain("current_version.id, p_plain_text");
    expect(normalized).toContain("current_version.language_summary");
    expect(normalized).toContain(
      "extensions.digest(p_plain_text, 'sha256')",
    );
    expect(normalized).not.toContain(
      "insert into public.transcript_segments",
    );
  });

  it("ships rollback-wrapped behavior coverage for all security and conflict boundaries", () => {
    for (const marker of [
      "transcript_user_edit_privilege_matrix=pass",
      "transcript_user_edit_feature_flag=pass",
      "transcript_user_edit_create=pass",
      "transcript_user_edit_idempotent_replay=pass",
      "transcript_user_edit_stale_base_conflict=pass",
      "transcript_user_edit_idempotency_conflict=pass",
      "transcript_user_edit_unchanged_rejected=pass",
      "transcript_version_immutable_content=pass",
      "transcript_user_edit_membership_gate=pass",
      "transcript_user_edit_account_deletion_gate=pass",
      "transcript_run_delete_set_null_compatibility=pass",
      "project_recall_transcript_user_edit_versioning=pass",
    ]) {
      expect(normalizedBehavior).toContain(marker);
    }

    expect(normalizedBehavior).toContain("begin;");
    expect(normalizedBehavior).toContain("rollback;");
    expect(normalizedBehavior).toContain("'request.jwt.claims'");
    expect(normalizedBehavior).toContain(
      "has_function_privilege( 'authenticated', 'public.create_transcript_user_edit_version_v1(uuid,uuid,uuid,text)', 'execute'",
    );
    expect(normalizedBehavior).toContain(
      "and transcript_version.transcription_run_id is not null",
    );
  });

  it("contains no frontend credential or provider execution boundary", () => {
    const combined = `${migration}\n${behavior}`.toLowerCase();
    expect(combined).not.toContain("supabase_service_role_key");
    expect(combined).not.toContain("service_role_key");
    expect(combined).not.toContain("assemblyai_api_key");
    expect(combined).not.toContain("project_recall_transcription_worker_token");
    expect(combined).not.toMatch(/sb_secret_[a-z0-9_-]{16,}/);
    expect(combined).not.toContain("transcription-worker");
    expect(combined).not.toContain("functions/v1");
  });
});
