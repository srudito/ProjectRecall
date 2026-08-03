-- ============================================================================
-- 0008_workspace_scope_integrity.sql
-- Bind session-scoped writes to the session's canonical workspace.
--
-- Migration 0007 introduced the durable Delete Account write gate. This
-- follow-up closes a cross-workspace integrity gap: rows carrying both a
-- workspace_id and session_id must reference the same workspace, and the
-- account-deletion guard must lock/check the owners of both scopes.
-- ============================================================================

begin;

-- Fail closed before tightening the trigger when legacy rows are inconsistent.
-- The transaction is rolled back and no function change is retained if any
-- mismatch exists.
do $$
declare
  mismatched_table text;
begin
  select mismatch.table_name
    into mismatched_table
  from (
    select 'recordings'::text as table_name
    from public.recordings recording
    join public.sessions session_record
      on session_record.id = recording.session_id
    where recording.workspace_id <> session_record.workspace_id

    union all

    select 'media_assets'
    from public.media_assets media
    join public.sessions session_record
      on session_record.id = media.session_id
    where media.workspace_id <> session_record.workspace_id

    union all

    select 'attachment_events'
    from public.attachment_events attachment
    join public.sessions session_record
      on session_record.id = attachment.session_id
    where attachment.workspace_id <> session_record.workspace_id

    union all

    select 'user_notes'
    from public.user_notes note
    join public.sessions session_record
      on session_record.id = note.session_id
    where note.workspace_id <> session_record.workspace_id

    union all

    select 'bookmarks'
    from public.bookmarks bookmark
    join public.sessions session_record
      on session_record.id = bookmark.session_id
    where bookmark.workspace_id <> session_record.workspace_id

    union all

    select 'timeline_events'
    from public.timeline_events event_record
    join public.sessions session_record
      on session_record.id = event_record.session_id
    where event_record.workspace_id <> session_record.workspace_id

    union all

    select 'upload_queue_records'
    from public.upload_queue_records queue_record
    join public.sessions session_record
      on session_record.id = queue_record.session_id
    where queue_record.workspace_id <> session_record.workspace_id

    union all

    select 'processing_jobs'
    from public.processing_jobs job
    join public.sessions session_record
      on session_record.id = job.session_id
    where job.workspace_id <> session_record.workspace_id
  ) mismatch
  limit 1;

  if mismatched_table is not null then
    raise exception using
      errcode = 'P0001',
      message = 'WORKSPACE_SESSION_SCOPE_MISMATCH_EXISTING_DATA';
  end if;
end $$;

-- Replace only the trigger function. Existing triggers from migration 0007
-- keep their function binding and immediately use this stricter definition.
create or replace function public.guard_account_deletion_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_payload jsonb;
  old_payload jsonb := '{}'::jsonb;
  payload jsonb;
  workspace_id uuid;
  workspace_owner_user_id uuid;
  session_id uuid;
  session_workspace_id uuid;
  session_owner_user_id uuid;
  current_user_id uuid := auth.uid();
  guarded_user_ids uuid[] := '{}';
  value_text text;
begin
  new_payload := to_jsonb(new);

  if tg_op = 'UPDATE' then
    old_payload := to_jsonb(old);
  end if;

  -- Guard both OLD and NEW ownership on UPDATE. Resolve workspace_id and
  -- session_id independently so neither scope can hide the other. A row that
  -- supplies both identifiers must bind to the session's canonical workspace.
  foreach payload in array array[new_payload, old_payload]
  loop
    workspace_id := null;
    workspace_owner_user_id := null;
    session_id := null;
    session_workspace_id := null;
    session_owner_user_id := null;

    if tg_table_schema = 'public' and tg_table_name = 'profiles' then
      value_text := payload ->> 'id';
      if value_text is not null then
        guarded_user_ids := array_append(
          guarded_user_ids,
          value_text::uuid
        );
      end if;
    end if;

    foreach value_text in array array[
      payload ->> 'owner_user_id',
      payload ->> 'user_id',
      payload ->> 'created_by',
      payload ->> 'added_by'
    ]
    loop
      if value_text is not null then
        guarded_user_ids := array_append(
          guarded_user_ids,
          value_text::uuid
        );
      end if;
    end loop;

    value_text := payload ->> 'workspace_id';
    if value_text is not null then
      workspace_id := value_text::uuid;

      select workspace.owner_user_id
        into workspace_owner_user_id
      from public.workspaces workspace
      where workspace.id = workspace_id;

      if workspace_owner_user_id is not null then
        guarded_user_ids := array_append(
          guarded_user_ids,
          workspace_owner_user_id
        );
      end if;
    end if;

    value_text := payload ->> 'session_id';
    if value_text is not null then
      session_id := value_text::uuid;

      select
        session_record.workspace_id,
        workspace.owner_user_id
      into
        session_workspace_id,
        session_owner_user_id
      from public.sessions session_record
      join public.workspaces workspace
        on workspace.id = session_record.workspace_id
      where session_record.id = session_id;

      if session_owner_user_id is not null then
        guarded_user_ids := array_append(
          guarded_user_ids,
          session_owner_user_id
        );
      end if;
    end if;

    if workspace_id is not null
      and session_workspace_id is not null
      and workspace_id <> session_workspace_id
    then
      raise exception using
        errcode = 'P0001',
        message = 'WORKSPACE_SESSION_SCOPE_MISMATCH';
    end if;
  end loop;

  if current_user_id is not null then
    guarded_user_ids := array_append(
      guarded_user_ids,
      current_user_id
    );
  end if;

  if not public.lock_accounts_for_write(guarded_user_ids) then
    raise exception using
      errcode = 'P0001',
      message = 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;

  return new;
end;
$$;

-- Trigger functions are not an application API. PostgreSQL grants EXECUTE to
-- PUBLIC for new functions by default, so remove direct invocation rights.
-- Existing triggers continue to execute the function.
revoke all on function public.guard_account_deletion_write() from public;

commit;
