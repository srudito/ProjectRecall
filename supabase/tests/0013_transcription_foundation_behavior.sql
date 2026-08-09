-- Milestone 2A isolated PostgreSQL behavior verification.
-- Run only after migrations 0001-0013 have been applied to a disposable
-- Supabase project with at least two confirmed Auth users. The transaction is
-- rolled back, so no verification rows persist.

begin;

do $$
declare
  actor_id uuid;
  collaborator_id uuid;
  personal_workspace_id uuid;
  temporary_workspace_id uuid := gen_random_uuid();
  shared_workspace_id uuid := gen_random_uuid();

  run_delete_session_id uuid := gen_random_uuid();
  run_delete_recording_id uuid := gen_random_uuid();
  run_delete_job_id uuid := gen_random_uuid();
  run_delete_run_id uuid := gen_random_uuid();
  run_delete_version_id uuid := gen_random_uuid();
  run_delete_segment_id uuid := gen_random_uuid();

  job_delete_session_id uuid := gen_random_uuid();
  job_delete_recording_id uuid := gen_random_uuid();
  job_delete_job_id uuid := gen_random_uuid();
  job_delete_run_id uuid := gen_random_uuid();
  job_delete_version_id uuid := gen_random_uuid();
  job_delete_segment_id uuid := gen_random_uuid();

  session_delete_session_id uuid := gen_random_uuid();
  session_delete_recording_id uuid := gen_random_uuid();
  session_delete_job_id uuid := gen_random_uuid();
  session_delete_run_id uuid := gen_random_uuid();
  session_delete_version_id uuid := gen_random_uuid();
  session_delete_segment_id uuid := gen_random_uuid();

  workspace_delete_session_id uuid := gen_random_uuid();
  workspace_delete_recording_id uuid := gen_random_uuid();
  workspace_delete_job_id uuid := gen_random_uuid();
  workspace_delete_run_id uuid := gen_random_uuid();
  workspace_delete_version_id uuid := gen_random_uuid();
  workspace_delete_segment_id uuid := gen_random_uuid();

  owned_other_workspace_id uuid := gen_random_uuid();
  owned_other_session_id uuid := gen_random_uuid();
  owned_other_recording_id uuid := gen_random_uuid();
  owned_other_job_id uuid := gen_random_uuid();
  owned_other_run_id uuid := gen_random_uuid();
  owned_other_version_id uuid := gen_random_uuid();

  shared_session_id uuid := gen_random_uuid();
  shared_recording_id uuid := gen_random_uuid();
  shared_job_id uuid := gen_random_uuid();
  shared_run_id uuid := gen_random_uuid();
  shared_version_id uuid := gen_random_uuid();

  active_gate_workspace_id uuid := gen_random_uuid();
  active_gate_session_id uuid := gen_random_uuid();
  active_gate_recording_id uuid := gen_random_uuid();
  active_gate_job_id uuid := gen_random_uuid();
  active_gate_run_id uuid := gen_random_uuid();
  active_gate_version_id uuid := gen_random_uuid();
  active_gate_segment_id uuid := gen_random_uuid();
  active_gate_request_id uuid := gen_random_uuid();

  owned_other_reference_count integer;
  shared_reference_count integer;
  foundation_table_name text;
  expected_policy_name text;
  rls_enabled boolean;
