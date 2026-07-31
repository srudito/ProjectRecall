-- ==========================================================================
-- 0005_auth_provider_metadata.sql
-- Improve automatic profile/workspace names for OAuth identities. Google and
-- other social providers commonly populate full_name or name rather than the
-- email/password-specific display_name field used by the original trigger.
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
  display := coalesce(
    nullif(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Project Recall user'
  );

  insert into public.profiles (id, display_name)
  values (new.id, display)
  on conflict (id) do nothing;

  insert into public.workspaces (
    id,
    name,
    workspace_type,
    owner_user_id
  )
  values (
    new_workspace_id,
    display,
    'personal',
    new.id
  )
  on conflict (id) do nothing;

  insert into public.workspace_members (
    workspace_id,
    user_id,
    role,
    membership_status
  )
  values (
    new_workspace_id,
    new.id,
    'owner',
    'active'
  )
  on conflict (workspace_id, user_id) do nothing;

  return new;
end;
$$;
