-- ==========================================================================
-- 0004_triggers.sql
-- Automatic profile + personal workspace + owner membership creation on
-- new Supabase Auth user. Runs as SECURITY DEFINER so RLS does not block it.
-- ==========================================================================

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid := gen_random_uuid();
  display text;
begin
  display := coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1));

  -- Profile
  insert into public.profiles (id, display_name)
  values (new.id, display)
  on conflict (id) do nothing;

  -- Personal workspace
  insert into public.workspaces (id, name, workspace_type, owner_user_id)
  values (new_workspace_id, coalesce(display, 'My workspace'), 'personal', new.id)
  on conflict (id) do nothing;

  -- Owner membership
  insert into public.workspace_members (workspace_id, user_id, role, membership_status)
  values (new_workspace_id, new.id, 'owner', 'active')
  on conflict (workspace_id, user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Auto-update updated_at ---------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles','workspaces','workspace_members','projects','sessions',
    'recordings','media_assets','attachment_events','user_notes','bookmarks',
    'upload_queue_records','feature_flags','processing_jobs','transcription_runs','transcript_versions'
  ] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.touch_updated_at()',
      t
    );
  end loop;
end $$;