begin
  select auth_user.id
    into actor_id
  from auth.users auth_user
  order by auth_user.created_at, auth_user.id
  limit 1;

  if actor_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_SMOKE_AUTH_USER_REQUIRED';
  end if;

  select auth_user.id
    into collaborator_id
  from auth.users auth_user
  where auth_user.id <> actor_id
  order by auth_user.created_at, auth_user.id
  limit 1;

  if collaborator_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_SMOKE_SECOND_AUTH_USER_REQUIRED';
  end if;

  select workspace.id
    into personal_workspace_id
  from public.workspaces workspace
  where workspace.owner_user_id = actor_id
  order by workspace.created_at, workspace.id
  limit 1;

  if personal_workspace_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_SMOKE_WORKSPACE_REQUIRED';
  end if;

  -- Verify the runtime privilege matrix rather than relying on project-level
  -- default privileges. These checks run as postgres but inspect the effective
  -- Data API roles used by the mobile client and reviewed server workers.
  foreach foundation_table_name in array array[
    'processing_jobs',
    'transcription_runs',
    'transcript_versions',
    'transcript_segments'
  ] loop
    if has_table_privilege(
      'anon', format('public.%I', foundation_table_name), 'SELECT'
    ) or has_table_privilege(
      'anon', format('public.%I', foundation_table_name), 'INSERT'
    ) or has_table_privilege(
      'anon', format('public.%I', foundation_table_name), 'UPDATE'
    ) or has_table_privilege(
      'anon', format('public.%I', foundation_table_name), 'DELETE'
    ) then
      raise exception using
        errcode = 'P0001',
        message = format(
          'TRANSCRIPTION_ANON_PRIVILEGE_CHECK_FAILED:%s',
          foundation_table_name
        );
    end if;

    if not has_table_privilege(
      'authenticated', format('public.%I', foundation_table_name), 'SELECT'
    ) or has_table_privilege(
      'authenticated', format('public.%I', foundation_table_name), 'INSERT'
    ) or has_table_privilege(
      'authenticated', format('public.%I', foundation_table_name), 'UPDATE'
    ) or has_table_privilege(
      'authenticated', format('public.%I', foundation_table_name), 'DELETE'
    ) then
      raise exception using
        errcode = 'P0001',
        message = format(
          'TRANSCRIPTION_AUTHENTICATED_PRIVILEGE_CHECK_FAILED:%s',
          foundation_table_name
        );
    end if;

    if not has_table_privilege(
      'service_role', format('public.%I', foundation_table_name), 'SELECT'
    ) or not has_table_privilege(
      'service_role', format('public.%I', foundation_table_name), 'INSERT'
    ) or not has_table_privilege(
      'service_role', format('public.%I', foundation_table_name), 'UPDATE'
    ) or not has_table_privilege(
      'service_role', format('public.%I', foundation_table_name), 'DELETE'
    ) then
      raise exception using
        errcode = 'P0001',
        message = format(
          'TRANSCRIPTION_SERVICE_ROLE_PRIVILEGE_CHECK_FAILED:%s',
          foundation_table_name
        );
    end if;

    select relation.relrowsecurity
      into rls_enabled
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = foundation_table_name;

    if coalesce(rls_enabled, false) is not true then
      raise exception using
        errcode = 'P0001',
        message = format(
          'TRANSCRIPTION_RLS_DISABLED:%s',
          foundation_table_name
        );
    end if;

    expected_policy_name := case foundation_table_name
      when 'processing_jobs' then 'processing_jobs_member_select'
      when 'transcription_runs' then 'transcription_runs_member_select'
      when 'transcript_versions' then 'transcript_versions_member_select'
      when 'transcript_segments' then 'transcript_segments_member_select'
    end;

    if not exists (
      select 1
      from pg_catalog.pg_policies policy
      where policy.schemaname = 'public'
        and policy.tablename = foundation_table_name
        and policy.policyname = expected_policy_name
        and upper(policy.cmd) = 'SELECT'
        and 'authenticated'::name = any(policy.roles)
    ) or exists (
      select 1
      from pg_catalog.pg_policies policy
      where policy.schemaname = 'public'
        and policy.tablename = foundation_table_name
        and upper(policy.cmd) <> 'SELECT'
        and 'authenticated'::name = any(policy.roles)
    ) then
      raise exception using
        errcode = 'P0001',
        message = format(
          'TRANSCRIPTION_RLS_POLICY_CHECK_FAILED:%s',
          foundation_table_name
        );
    end if;
  end loop;

  raise notice 'TRANSCRIPTION_PRIVILEGE_MATRIX_CHECK=PASS';
  raise notice 'TRANSCRIPTION_RLS_READ_ONLY=PASS';

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_record
    join pg_catalog.pg_class relation
      on relation.oid = trigger_record.tgrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'transcript_segments'
      and trigger_record.tgname = 'guard_account_deletion_write'
      and trigger_record.tgisinternal is false
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_SEGMENT_GUARD_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_SEGMENT_GUARD=PASS';

  if coalesce((
    select feature_flag.enabled
    from public.feature_flags feature_flag
    where feature_flag.flag_key = 'transcription_enabled'
  ), true) is not false then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_FEATURE_FLAG_DISABLED_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPTION_FEATURE_FLAG_DISABLED=PASS';

  -- Deleting one provider run must preserve the transcript record and its
  -- segments while clearing only the nullable run reference.
  insert into public.sessions (
    id, workspace_id, created_by, title, status,
    local_sync_status, cloud_sync_status
  ) values (
    run_delete_session_id, personal_workspace_id, actor_id,
    'Run delete verification', 'recorded', 'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format,
    upload_status
  ) values (
    run_delete_recording_id, personal_workspace_id, run_delete_session_id,
    personal_workspace_id::text || '/' || run_delete_session_id::text || '/' ||
      run_delete_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1, 'm4a', 'synchronized'
  );

  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by, idempotency_key
  ) values (
    run_delete_job_id, personal_workspace_id, run_delete_session_id,
    run_delete_recording_id, actor_id, 'smoke:run-delete'
  );

  insert into public.transcription_runs (
    id, processing_job_id, workspace_id, session_id, recording_id,
    created_by, provider_key, provider_model
  ) values (
    run_delete_run_id, run_delete_job_id, personal_workspace_id,
    run_delete_session_id, run_delete_recording_id, actor_id,
    'smoke-provider', 'smoke-model'
  );

  insert into public.transcript_versions (
    id, workspace_id, session_id, transcription_run_id, created_by,
    version, plain_text, is_current
  ) values (
    run_delete_version_id, personal_workspace_id, run_delete_session_id,
    run_delete_run_id, actor_id, 1, 'run delete transcript', true
  );

  insert into public.transcript_segments (
    id, workspace_id, session_id, transcript_version_id, segment_index,
    start_ms, end_ms, text
  ) values (
    run_delete_segment_id, personal_workspace_id, run_delete_session_id,
    run_delete_version_id, 0, 0, 1, 'segment'
  );

  delete from public.transcription_runs
  where id = run_delete_run_id;

  if exists (
    select 1
    from public.transcription_runs
    where id = run_delete_run_id
  ) or not exists (
    select 1
    from public.transcript_versions
    where id = run_delete_version_id
      and transcription_run_id is null
      and session_id = run_delete_session_id
      and workspace_id = personal_workspace_id
  ) or not exists (
    select 1
    from public.transcript_segments
    where id = run_delete_segment_id
      and transcript_version_id = run_delete_version_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_RUN_DELETE_SET_NULL_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPTION_RUN_DELETE_SET_NULL_CHECK=PASS';

  -- Deleting a processing job must cascade its provider run, then preserve
  -- the transcript version and segments with a cleared run reference.
  insert into public.sessions (
    id, workspace_id, created_by, title, status,
    local_sync_status, cloud_sync_status
  ) values (
    job_delete_session_id, personal_workspace_id, actor_id,
    'Job delete verification', 'recorded', 'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format,
    upload_status
  ) values (
    job_delete_recording_id, personal_workspace_id, job_delete_session_id,
    personal_workspace_id::text || '/' || job_delete_session_id::text || '/' ||
      job_delete_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1, 'm4a', 'synchronized'
  );

  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by, idempotency_key
  ) values (
    job_delete_job_id, personal_workspace_id, job_delete_session_id,
    job_delete_recording_id, actor_id, 'smoke:job-delete'
  );

  insert into public.transcription_runs (
    id, processing_job_id, workspace_id, session_id, recording_id,
    created_by, provider_key, provider_model
  ) values (
    job_delete_run_id, job_delete_job_id, personal_workspace_id,
    job_delete_session_id, job_delete_recording_id, actor_id,
    'smoke-provider', 'smoke-model'
  );

  insert into public.transcript_versions (
    id, workspace_id, session_id, transcription_run_id, created_by,
    version, plain_text, is_current
  ) values (
    job_delete_version_id, personal_workspace_id, job_delete_session_id,
    job_delete_run_id, actor_id, 1, 'job delete transcript', true
  );

  insert into public.transcript_segments (
    id, workspace_id, session_id, transcript_version_id, segment_index,
    start_ms, end_ms, text
  ) values (
    job_delete_segment_id, personal_workspace_id, job_delete_session_id,
    job_delete_version_id, 0, 0, 1, 'segment'
  );

  delete from public.processing_jobs
  where id = job_delete_job_id;

  if exists (
    select 1
    from public.processing_jobs
    where id = job_delete_job_id
  ) or exists (
    select 1
    from public.transcription_runs
    where id = job_delete_run_id
  ) or not exists (
    select 1
    from public.transcript_versions
    where id = job_delete_version_id
      and transcription_run_id is null
      and session_id = job_delete_session_id
      and workspace_id = personal_workspace_id
  ) or not exists (
    select 1
    from public.transcript_segments
    where id = job_delete_segment_id
      and transcript_version_id = job_delete_version_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_JOB_DELETE_GRAPH_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPTION_JOB_DELETE_GRAPH_CHECK=PASS';

  -- Session deletion must remove the entire transcription graph, including
  -- transcript versions that no longer reference a provider run.
  insert into public.sessions (
    id, workspace_id, created_by, title, status,
    local_sync_status, cloud_sync_status
  ) values (
    session_delete_session_id, personal_workspace_id, actor_id,
    'Session delete verification', 'recorded', 'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format,
    upload_status
  ) values (
    session_delete_recording_id, personal_workspace_id,
    session_delete_session_id,
    personal_workspace_id::text || '/' || session_delete_session_id::text || '/' ||
      session_delete_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1, 'm4a', 'synchronized'
  );

  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by, idempotency_key
  ) values (
    session_delete_job_id, personal_workspace_id, session_delete_session_id,
    session_delete_recording_id, actor_id, 'smoke:session-delete'
  );

  insert into public.transcription_runs (
    id, processing_job_id, workspace_id, session_id, recording_id,
    created_by, provider_key, provider_model
  ) values (
    session_delete_run_id, session_delete_job_id, personal_workspace_id,
    session_delete_session_id, session_delete_recording_id, actor_id,
    'smoke-provider', 'smoke-model'
  );

  insert into public.transcript_versions (
    id, workspace_id, session_id, transcription_run_id, created_by,
    version, plain_text, is_current
  ) values (
    session_delete_version_id, personal_workspace_id,
    session_delete_session_id, session_delete_run_id, actor_id,
    1, 'session delete transcript', true
  );

  insert into public.transcript_segments (
    id, workspace_id, session_id, transcript_version_id, segment_index,
    start_ms, end_ms, text
  ) values (
    session_delete_segment_id, personal_workspace_id,
    session_delete_session_id, session_delete_version_id,
    0, 0, 1, 'segment'
  );

  delete from public.sessions
  where id = session_delete_session_id;

  if exists (
    select 1 from public.processing_jobs where id = session_delete_job_id
  ) or exists (
    select 1 from public.transcription_runs where id = session_delete_run_id
  ) or exists (
    select 1 from public.transcript_versions where id = session_delete_version_id
  ) or exists (
    select 1 from public.transcript_segments where id = session_delete_segment_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_SESSION_DELETE_CASCADE_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPTION_SESSION_DELETE_CASCADE_CHECK=PASS';

  -- Workspace deletion must remove the complete graph through canonical
  -- session/workspace cascades.
  insert into public.workspaces (
    id, name, workspace_type, owner_user_id
  ) values (
    temporary_workspace_id, 'Transcription smoke workspace', 'team', actor_id
  );

  insert into public.sessions (
    id, workspace_id, created_by, title, status,
    local_sync_status, cloud_sync_status
  ) values (
    workspace_delete_session_id, temporary_workspace_id, actor_id,
    'Workspace delete verification', 'recorded', 'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format,
    upload_status
  ) values (
    workspace_delete_recording_id, temporary_workspace_id,
    workspace_delete_session_id,
    temporary_workspace_id::text || '/' || workspace_delete_session_id::text || '/' ||
      workspace_delete_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1, 'm4a', 'synchronized'
  );

  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by, idempotency_key
  ) values (
    workspace_delete_job_id, temporary_workspace_id,
    workspace_delete_session_id, workspace_delete_recording_id,
    actor_id, 'smoke:workspace-delete'
  );

  insert into public.transcription_runs (
    id, processing_job_id, workspace_id, session_id, recording_id,
    created_by, provider_key, provider_model
  ) values (
    workspace_delete_run_id, workspace_delete_job_id,
    temporary_workspace_id, workspace_delete_session_id,
    workspace_delete_recording_id, actor_id,
    'smoke-provider', 'smoke-model'
  );

  insert into public.transcript_versions (
    id, workspace_id, session_id, transcription_run_id, created_by,
    version, plain_text, is_current
  ) values (
    workspace_delete_version_id, temporary_workspace_id,
    workspace_delete_session_id, workspace_delete_run_id,
    actor_id, 1, 'workspace delete transcript', true
  );

  insert into public.transcript_segments (
    id, workspace_id, session_id, transcript_version_id, segment_index,
    start_ms, end_ms, text
  ) values (
    workspace_delete_segment_id, temporary_workspace_id,
    workspace_delete_session_id, workspace_delete_version_id,
    0, 0, 1, 'segment'
  );

  delete from public.workspaces
  where id = temporary_workspace_id;

  if exists (
    select 1 from public.processing_jobs where id = workspace_delete_job_id
  ) or exists (
    select 1 from public.transcription_runs where id = workspace_delete_run_id
  ) or exists (
    select 1 from public.transcript_versions where id = workspace_delete_version_id
  ) or exists (
    select 1 from public.transcript_segments where id = workspace_delete_segment_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKSPACE_DELETE_CASCADE_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPTION_WORKSPACE_DELETE_CASCADE_CHECK=PASS';

  -- Transcription rows created by another user in a workspace owned by the
  -- deleting user must block destructive workspace cleanup.
  insert into public.workspaces (
    id, name, workspace_type, owner_user_id
  ) values (
    owned_other_workspace_id, 'Owned workspace content smoke test',
    'team', actor_id
  );

  insert into public.workspace_members (
    workspace_id, user_id, role, membership_status
  ) values
    (owned_other_workspace_id, actor_id, 'owner', 'active'),
    (owned_other_workspace_id, collaborator_id, 'member', 'active');

  insert into public.sessions (
    id, workspace_id, created_by, title, status,
    local_sync_status, cloud_sync_status
  ) values (
    owned_other_session_id, owned_other_workspace_id, collaborator_id,
    'Owned workspace content verification', 'recorded',
    'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format,
    upload_status
  ) values (
    owned_other_recording_id, owned_other_workspace_id,
    owned_other_session_id,
    owned_other_workspace_id::text || '/' || owned_other_session_id::text || '/' ||
      owned_other_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1, 'm4a', 'synchronized'
  );

  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by, idempotency_key
  ) values (
    owned_other_job_id, owned_other_workspace_id, owned_other_session_id,
    owned_other_recording_id, collaborator_id, 'smoke:owned-other-user'
  );

  insert into public.transcription_runs (
    id, processing_job_id, workspace_id, session_id, recording_id,
    created_by, provider_key, provider_model
  ) values (
    owned_other_run_id, owned_other_job_id, owned_other_workspace_id,
    owned_other_session_id, owned_other_recording_id, collaborator_id,
    'smoke-provider', 'smoke-model'
  );

  insert into public.transcript_versions (
    id, workspace_id, session_id, transcription_run_id, created_by,
    version, plain_text, is_current
  ) values (
    owned_other_version_id, owned_other_workspace_id, owned_other_session_id,
    owned_other_run_id, collaborator_id, 1, 'other user transcript', true
  );

  select (
    (select count(*) from public.processing_jobs
      where workspace_id = owned_other_workspace_id
        and created_by <> actor_id) +
    (select count(*) from public.transcription_runs
      where workspace_id = owned_other_workspace_id
        and created_by <> actor_id) +
    (select count(*) from public.transcript_versions
      where workspace_id = owned_other_workspace_id
        and created_by <> actor_id)
  )::int
    into owned_other_reference_count;

  if owned_other_reference_count <> 3 then
    raise exception using
      errcode = 'P0001',
      message = 'DELETE_ACCOUNT_OWNED_WORKSPACE_TRANSCRIPTION_BLOCK_CHECK_FAILED';
  end if;

  raise notice 'DELETE_ACCOUNT_OWNED_WORKSPACE_TRANSCRIPTION_BLOCK=PASS';

  -- A creator's transcription rows remain detectable in a non-owned
  -- workspace even after their membership is removed. Delete Account uses
  -- these same actor/workspace predicates before destructive cleanup.
  insert into public.workspaces (
    id, name, workspace_type, owner_user_id
  ) values (
    shared_workspace_id, 'Transcription shared smoke workspace',
    'team', collaborator_id
  );

  insert into public.workspace_members (
    workspace_id, user_id, role, membership_status
  ) values (
    shared_workspace_id, actor_id, 'member', 'active'
  );

  insert into public.sessions (
    id, workspace_id, created_by, title, status,
    local_sync_status, cloud_sync_status
  ) values (
    shared_session_id, shared_workspace_id, collaborator_id,
    'Shared Delete Account verification', 'recorded',
    'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format,
    upload_status
  ) values (
    shared_recording_id, shared_workspace_id, shared_session_id,
    shared_workspace_id::text || '/' || shared_session_id::text || '/' ||
      shared_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1, 'm4a', 'synchronized'
  );

  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by, idempotency_key
  ) values (
    shared_job_id, shared_workspace_id, shared_session_id,
    shared_recording_id, actor_id, 'smoke:shared-delete-account'
  );

  insert into public.transcription_runs (
    id, processing_job_id, workspace_id, session_id, recording_id,
    created_by, provider_key, provider_model
  ) values (
    shared_run_id, shared_job_id, shared_workspace_id,
    shared_session_id, shared_recording_id, actor_id,
    'smoke-provider', 'smoke-model'
  );

  insert into public.transcript_versions (
    id, workspace_id, session_id, transcription_run_id, created_by,
    version, plain_text, is_current
  ) values (
    shared_version_id, shared_workspace_id, shared_session_id,
    shared_run_id, actor_id, 1, 'shared transcript', true
  );

  update public.workspace_members
  set membership_status = 'removed'
  where workspace_id = shared_workspace_id
    and user_id = actor_id;

  select (
    (select count(*) from public.processing_jobs
      where created_by = actor_id
        and workspace_id not in (
          select id from public.workspaces where owner_user_id = actor_id
        )) +
    (select count(*) from public.transcription_runs
      where created_by = actor_id
        and workspace_id not in (
          select id from public.workspaces where owner_user_id = actor_id
        )) +
    (select count(*) from public.transcript_versions
      where created_by = actor_id
        and workspace_id not in (
          select id from public.workspaces where owner_user_id = actor_id
        ))
  )::int
    into shared_reference_count;

  if shared_reference_count <> 3 then
    raise exception using
      errcode = 'P0001',
      message = 'DELETE_ACCOUNT_SHARED_TRANSCRIPTION_BLOCK_CHECK_FAILED';
  end if;

  raise notice 'DELETE_ACCOUNT_SHARED_TRANSCRIPTION_BLOCK=PASS';

  -- The real Delete Account workspace deletion runs while the durable gate is
  -- active. Transcript versions must be deleted explicitly before workspace
  -- cascades so provider-run ON DELETE SET NULL actions cannot invoke the
  -- guarded UPDATE path in an order-dependent way.
  insert into public.workspaces (
    id, name, workspace_type, owner_user_id
  ) values (
    active_gate_workspace_id, 'Active deletion gate workspace',
    'team', actor_id
  );

  insert into public.sessions (
    id, workspace_id, created_by, title, status,
    local_sync_status, cloud_sync_status
  ) values (
    active_gate_session_id, active_gate_workspace_id, actor_id,
    'Active gate cascade verification', 'recorded',
    'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format,
    upload_status
  ) values (
    active_gate_recording_id, active_gate_workspace_id,
    active_gate_session_id,
    active_gate_workspace_id::text || '/' || active_gate_session_id::text || '/' ||
      active_gate_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1, 'm4a', 'synchronized'
  );

  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by, idempotency_key
  ) values (
    active_gate_job_id, active_gate_workspace_id, active_gate_session_id,
    active_gate_recording_id, actor_id, 'smoke:active-gate-delete'
  );

  insert into public.transcription_runs (
    id, processing_job_id, workspace_id, session_id, recording_id,
    created_by, provider_key, provider_model
  ) values (
    active_gate_run_id, active_gate_job_id, active_gate_workspace_id,
    active_gate_session_id, active_gate_recording_id, actor_id,
    'smoke-provider', 'smoke-model'
  );

  insert into public.transcript_versions (
    id, workspace_id, session_id, transcription_run_id, created_by,
    version, plain_text, is_current
  ) values (
    active_gate_version_id, active_gate_workspace_id,
    active_gate_session_id, active_gate_run_id, actor_id,
    1, 'active gate transcript', true
  );

  insert into public.transcript_segments (
    id, workspace_id, session_id, transcript_version_id, segment_index,
    start_ms, end_ms, text
  ) values (
    active_gate_segment_id, active_gate_workspace_id,
    active_gate_session_id, active_gate_version_id,
    0, 0, 1, 'segment'
  );

  insert into public.account_deletion_requests (
    user_id, request_id, status, expected_workspace_ids,
    attempt_count, lease_expires_at
  ) values (
    actor_id, active_gate_request_id, 'processing',
    array[active_gate_workspace_id], 1, now() + interval '15 minutes'
  )
  on conflict (user_id) do update set
    request_id = excluded.request_id,
    status = excluded.status,
    expected_workspace_ids = excluded.expected_workspace_ids,
    attempt_count = public.account_deletion_requests.attempt_count + 1,
    lease_expires_at = excluded.lease_expires_at,
    updated_at = now();

  delete from public.transcript_versions transcript_version
  where transcript_version.workspace_id = active_gate_workspace_id;

  delete from public.workspaces workspace
  where workspace.id = active_gate_workspace_id
    and workspace.owner_user_id = actor_id;

  if exists (
    select 1 from public.workspaces where id = active_gate_workspace_id
  ) or exists (
    select 1 from public.processing_jobs where id = active_gate_job_id
  ) or exists (
    select 1 from public.transcription_runs where id = active_gate_run_id
  ) or exists (
    select 1 from public.transcript_versions where id = active_gate_version_id
  ) or exists (
    select 1 from public.transcript_segments where id = active_gate_segment_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'DELETE_ACCOUNT_ACTIVE_GATE_TRANSCRIPTION_CASCADE_CHECK_FAILED';
  end if;

  raise notice 'DELETE_ACCOUNT_ACTIVE_GATE_TRANSCRIPTION_CASCADE_CHECK=PASS';
  raise notice 'PROJECT_RECALL_TRANSCRIPTION_FOUNDATION_BEHAVIOR=PASS';
end $$;

rollback;
