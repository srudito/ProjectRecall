-- ==========================================================================
-- 0006_session_user_preferences.sql
-- Per-user session organization preferences.
--
-- A star is intentionally user-specific: two members of the same workspace
-- can organize the same shared session differently. The session foreign key
-- cascades cleanup when a session is deleted.
-- ==========================================================================

begin;

create table if not exists public.session_user_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  is_starred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, session_id)
);

create index if not exists idx_session_user_preferences_session
  on public.session_user_preferences(session_id);

create index if not exists idx_session_user_preferences_starred
  on public.session_user_preferences(user_id, is_starred, updated_at desc);

alter table public.session_user_preferences enable row level security;

-- Re-running the migration after a partial development setup is safe.
drop policy if exists session_preferences_self_select
  on public.session_user_preferences;
drop policy if exists session_preferences_self_insert
  on public.session_user_preferences;
drop policy if exists session_preferences_self_update
  on public.session_user_preferences;
drop policy if exists session_preferences_self_delete
  on public.session_user_preferences;

create policy session_preferences_self_select
  on public.session_user_preferences
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1
      from public.sessions s
      where s.id = session_user_preferences.session_id
        and s.deleted_at is null
        and public.is_workspace_member(s.workspace_id)
    )
  );

create policy session_preferences_self_insert
  on public.session_user_preferences
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.sessions s
      where s.id = session_user_preferences.session_id
        and s.deleted_at is null
        and public.is_workspace_member(s.workspace_id)
    )
  );

create policy session_preferences_self_update
  on public.session_user_preferences
  for update
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1
      from public.sessions s
      where s.id = session_user_preferences.session_id
        and s.deleted_at is null
        and public.is_workspace_member(s.workspace_id)
    )
  )
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.sessions s
      where s.id = session_user_preferences.session_id
        and s.deleted_at is null
        and public.is_workspace_member(s.workspace_id)
    )
  );

create policy session_preferences_self_delete
  on public.session_user_preferences
  for delete
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1
      from public.sessions s
      where s.id = session_user_preferences.session_id
        and public.is_workspace_member(s.workspace_id)
    )
  );

grant select, insert, update, delete
  on public.session_user_preferences
  to authenticated;

drop trigger if exists set_updated_at
  on public.session_user_preferences;
create trigger set_updated_at
  before update on public.session_user_preferences
  for each row execute function public.touch_updated_at();

commit;
