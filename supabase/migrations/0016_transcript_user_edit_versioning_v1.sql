-- ============================================================================
-- 0016_transcript_user_edit_versioning_v1.sql
-- Milestone 2B.4B.2: immutable user-edit transcript version server contract.
--
-- This append-only migration adds one narrow authenticated RPC for final
-- full-text edits. It preserves direct transcript-table writes as server-only,
-- uses a caller-supplied stable UUID for idempotency, rejects stale bases with
-- compare-and-swap semantics, and never rewrites provider transcript content.
-- It does not add mobile UI, SQLite state, Edge Functions, Cron, or secrets.
-- ============================================================================

begin;

-- User-edit rows are final immutable snapshots. Local drafts remain a later
-- mobile milestone and are not persisted in the remote version history.
alter table public.transcript_versions
  add constraint transcript_versions_user_edit_shape_check
    check (
      version_origin <> 'user_edit'
      or (
        version_status = 'final'
        and parent_version_id is not null
        and length(btrim(plain_text)) > 0
        and content_checksum_sha256 is not null
      )
    ),
  add constraint transcript_versions_no_self_parent_check
    check (parent_version_id is null or parent_version_id <> id);

create index if not exists idx_transcript_versions_parent
  on public.transcript_versions(parent_version_id)
  where parent_version_id is not null;

