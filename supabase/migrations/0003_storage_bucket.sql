-- ==========================================================================
-- 0003_storage_bucket.sql
-- Private bucket for session recordings and evidence assets.
-- Path convention: {workspace_id}/{session_id}/{asset_id}/{filename}
-- ==========================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('session-assets', 'session-assets', false, 524288000) -- 500 MB
on conflict (id) do update set public = excluded.public,
                              file_size_limit = excluded.file_size_limit;

-- Storage object policies.
-- The first path segment MUST be the workspace_id; RLS validates that the
-- current user is an active member of that workspace.

create policy "session_assets_select" on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'session-assets'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

create policy "session_assets_insert" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'session-assets'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

create policy "session_assets_update" on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'session-assets'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'session-assets'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

create policy "session_assets_delete" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'session-assets'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );
