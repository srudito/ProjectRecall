-- ============================================================================
-- 0007_account_deletion_gate.sql
-- Durable account-deletion gate and distributed write serialization.
--
-- Goals:
-- - persist retryable account deletion state across Edge Function restarts;
-- - prevent concurrent account deletion attempts across Edge isolates;
-- - drain in-flight authenticated writes before deletion starts;
-- - reject new writes for a user or owned workspace while deletion is active;
-- - keep reads available until the client enters its local cleanup flow.
-- ============================================================================

begin;

create table if not exists public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  request_id uuid not null unique,
  status text not null
    check (status in ('processing', 'retryable_failed')),
  expected_workspace_ids uuid[] not null default '{}',
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  started_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_account_deletion_requests_status
  on public.account_deletion_requests(status, lease_expires_at);

alter table public.account_deletion_requests enable row level security;

revoke all on public.account_deletion_requests from anon, authenticated;
grant select on public.account_deletion_requests to authenticated;

drop policy if exists account_deletion_requests_self_select
  on public.account_deletion_requests;
create policy account_deletion_requests_self_select
  on public.account_deletion_requests
  for select
  to authenticated
  using (user_id = auth.uid());

-- Stable lock key shared by the Edge Function and database write guards.
create or replace function public.account_deletion_lock_key(_user_id uuid)
returns bigint
language sql
immutable
strict
parallel safe
set search_path = public, pg_temp
as $$
  select hashtextextended(_user_id::text, 20260803);
$$;

revoke all on function public.account_deletion_lock_key(uuid) from public;
grant execute on function public.account_deletion_lock_key(uuid)
  to service_role;

create or replace function public.is_account_deletion_active(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.account_deletion_requests request
    where request.user_id = _user_id
      and request.status in ('processing', 'retryable_failed')
  );
$$;

revoke all on function public.is_account_deletion_active(uuid) from public;
grant execute on function public.is_account_deletion_active(uuid)
  to service_role;

-- Acquire shared transaction locks in deterministic key order, then check the
-- durable gate. A deletion attempt takes the corresponding exclusive lock,
-- so it waits for all in-flight guarded writes to finish before activating the
-- gate. New writes wait for that transaction and are rejected after commit.
create or replace function public.lock_accounts_for_write(_user_ids uuid[])
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_user_ids uuid[];
  lock_key bigint;
begin
  select coalesce(array_agg(distinct user_id order by user_id), '{}')
    into normalized_user_ids
  from unnest(coalesce(_user_ids, '{}')) as input_user(user_id)
  where user_id is not null;

  if coalesce(array_length(normalized_user_ids, 1), 0) = 0 then
    return true;
  end if;

  for lock_key in
    select distinct public.account_deletion_lock_key(user_id)
    from unnest(normalized_user_ids) as input_user(user_id)
    order by 1
  loop
    perform pg_advisory_xact_lock_shared(lock_key);
  end loop;

  return not exists (
    select 1
    from public.account_deletion_requests request
    where request.user_id = any(normalized_user_ids)
      and request.status in ('processing', 'retryable_failed')
  );
end;
$$;

revoke all on function public.lock_accounts_for_write(uuid[]) from public;
grant execute on function public.lock_accounts_for_write(uuid[])
  to service_role;

create or replace function public.can_write_workspace(_workspace_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  owner_user_id uuid;
begin
  if current_user_id is null or _workspace_id is null then
    return false;
  end if;

  select workspace.owner_user_id
    into owner_user_id
  from public.workspaces workspace
  where workspace.id = _workspace_id;

  if owner_user_id is null then
    return false;
  end if;

  if not public.lock_accounts_for_write(
    array[current_user_id, owner_user_id]
  ) then
    return false;
  end if;

  return exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = _workspace_id
      and member.user_id = current_user_id
      and member.membership_status = 'active'
  );
end;
$$;

revoke all on function public.can_write_workspace(uuid) from public;
grant execute on function public.can_write_workspace(uuid)
  to authenticated, service_role;

-- Generic trigger for public-table INSERT/UPDATE operations. It checks all
-- actor/user columns present on NEW plus the owner of NEW.workspace_id (or the
-- workspace inherited from NEW.session_id). This also protects trusted direct
-- database writers that bypass RLS.
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
  session_id uuid;
  owner_user_id uuid;
  current_user_id uuid := auth.uid();
  guarded_user_ids uuid[] := '{}';
  value_text text;
begin
  new_payload := to_jsonb(new);

  if tg_op = 'UPDATE' then
    old_payload := to_jsonb(old);
  end if;

  -- Guard both OLD and NEW ownership on UPDATE. Otherwise a row could be
  -- moved away from a deleting account/workspace and escape the durable gate.
  foreach payload in array array[new_payload, old_payload]
  loop
    workspace_id := null;
    session_id := null;
    owner_user_id := null;

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
    else
      value_text := payload ->> 'session_id';
      if value_text is not null then
        session_id := value_text::uuid;
        select session_record.workspace_id
          into workspace_id
        from public.sessions session_record
        where session_record.id = session_id;
      end if;
    end if;

    if workspace_id is not null then
      select workspace.owner_user_id
        into owner_user_id
      from public.workspaces workspace
      where workspace.id = workspace_id;

      if owner_user_id is not null then
        guarded_user_ids := array_append(
          guarded_user_ids,
          owner_user_id
        );
      end if;
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

-- Attach write guards. Deletes remain monotonic and are allowed; the account
-- deletion worker uses deletes to finish cleanup after the gate is active.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles',
    'workspaces',
    'workspace_members',
    'projects',
    'sessions',
    'recordings',
    'media_assets',
    'attachment_events',
    'user_notes',
    'bookmarks',
    'timeline_events',
    'upload_queue_records',
    'processing_jobs',
    'transcription_runs',
    'transcript_versions'
  ]
  loop
    execute format(
      'drop trigger if exists guard_account_deletion_write on public.%I',
      table_name
    );
    execute format(
      'create trigger guard_account_deletion_write before insert or update on public.%I for each row execute function public.guard_account_deletion_write()',
      table_name
    );
  end loop;

  if to_regclass('public.session_user_preferences') is not null then
    execute 'drop trigger if exists guard_account_deletion_write on public.session_user_preferences';
    execute 'create trigger guard_account_deletion_write before insert or update on public.session_user_preferences for each row execute function public.guard_account_deletion_write()';
  end if;
end $$;

-- Storage SELECT remains membership-based. All authenticated mutation paths
-- take the same shared account locks and are rejected once the gate is active.
drop policy if exists "session_assets_insert" on storage.objects;
create policy "session_assets_insert" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'session-assets'
    and public.can_write_workspace(
      ((storage.foldername(name))[1])::uuid
    )
  );

drop policy if exists "session_assets_update" on storage.objects;
create policy "session_assets_update" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'session-assets'
    and public.can_write_workspace(
      ((storage.foldername(name))[1])::uuid
    )
  )
  with check (
    bucket_id = 'session-assets'
    and public.can_write_workspace(
      ((storage.foldername(name))[1])::uuid
    )
  );

drop policy if exists "session_assets_delete" on storage.objects;
create policy "session_assets_delete" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'session-assets'
    and public.can_write_workspace(
      ((storage.foldername(name))[1])::uuid
    )
  );

-- Reuse the existing updated_at helper when present.
drop trigger if exists set_updated_at on public.account_deletion_requests;
create trigger set_updated_at
  before update on public.account_deletion_requests
  for each row execute function public.touch_updated_at();

commit;
