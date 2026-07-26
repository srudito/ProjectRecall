-- ==========================================================================
-- 0002_rls_policies.sql
-- Enable Row Level Security on every user-owned table and enforce workspace
-- membership for all reads and writes.
-- ==========================================================================

-- Helper: is the current user an active member of a given workspace?
create or replace function public.is_workspace_member(_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = _workspace_id
      and wm.user_id = auth.uid()
      and wm.membership_status = 'active'
  );
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;

-- Enable RLS ---------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.sessions enable row level security;
alter table public.recordings enable row level security;
alter table public.media_assets enable row level security;
alter table public.attachment_events enable row level security;
alter table public.user_notes enable row level security;
alter table public.bookmarks enable row level security;
alter table public.timeline_events enable row level security;
alter table public.upload_queue_records enable row level security;
alter table public.feature_flags enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.transcription_runs enable row level security;
alter table public.transcript_versions enable row level security;

-- Profiles: owner-only access ---------------------------------------------
create policy profiles_self_select on public.profiles
  for select to authenticated using (auth.uid() = id);
create policy profiles_self_insert on public.profiles
  for insert to authenticated with check (auth.uid() = id);
create policy profiles_self_update on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Workspaces: only members can read; only owner can update/delete ---------
create policy workspaces_member_select on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));
create policy workspaces_owner_insert on public.workspaces
  for insert to authenticated with check (owner_user_id = auth.uid());
create policy workspaces_owner_update on public.workspaces
  for update to authenticated using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy workspaces_owner_delete on public.workspaces
  for delete to authenticated using (owner_user_id = auth.uid());

-- Workspace members: only members can see membership --------------------
create policy wm_member_select on public.workspace_members
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy wm_owner_manage on public.workspace_members
  for all to authenticated
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_members.workspace_id and w.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_members.workspace_id and w.owner_user_id = auth.uid()
    )
  );

-- Generic workspace-scoped policy generator via macro-like blocks ---------

-- Projects
create policy projects_member_all on public.projects
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Sessions
create policy sessions_member_all on public.sessions
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Recordings
create policy recordings_member_all on public.recordings
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Media assets
create policy media_member_all on public.media_assets
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Attachment events
create policy attach_member_all on public.attachment_events
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Notes
create policy notes_member_all on public.user_notes
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Bookmarks
create policy bookmarks_member_all on public.bookmarks
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Timeline events
create policy timeline_member_all on public.timeline_events
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Upload queue (user-owned)
create policy uq_user_all on public.upload_queue_records
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- Feature flags: read-only for authenticated
create policy feature_flags_read on public.feature_flags
  for select to authenticated using (true);

-- Foundation future tables: workspace-scoped
create policy processing_jobs_member_all on public.processing_jobs
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- transcription_runs & transcript_versions inherit from their session.
create policy tr_runs_member_all on public.transcription_runs
  for all to authenticated
  using (
    exists (
      select 1 from public.sessions s
      where s.id = transcription_runs.session_id and public.is_workspace_member(s.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.sessions s
      where s.id = transcription_runs.session_id and public.is_workspace_member(s.workspace_id)
    )
  );

create policy tv_member_all on public.transcript_versions
  for all to authenticated
  using (
    exists (
      select 1 from public.sessions s
      where s.id = transcript_versions.session_id and public.is_workspace_member(s.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.sessions s
      where s.id = transcript_versions.session_id and public.is_workspace_member(s.workspace_id)
    )
  );

-- Base grants (RLS still restricts row-level access) ----------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.feature_flags to anon;
