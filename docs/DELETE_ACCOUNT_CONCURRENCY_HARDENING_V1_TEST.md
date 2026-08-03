# Delete Account Concurrency and Retry Hardening v1 — Verification

> Apply and test only against the Project Recall development Supabase project.
> Use disposable accounts. Do not use a primary account.

## 1. Source validation

From `/app/frontend`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/delete-account-backend.test.ts \
  __tests__/account-deletion-gate-migration.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./jest.config.js" \
  "./__tests__/delete-account-backend.test.ts" \
  "./__tests__/account-deletion-gate-migration.test.ts" \
  --max-warnings=0

npx expo-doctor
```

Validate configuration and SQL files:

```bash
cd /app

node -e "JSON.parse(require('fs').readFileSync('supabase/functions/delete-account/deno.json','utf8')); console.log('deno.json OK')"

python3 - <<'PY'
from pathlib import Path
import tomllib

tomllib.loads(Path('supabase/config.toml').read_text())
print('supabase/config.toml OK')
PY

git diff --check
```

If Deno is installed:

```bash
deno check supabase/functions/delete-account/index.ts

deno lint \
  supabase/functions/delete-account/core.ts \
  supabase/functions/delete-account/database.ts \
  supabase/functions/delete-account/index.ts
```

## 2. Apply migration 0007 only

Open:

```text
supabase/migrations/0007_account_deletion_gate.sql
```

Copy the complete SQL into the Supabase SQL Editor for the linked development
project and run it once.

Do not run:

```text
supabase db push
supabase migration repair
supabase db reset --linked
migrations 0001-0006 again
```

Expected: `Success. No rows returned`.

## 3. Verify the durable gate schema

```sql
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'account_deletion_requests'
order by ordinal_position;
```

Verify functions:

```sql
select proname
from pg_proc procedure_record
join pg_namespace namespace_record
  on namespace_record.oid = procedure_record.pronamespace
where namespace_record.nspname = 'public'
  and proname in (
    'account_deletion_lock_key',
    'is_account_deletion_active',
    'lock_accounts_for_write',
    'can_write_workspace',
    'guard_account_deletion_write'
  )
order by proname;
```

Verify triggers:

```sql
select
  event_object_table,
  trigger_name,
  event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name = 'guard_account_deletion_write'
order by event_object_table, event_manipulation;
```

## 4. Verify Storage mutation policies

```sql
select
  policyname,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and policyname in (
    'session_assets_insert',
    'session_assets_update',
    'session_assets_delete'
  )
order by policyname;
```

The policies must call `public.can_write_workspace`.

## 5. Non-destructive gate test

Use a disposable signed-in user and privately record its UUID and owned
workspace UUID. Insert a temporary retryable gate through the SQL Editor:

```sql
insert into public.account_deletion_requests (
  user_id,
  request_id,
  status,
  expected_workspace_ids,
  attempt_count,
  lease_expires_at,
  last_error_code
) values (
  'DISPOSABLE_USER_UUID',
  gen_random_uuid(),
  'retryable_failed',
  array['DISPOSABLE_WORKSPACE_UUID'::uuid],
  1,
  null,
  'TEST_GATE'
)
on conflict (user_id) do update set
  request_id = excluded.request_id,
  status = excluded.status,
  expected_workspace_ids = excluded.expected_workspace_ids,
  lease_expires_at = null,
  last_error_code = excluded.last_error_code;
```

While the gate exists, verify from the normal application session:

```text
Create project/session       rejected
Add note/bookmark            rejected
Upload new evidence/audio    rejected
Existing reads               still available
```

If the test user shares another disposable workspace, also verify that an
UPDATE cannot move an existing project/session from the gated owned workspace
to the other workspace. The write guard must check both OLD and NEW ownership
and reject the move with `ACCOUNT_DELETION_IN_PROGRESS`.

Remove only this test gate after verification:

```sql
delete from public.account_deletion_requests
where user_id = 'DISPOSABLE_USER_UUID'
  and last_error_code = 'TEST_GATE';
