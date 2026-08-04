import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "..", relativePath), "utf8");

const normalizeSql = (sql: string): string =>
  sql.replace(/\s+/g, " ").trim().toLowerCase();

const stripSqlComments = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");

describe("account deletion distributed gate migration", () => {
  const migration = readRepositoryFile(
    "supabase/migrations/0007_account_deletion_gate.sql",
  );
  const scopeIntegrityMigration = readRepositoryFile(
    "supabase/migrations/0008_workspace_scope_integrity.sql",
  );
  const guardPrivilegeMigration = readRepositoryFile(
    "supabase/migrations/0009_guard_function_privileges.sql",
  );
  const finalHardeningMigration = readRepositoryFile(
    "supabase/migrations/0010_account_deletion_gate_final_hardening.sql",
  );
  const recordSafetyMigration = readRepositoryFile(
    "supabase/migrations/0011_guard_trigger_record_safety.sql",
  );
  const profileGateMigration = readRepositoryFile(
    "supabase/migrations/0012_profile_account_deletion_gate.sql",
  );
  const databaseSource = readRepositoryFile(
    "supabase/functions/delete-account/database.ts",
  );

  it("persists retryable deletion state and leases per Auth user", () => {
    expect(migration).toContain(
      "create table if not exists public.account_deletion_requests",
    );
    expect(migration).toContain("user_id uuid primary key");
    expect(migration).toContain("status in ('processing', 'retryable_failed')");
    expect(migration).toContain("expected_workspace_ids uuid[]");
    expect(migration).toContain("lease_expires_at timestamptz");
    expect(migration).toContain("last_error_code text");
  });

  it("serializes deletion against guarded writes with transaction locks", () => {
    expect(migration).toContain("pg_advisory_xact_lock_shared");
    expect(migration).toContain("public.account_deletion_lock_key");
    expect(migration).toContain("public.lock_accounts_for_write");
    expect(migration).toContain("ACCOUNT_DELETION_IN_PROGRESS");
  });

  it("guards workspace, content, processing, and preference writes", () => {
    for (const tableName of [
      "profiles",
      "workspaces",
      "workspace_members",
      "projects",
      "sessions",
      "recordings",
      "media_assets",
      "attachment_events",
      "user_notes",
      "bookmarks",
      "timeline_events",
      "upload_queue_records",
      "processing_jobs",
      "transcription_runs",
      "transcript_versions",
    ]) {
      expect(migration).toContain(`'${tableName}'`);
    }
    expect(migration).toContain(
      "create or replace function public.guard_account_deletion_write()",
    );
    expect(migration).toContain(
      "to_regclass('public.session_user_preferences')",
    );
    expect(migration).toContain("if tg_op = 'UPDATE' then");
    expect(migration).toContain("old_payload := to_jsonb(old)");
    expect(migration).toContain(
      "foreach payload in array array[new_payload, old_payload]",
    );
  });

  it("binds every session-scoped write to the session workspace", () => {
    expect(scopeIntegrityMigration).toContain(
      "WORKSPACE_SESSION_SCOPE_MISMATCH_EXISTING_DATA",
    );
    expect(scopeIntegrityMigration).toContain(
      "WORKSPACE_SESSION_SCOPE_MISMATCH",
    );
    expect(scopeIntegrityMigration).toContain("session_workspace_id uuid");
    expect(scopeIntegrityMigration).toContain(
      "workspace_id <> session_workspace_id",
    );
    expect(scopeIntegrityMigration).toContain(
      "session_owner_user_id",
    );

    for (const tableName of [
      "recordings",
      "media_assets",
      "attachment_events",
      "user_notes",
      "bookmarks",
      "timeline_events",
      "upload_queue_records",
      "processing_jobs",
    ]) {
      expect(scopeIntegrityMigration).toContain(`'${tableName}'`);
    }
  });

  it("removes direct execution rights from the trigger function", () => {
    expect(scopeIntegrityMigration).toContain(
      "revoke all on function public.guard_account_deletion_write() from public",
    );
    expect(guardPrivilegeMigration).toContain(
      "public.guard_account_deletion_write()",
    );

    for (const role of ["public", "anon", "authenticated"]) {
      expect(guardPrivilegeMigration).toContain(`from ${role};`);
    }
  });


  it("locks down internal helpers while preserving authenticated workspace checks", () => {
    const normalizedMigration = normalizeSql(finalHardeningMigration);

    for (const functionSignature of [
      "account_deletion_lock_key(uuid)",
      "is_account_deletion_active(uuid)",
      "lock_accounts_for_write(uuid[])",
    ]) {
      for (const role of ["public", "anon", "authenticated"]) {
        expect(normalizedMigration).toContain(
          `revoke all on function public.${functionSignature} from ${role};`,
        );
      }
    }

    expect(normalizedMigration).toContain(
      "revoke all on function public.can_write_workspace(uuid) from public;",
    );
    expect(normalizedMigration).toContain(
      "revoke all on function public.can_write_workspace(uuid) from anon;",
    );
    expect(normalizedMigration).toContain(
      "grant execute on function public.can_write_workspace(uuid) to authenticated;",
    );
    expect(normalizedMigration).not.toContain(
      "revoke all on function public.can_write_workspace(uuid) from service_role;",
    );
  });

  it("keeps session workspace immutable without unsafe trigger-record field access", () => {
    const executableMigration = normalizeSql(
      stripSqlComments(recordSafetyMigration),
    );

    expect(executableMigration).toContain(
      "tg_table_name = 'sessions'",
    );
    expect(executableMigration).toContain(
      "to_jsonb(old) ->> 'workspace_id'",
    );
    expect(executableMigration).toContain(
      "to_jsonb(new) ->> 'workspace_id'",
    );
    expect(executableMigration).toContain(
      "is distinct from",
    );
    expect(executableMigration).toContain(
      "session_workspace_immutable",
    );
    expect(executableMigration).not.toContain("old.workspace_id");
    expect(executableMigration).not.toContain("new.workspace_id");
  });

  it("retains scope mismatch, advisory locking, and deletion-gate enforcement", () => {
    const normalizedMigration = normalizeSql(recordSafetyMigration);

    expect(normalizedMigration).toContain(
      "workspace_session_scope_mismatch",
    );
    expect(normalizedMigration).toContain(
      "account_deletion_in_progress",
    );
    expect(normalizedMigration).toContain(
      "perform public.lock_accounts_for_write(guarded_user_ids)",
    );
    expect(normalizedMigration).toContain(
      "public.is_account_deletion_active(guarded_user_id)",
    );

    for (const role of ["public", "anon", "authenticated"]) {
      expect(normalizedMigration).toContain(
        `revoke all on function public.guard_account_deletion_write() from ${role};`,
      );
    }
  });

  it("freezes profile writes while account deletion is active", () => {
    const normalizedMigration = normalizeSql(profileGateMigration);

    expect(normalizedMigration).toContain(
      "create or replace function public.guard_profile_account_deletion_write()",
    );
    expect(normalizedMigration).toContain(
      "before insert or update on public.profiles",
    );
    expect(normalizedMigration).toContain(
      "perform public.lock_accounts_for_write(array[guarded_user_id])",
    );
    expect(normalizedMigration).toContain(
      "public.is_account_deletion_active(guarded_user_id)",
    );
    expect(normalizedMigration).toContain(
      "account_deletion_in_progress",
    );

    for (const role of ["public", "anon", "authenticated"]) {
      expect(normalizedMigration).toContain(
        `revoke all on function public.guard_profile_account_deletion_write() from ${role};`,
      );
    }
  });

  it("uses an exclusive database lock and deletes only preflighted workspaces", () => {
    expect(databaseSource).toContain("pg_advisory_xact_lock(");
    expect(databaseSource).toContain("ACCOUNT_DELETION_IN_PROGRESS");
    expect(databaseSource).toContain("expectedWorkspaceIds");
    expect(databaseSource).toContain("workspace.id in");
    expect(databaseSource).toMatch(
      /delete from public\.workspaces workspace[\s\S]*workspace\.id in/,
    );
  });

  it("gates authenticated Storage mutation policies", () => {
    expect(migration).toContain(
      'drop policy if exists "session_assets_insert" on storage.objects',
    );
    expect(migration).toContain(
      'drop policy if exists "session_assets_update" on storage.objects',
    );
    expect(migration).toContain(
      'drop policy if exists "session_assets_delete" on storage.objects',
    );
    expect(migration).toContain("public.can_write_workspace");
  });
});