-- Version content and lineage are immutable after insert. The two nullable
-- provenance references may still be cleared by their existing ON DELETE SET
-- NULL foreign keys, while is_current/updated_at remain mutable so atomic
-- current-version switching and the existing touch_updated_at trigger continue
-- to work.
create or replace function public.guard_transcript_version_immutable_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.id is distinct from new.id
     or old.workspace_id is distinct from new.workspace_id
     or old.session_id is distinct from new.session_id
     or old.version is distinct from new.version
     or old.version_origin is distinct from new.version_origin
     or old.version_status is distinct from new.version_status
     or old.parent_version_id is distinct from new.parent_version_id
     or old.plain_text is distinct from new.plain_text
     or old.language_summary is distinct from new.language_summary
     or old.content_checksum_sha256 is distinct from new.content_checksum_sha256
     or old.created_at is distinct from new.created_at then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_VERSION_IMMUTABLE';
  end if;

  if old.transcription_run_id is distinct from new.transcription_run_id
     and not (
       old.transcription_run_id is not null
       and new.transcription_run_id is null
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_VERSION_IMMUTABLE';
  end if;

  if old.created_by is distinct from new.created_by
     and not (
       old.created_by is not null
       and new.created_by is null
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_VERSION_IMMUTABLE';
  end if;

  return new;
end;
$$;

revoke all
on function public.guard_transcript_version_immutable_v1()
from public, anon, authenticated, service_role;

drop trigger if exists guard_transcript_version_immutable_v1
on public.transcript_versions;

create trigger guard_transcript_version_immutable_v1
before update on public.transcript_versions
for each row
execute function public.guard_transcript_version_immutable_v1();

-- Create one final user-edit version from the caller's currently observed
-- version. The session row is the shared serialization lock used by the
-- provider completion path, so provider results and user edits cannot allocate
-- the same version number or both become current.
create or replace function public.create_transcript_user_edit_version_v1(
  p_session_id uuid,
  p_expected_current_version_id uuid,
  p_client_version_id uuid,
  p_plain_text text
)
returns table (
  transcript_version_id uuid,
  version_number integer,
  current_version_id uuid,
  was_created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_workspace_id uuid;
  locked_session public.sessions%rowtype;
  current_version public.transcript_versions%rowtype;
  existing_version public.transcript_versions%rowtype;
  next_version integer;
  checksum_sha256 text;
  demoted_count integer;
begin
  if caller_id is null then
    raise exception using
      errcode = '42501',
      message = 'TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED';
  end if;

  if p_session_id is null
     or p_expected_current_version_id is null
     or p_client_version_id is null
     or p_client_version_id = p_expected_current_version_id
     or p_plain_text is null
     or length(btrim(p_plain_text)) = 0
     or octet_length(p_plain_text) > 8 * 1024 * 1024 then
    raise exception using
      errcode = '22023',
      message = 'TRANSCRIPT_EDIT_INPUT_INVALID';
  end if;

  if not exists (
    select 1
    from public.feature_flags feature_flag
    where feature_flag.flag_key = 'transcription_enabled'
      and feature_flag.enabled is true
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_EDIT_FEATURE_DISABLED';
  end if;

  -- Acquire the same account-deletion shared locks used by authenticated
  -- workspace mutations before taking ordinary row locks. This preserves the
  -- existing deletion lock order and also performs the active-member check.
  select target_session.workspace_id
    into target_workspace_id
  from public.sessions target_session
  where target_session.id = p_session_id
    and target_session.deleted_at is null
    and target_session.status not in ('deleting', 'deleted');

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_EDIT_SESSION_UNAVAILABLE';
  end if;

  if public.can_write_workspace(target_workspace_id) is not true then
    raise exception using
      errcode = '42501',
      message = 'TRANSCRIPT_EDIT_FORBIDDEN';
  end if;

  select target_session.*
    into locked_session
  from public.sessions target_session
  where target_session.id = p_session_id
    and target_session.workspace_id = target_workspace_id
    and target_session.deleted_at is null
    and target_session.status not in ('deleting', 'deleted')
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_EDIT_SESSION_UNAVAILABLE';
  end if;

  select transcript_version.*
    into current_version
  from public.transcript_versions transcript_version
  where transcript_version.session_id = locked_session.id
    and transcript_version.workspace_id = locked_session.workspace_id
    and transcript_version.is_current is true
    and transcript_version.version_status = 'final'
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_EDIT_CURRENT_VERSION_UNAVAILABLE';
  end if;

  checksum_sha256 := encode(
    extensions.digest(p_plain_text, 'sha256'),
    'hex'
  );

  -- A retry after an ambiguous network result must return the original
  -- committed operation even if a later edit has already become current.
  select transcript_version.*
    into existing_version
  from public.transcript_versions transcript_version
  where transcript_version.id = p_client_version_id;

  if found then
    if existing_version.workspace_id <> locked_session.workspace_id
       or existing_version.session_id <> locked_session.id
       or existing_version.version_origin <> 'user_edit'
       or existing_version.version_status <> 'final'
       or existing_version.parent_version_id
          is distinct from p_expected_current_version_id
       or existing_version.created_by is distinct from caller_id
       or existing_version.plain_text is distinct from p_plain_text
       or existing_version.content_checksum_sha256
          is distinct from checksum_sha256 then
      raise exception using
        errcode = 'P0001',
        message = 'TRANSCRIPT_EDIT_IDEMPOTENCY_CONFLICT';
    end if;

    return query
      select
        existing_version.id,
        existing_version.version,
        current_version.id,
        false;
    return;
  end if;

  if current_version.id <> p_expected_current_version_id then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_EDIT_BASE_CONFLICT';
  end if;

  if current_version.plain_text is not distinct from p_plain_text then
    raise exception using
      errcode = '22023',
      message = 'TRANSCRIPT_EDIT_UNCHANGED';
  end if;

  select coalesce(max(transcript_version.version), 0) + 1
    into next_version
  from public.transcript_versions transcript_version
  where transcript_version.session_id = locked_session.id;

  update public.transcript_versions transcript_version
  set is_current = false,
      updated_at = now()
  where transcript_version.id = current_version.id
    and transcript_version.session_id = locked_session.id
    and transcript_version.is_current is true;

  get diagnostics demoted_count = row_count;
  if demoted_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_EDIT_CURRENT_VERSION_CONFLICT';
  end if;

  begin
    insert into public.transcript_versions (
      id,
      workspace_id,
      session_id,
      transcription_run_id,
      created_by,
      version,
      version_origin,
      version_status,
      parent_version_id,
      plain_text,
      language_summary,
      content_checksum_sha256,
      is_current
    ) values (
      p_client_version_id,
      locked_session.workspace_id,
      locked_session.id,
      current_version.transcription_run_id,
      caller_id,
      next_version,
      'user_edit',
      'final',
      current_version.id,
      p_plain_text,
      current_version.language_summary,
      checksum_sha256,
      true
    );
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = 'TRANSCRIPT_EDIT_IDEMPOTENCY_CONFLICT';
  end;

  return query
    select
      p_client_version_id,
      next_version,
      p_client_version_id,
      true;
end;
$$;

comment on function public.create_transcript_user_edit_version_v1(
  uuid,
  uuid,
  uuid,
  text
) is
  'Creates one immutable final full-text user-edit version with stable UUID idempotency and stale-base conflict protection.';

revoke all
on function public.create_transcript_user_edit_version_v1(
  uuid,
  uuid,
  uuid,
  text
)
from public, anon, authenticated, service_role;

grant execute
on function public.create_transcript_user_edit_version_v1(
  uuid,
  uuid,
  uuid,
  text
)
to authenticated;

commit;