```

Do not remove a real retryable deletion request.

## 6. Deploy the hardened function

```bash
cd /app
npx supabase functions deploy delete-account
npx supabase functions list
```

Do not use `--no-verify-jwt`.

## 7. Distributed lease check

For a disposable user, insert a short active lease row with a request ID that
is different from the invocation request. Invoke the function with a fresh
user session.

Expected safe response:

```text
HTTP 409
ACCOUNT_DELETION_IN_PROGRESS
retryable: true
```

No Storage object, workspace, or Auth row may be deleted.

After the test, either remove the synthetic row or set it to
`retryable_failed` before the real destructive test.

## 8. Retryable failure state

A real transient Storage/database failure must leave:

```text
status = retryable_failed
lease_expires_at = null
last_error_code = safe application error code
```

The application must remain gated. A fresh recently-authenticated invocation
must take a new lease, preserve `expected_workspace_ids`, and continue cleanup.

Do not restore normal app writes by deleting a real retry row manually.

## 9. Destructive personal-account verification

Repeat the Phase 5A disposable-account preflight. Required:

```text
target_user                                      1
owned_team_workspaces_with_other_active_members  0
memberships_in_non_owned_workspaces              0
all cross-workspace content                       0
objects_outside_owned_workspaces                  0
```

Invoke the deployed function with exact confirmation `DELETE` and a recently
authenticated disposable user.

Expected:

```text
status                       deleted | already_deleted
deletedWorkspaceCount        expected owned count
deletedStorageObjectCount    expected object count
```

Post-delete SQL counts must be zero for Auth user, owned workspaces, content,
Storage objects, and the deletion-request row.

## 10. Regression and release gate

- Missing JWT remains `401`.
- Invalid confirmation remains `400`.
- Shared/team blockers remain non-destructive.
- A second active lease remains non-destructive.
- Existing Google sign-in/link/unlink and password recovery remain intact.
- Do not expose a user-facing Delete Account button until Phase 5B local
  cleanup and Phase 5C destructive/reinstall verification are complete.

## 11. Apply and verify migration 0008

Migration `0007` is already applied in the development project. Do not edit or
re-run it. Before applying `0008`, run the read-only mismatch audit below:

```sql
with mismatches as (
  select 'recordings' as table_name, recording.id
  from public.recordings recording
  join public.sessions session_record
    on session_record.id = recording.session_id
  where recording.workspace_id <> session_record.workspace_id

  union all

  select 'media_assets', media.id
  from public.media_assets media
  join public.sessions session_record
    on session_record.id = media.session_id
  where media.workspace_id <> session_record.workspace_id

  union all

  select 'attachment_events', attachment.id
  from public.attachment_events attachment
  join public.sessions session_record
    on session_record.id = attachment.session_id
  where attachment.workspace_id <> session_record.workspace_id

  union all

  select 'user_notes', note.id
  from public.user_notes note
  join public.sessions session_record
    on session_record.id = note.session_id
  where note.workspace_id <> session_record.workspace_id

  union all

  select 'bookmarks', bookmark.id
  from public.bookmarks bookmark
  join public.sessions session_record
    on session_record.id = bookmark.session_id
  where bookmark.workspace_id <> session_record.workspace_id

  union all

  select 'timeline_events', event_record.id
  from public.timeline_events event_record
  join public.sessions session_record
    on session_record.id = event_record.session_id
  where event_record.workspace_id <> session_record.workspace_id

  union all

  select 'upload_queue_records', queue_record.id
  from public.upload_queue_records queue_record
  join public.sessions session_record
    on session_record.id = queue_record.session_id
  where queue_record.workspace_id <> session_record.workspace_id

  union all

  select 'processing_jobs', job.id
  from public.processing_jobs job
  join public.sessions session_record
    on session_record.id = job.session_id
  where job.workspace_id <> session_record.workspace_id
)
select table_name, count(*) as mismatch_count
from mismatches
group by table_name
order by table_name;
```

Expected: `No rows`. If any mismatch exists, stop and inspect it; do not edit
or delete data merely to make the migration pass.

Apply only:

```text
supabase/migrations/0008_workspace_scope_integrity.sql
```

through the development Supabase SQL Editor. Expected: `Success. No rows
returned`.

Verify the trigger function no longer has direct application-role execution:

```sql
select
  has_function_privilege(
    'anon',
    'public.guard_account_deletion_write()',
    'EXECUTE'
  ) as anon_can_execute,
  has_function_privilege(
    'authenticated',
    'public.guard_account_deletion_write()',
    'EXECUTE'
  ) as authenticated_can_execute;
```

Expected: both values are `false`.


The development project originally retained explicit grants for `anon` and
`authenticated`. The equivalent SQL from
`0009_guard_function_privileges.sql` was therefore applied as a development
hotfix. Do not replay `0008`; retain `0009` in source for future environments.

## 12. Cross-workspace session-scope regression

Use two disposable workspaces. Choose a valid session in Workspace A, a
different Workspace B, and a valid disposable Auth user UUID. The following
DO block must succeed because it catches the expected trigger rejection; no
row is persisted:

```sql
do $$
begin
  begin
    insert into public.user_notes (
      workspace_id,
      session_id,
      text,
      created_by
    ) values (
      'WORKSPACE_B_UUID',
      'SESSION_A_UUID',
      'workspace scope mismatch test',
      'DISPOSABLE_USER_UUID'
    );

    raise exception using
      errcode = 'P0002',
      message = 'TEST_FAILED_MISMATCH_WRITE_WAS_ACCEPTED';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'WORKSPACE_SESSION_SCOPE_MISMATCH' then
        raise;
      end if;
  end;
end $$;
```

Confirm that no note with the test text exists.

Then verify a normal matching write remains possible. Use the canonical
workspace of `SESSION_A_UUID` and remove the temporary row in the same block:

```sql
do $$
declare
  test_note_id uuid := gen_random_uuid();
  session_workspace_id uuid;
begin
  select workspace_id
    into session_workspace_id
  from public.sessions
  where id = 'SESSION_A_UUID';

  insert into public.user_notes (
    id,
    workspace_id,
    session_id,
    text,
    created_by
  ) values (
    test_note_id,
    session_workspace_id,
    'workspace scope matching test',
    'DISPOSABLE_USER_UUID'
  );

  delete from public.user_notes
  where id = test_note_id;
end $$;
```

Finally repeat the non-destructive deletion gate test: matching writes into a
gated workspace must still fail with `ACCOUNT_DELETION_IN_PROGRESS`, and the
distributed lease/retry tests must remain green.


## 13. Apply and verify migrations 0010 and 0011

Migrations `0007`-`0009` are already applied in the development project. Do
not edit or replay them. Apply `0010_account_deletion_gate_final_hardening.sql`
and then `0011_guard_trigger_record_safety.sql` through the development
Supabase SQL Editor only. The remote CLI migration ledger is empty, so do not
use `db push` or `migration repair`.

Verify the final helper-function privilege matrix:

```sql
select
  procedure_record.proname,
  has_function_privilege(
    'anon', procedure_record.oid, 'EXECUTE'
  ) as anon_can_execute,
  has_function_privilege(
    'authenticated', procedure_record.oid, 'EXECUTE'
  ) as authenticated_can_execute,
  has_function_privilege(
    'service_role', procedure_record.oid, 'EXECUTE'
  ) as service_role_can_execute
from pg_proc procedure_record
join pg_namespace namespace_record
  on namespace_record.oid = procedure_record.pronamespace
where namespace_record.nspname = 'public'
  and procedure_record.proname in (
    'account_deletion_lock_key',
    'is_account_deletion_active',
    'lock_accounts_for_write',
    'can_write_workspace',
    'guard_account_deletion_write'
  )
order by procedure_record.proname;
```

Expected:

```text
account_deletion_lock_key      false false true
can_write_workspace            false true  true
guard_account_deletion_write   false false true
is_account_deletion_active     false false true
lock_accounts_for_write        false false true
```

Verify that the live trigger function has no executable direct record-field
access after SQL comments are removed, and that the safe JSON access remains:

```sql
with function_source as (
  select regexp_replace(
    regexp_replace(
      pg_get_functiondef(
        'public.guard_account_deletion_write()'::regprocedure
      ),
      '/\*.*?\*/',
      '',
      'gs'
    ),
    '--[^\n]*',
    '',
    'g'
  ) as source_without_comments
)
select
  source_without_comments ilike '%old.workspace_id%'
    as has_direct_old_access,
  source_without_comments ilike '%new.workspace_id%'
    as has_direct_new_access,
  source_without_comments ilike '%to_jsonb(old)%'
    as uses_safe_old_access,
  source_without_comments ilike '%to_jsonb(new)%'
    as uses_safe_new_access
from function_source;
```

Expected:

```text
has_direct_old_access   false
has_direct_new_access   false
uses_safe_old_access    true
uses_safe_new_access    true
```

## 14. Session-parent and signup/bootstrap regression

Use a disposable user with two owned workspaces and at least one session in
Workspace A.

1. Attempt to update the session from Workspace A to Workspace B. The DO block
   must catch `SESSION_WORKSPACE_IMMUTABLE`, and the session workspace must
   remain unchanged.
2. Update only the session title, then restore the original title. Both updates
   must succeed.
3. Create a new confirmed disposable account from the application. Verify that
   the Auth user, profile, personal workspace, and owner membership are all
   created. This guards against trigger code that references a field absent
   from tables such as `profiles`.
4. Re-run the workspace/session mismatch and matching-write tests from Section
   12.
5. Re-run the synthetic deletion gate, active distributed lease, and
   destructive retry tests. After deletion, Auth user, owned workspaces,
   Storage objects, direct content references, and deletion-request rows must
   all be zero, and login must fail.

The development project has verified all five checks above after migrations
`0010` and `0011`.
