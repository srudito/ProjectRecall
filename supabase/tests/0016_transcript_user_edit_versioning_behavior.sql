-- Milestone 2B.4B.2 isolated PostgreSQL behavior verification.
-- Run only after migration 0016 has been applied to a reviewed disposable or
-- development Supabase environment with at least one confirmed Auth user.
-- The transaction is rolled back, so no verification rows persist.

begin;

do $$
declare
  actor_id uuid;
  workspace_id uuid;
  session_id uuid := gen_random_uuid();
  recording_id uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  run_id uuid := gen_random_uuid();
  provider_version_id uuid := gen_random_uuid();
  provider_segment_id uuid := gen_random_uuid();
  edit_version_id uuid := gen_random_uuid();
  later_edit_version_id uuid := gen_random_uuid();
  stale_edit_version_id uuid := gen_random_uuid();
  unchanged_edit_version_id uuid := gen_random_uuid();
  deletion_request_id uuid := gen_random_uuid();
  edit_result record;
  replay_result record;
  later_result record;
  caught_message text;
  rejected boolean;
begin
  select auth_user.id
    into actor_id
  from auth.users auth_user
  where not exists (
    select 1
    from public.account_deletion_requests deletion_request
    where deletion_request.user_id = auth_user.id
  )
  order by auth_user.created_at, auth_user.id
  limit 1;

  if actor_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_EDIT_AUTH_USER_REQUIRED';
  end if;

  select workspace.id
    into workspace_id
  from public.workspaces workspace
  join public.workspace_members member
    on member.workspace_id = workspace.id
   and member.user_id = actor_id
   and member.membership_status = 'active'
  where workspace.owner_user_id = actor_id
  order by workspace.created_at, workspace.id
  limit 1;

  if workspace_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_EDIT_WORKSPACE_REQUIRED';
  end if;

  if has_function_privilege(
       'anon',
       'public.create_transcript_user_edit_version_v1(uuid,uuid,uuid,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       'public.create_transcript_user_edit_version_v1(uuid,uuid,uuid,text)',
       'EXECUTE'
     )
     or has_table_privilege(
       'authenticated',
       'public.transcript_versions',
       'INSERT'
     )
     or has_table_privilege(
       'authenticated',
       'public.transcript_versions',
       'UPDATE'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_PRIVILEGE_MATRIX_CHECK_FAILED';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'create_transcript_user_edit_version_v1'
      and procedure.prosecdef is true
      and procedure.proconfig @> array['search_path=""']::text[]
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_SECURITY_DEFINER_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_USER_EDIT_PRIVILEGE_MATRIX=PASS';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated')::text,
    true
  );

  update public.feature_flags
  set enabled = false,
      updated_at = now()
  where flag_key = 'transcription_enabled';

  rejected := false;
  begin
    perform public.create_transcript_user_edit_version_v1(
      session_id,
      provider_version_id,
      edit_version_id,
      'Edited transcript.'
    );
  exception
    when others then
      get stacked diagnostics caught_message = message_text;
      if caught_message = 'TRANSCRIPT_EDIT_FEATURE_DISABLED' then
        rejected := true;
      else
        raise;
      end if;
  end;

  if not rejected then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_FEATURE_FLAG_CHECK_FAILED';
  end if;

  update public.feature_flags
  set enabled = true,
      updated_at = now()
  where flag_key = 'transcription_enabled';

  raise notice 'TRANSCRIPT_USER_EDIT_FEATURE_FLAG=PASS';

  insert into public.sessions (
    id,
    workspace_id,
    created_by,
    title,
    status,
    local_sync_status,
    cloud_sync_status
  ) values (
    session_id,
    workspace_id,
    actor_id,
    'Transcript edit verification',
    'recorded',
    'synchronized',
    'synchronized'
  );

  insert into public.recordings (
    id,
    workspace_id,
    session_id,
    private_storage_path,
    mime_type,
    original_file_name,
    file_size,
    duration_ms,
    recording_format,
    upload_status
  ) values (
    recording_id,
    workspace_id,
    session_id,
    workspace_id::text || '/' || session_id::text || '/' ||
      recording_id::text || '/recording.m4a',
    'audio/mp4',
    'recording.m4a',
    1,
    1000,
    'm4a',
    'synchronized'
  );

  insert into public.processing_jobs (
    id,
    workspace_id,
    session_id,
    recording_id,
    created_by,
    idempotency_key,
    request_payload
  ) values (
    job_id,
    workspace_id,
    session_id,
    recording_id,
    actor_id,
    'smoke:transcript-user-edit:' || session_id::text,
    jsonb_build_object(
      'contractVersion', 1,
      'languageMode', 'AUTO_DETECT',
      'requestedLanguages', jsonb_build_array(),
      'speakerDiarization', false
    )
  );

  insert into public.transcription_runs (
    id,
    processing_job_id,
    workspace_id,
    session_id,
    recording_id,
    created_by,
    provider_key,
    provider_model
  ) values (
    run_id,
    job_id,
    workspace_id,
    session_id,
    recording_id,
    actor_id,
    'smoke-provider',
    'smoke-model'
  );

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
    provider_version_id,
    workspace_id,
    session_id,
    run_id,
    actor_id,
    1,
    'provider',
    'final',
    null,
    'Provider transcript.',
    jsonb_build_object(
      'confidence', null,
      'detectedLanguages', jsonb_build_array('en'),
      'detectionEnabled', false,
      'primaryLanguage', 'en'
    ),
    encode(extensions.digest('Provider transcript.', 'sha256'), 'hex'),
    true
  );

  insert into public.transcript_segments (
    id,
    workspace_id,
    session_id,
    transcript_version_id,
    segment_index,
    start_ms,
    end_ms,
    text
  ) values (
    provider_segment_id,
    workspace_id,
    session_id,
    provider_version_id,
    0,
    0,
    1000,
    'Provider transcript.'
  );

  select *
    into edit_result
  from public.create_transcript_user_edit_version_v1(
    session_id,
    provider_version_id,
    edit_version_id,
    'Edited transcript.'
  );

  if edit_result.transcript_version_id <> edit_version_id
     or edit_result.version_number <> 2
     or edit_result.current_version_id <> edit_version_id
     or edit_result.was_created is not true
     or not exists (
       select 1
       from public.transcript_versions transcript_version
       where transcript_version.id = edit_version_id
         and transcript_version.workspace_id = workspace_id
         and transcript_version.session_id = session_id
         and transcript_version.transcription_run_id = run_id
         and transcript_version.created_by = actor_id
         and transcript_version.version = 2
         and transcript_version.version_origin = 'user_edit'
         and transcript_version.version_status = 'final'
         and transcript_version.parent_version_id = provider_version_id
         and transcript_version.plain_text = 'Edited transcript.'
         and transcript_version.language_summary = jsonb_build_object(
           'confidence', null,
           'detectedLanguages', jsonb_build_array('en'),
           'detectionEnabled', false,
           'primaryLanguage', 'en'
         )
         and transcript_version.content_checksum_sha256 =
           encode(extensions.digest('Edited transcript.', 'sha256'), 'hex')
         and transcript_version.is_current is true
     )
     or exists (
       select 1
       from public.transcript_versions transcript_version
       where transcript_version.id = provider_version_id
         and transcript_version.is_current is true
     )
     or exists (
       select 1
       from public.transcript_segments segment
       where segment.transcript_version_id = edit_version_id
     )
     or not exists (
       select 1
       from public.transcript_segments segment
       where segment.id = provider_segment_id
         and segment.transcript_version_id = provider_version_id
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_CREATE_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_USER_EDIT_CREATE=PASS';

  select *
    into replay_result
  from public.create_transcript_user_edit_version_v1(
    session_id,
    provider_version_id,
    edit_version_id,
    'Edited transcript.'
  );

  if replay_result.transcript_version_id <> edit_version_id
     or replay_result.version_number <> 2
     or replay_result.current_version_id <> edit_version_id
     or replay_result.was_created is not false then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_IDEMPOTENT_REPLAY_CHECK_FAILED';
  end if;

  select *
    into later_result
  from public.create_transcript_user_edit_version_v1(
    session_id,
    edit_version_id,
    later_edit_version_id,
    'Later edited transcript.'
  );

  if later_result.version_number <> 3
     or later_result.current_version_id <> later_edit_version_id
     or later_result.was_created is not true then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_SECOND_VERSION_CHECK_FAILED';
  end if;

  select *
    into replay_result
  from public.create_transcript_user_edit_version_v1(
    session_id,
    provider_version_id,
    edit_version_id,
    'Edited transcript.'
  );

  if replay_result.transcript_version_id <> edit_version_id
     or replay_result.version_number <> 2
     or replay_result.current_version_id <> later_edit_version_id
     or replay_result.was_created is not false then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_LATE_REPLAY_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_USER_EDIT_IDEMPOTENT_REPLAY=PASS';

  rejected := false;
  begin
    perform public.create_transcript_user_edit_version_v1(
      session_id,
      provider_version_id,
      stale_edit_version_id,
      'Stale edit.'
    );
  exception
    when others then
      get stacked diagnostics caught_message = message_text;
      if caught_message = 'TRANSCRIPT_EDIT_BASE_CONFLICT' then
        rejected := true;
      else
        raise;
      end if;
  end;

  if not rejected then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_STALE_BASE_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_USER_EDIT_STALE_BASE_CONFLICT=PASS';

  rejected := false;
  begin
    perform public.create_transcript_user_edit_version_v1(
      session_id,
      provider_version_id,
      edit_version_id,
      'Different payload.'
    );
  exception
    when others then
      get stacked diagnostics caught_message = message_text;
      if caught_message = 'TRANSCRIPT_EDIT_IDEMPOTENCY_CONFLICT' then
        rejected := true;
      else
        raise;
      end if;
  end;

  if not rejected then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_IDEMPOTENCY_CONFLICT_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_USER_EDIT_IDEMPOTENCY_CONFLICT=PASS';

  rejected := false;
  begin
    perform public.create_transcript_user_edit_version_v1(
      session_id,
      later_edit_version_id,
      unchanged_edit_version_id,
      'Later edited transcript.'
    );
  exception
    when others then
      get stacked diagnostics caught_message = message_text;
      if caught_message = 'TRANSCRIPT_EDIT_UNCHANGED' then
        rejected := true;
      else
        raise;
      end if;
  end;

  if not rejected then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_UNCHANGED_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_USER_EDIT_UNCHANGED_REJECTED=PASS';

  rejected := false;
  begin
    update public.transcript_versions
    set plain_text = 'Mutated content.'
    where id = later_edit_version_id;
  exception
    when others then
      get stacked diagnostics caught_message = message_text;
      if caught_message = 'TRANSCRIPT_VERSION_IMMUTABLE' then
        rejected := true;
      else
        raise;
      end if;
  end;

  if not rejected
     or not exists (
       select 1
       from public.transcript_versions transcript_version
       where transcript_version.id = later_edit_version_id
         and transcript_version.plain_text = 'Later edited transcript.'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_VERSION_IMMUTABLE_CONTENT_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_VERSION_IMMUTABLE_CONTENT=PASS';

  update public.workspace_members member
  set membership_status = 'removed'
  where member.workspace_id = workspace_id
    and member.user_id = actor_id;

  rejected := false;
  begin
    perform public.create_transcript_user_edit_version_v1(
      session_id,
      later_edit_version_id,
      gen_random_uuid(),
      'Membership-gated edit.'
    );
  exception
    when others then
      get stacked diagnostics caught_message = message_text;
      if caught_message = 'TRANSCRIPT_EDIT_FORBIDDEN' then
        rejected := true;
      else
        raise;
      end if;
  end;

  update public.workspace_members member
  set membership_status = 'active'
  where member.workspace_id = workspace_id
    and member.user_id = actor_id;

  if not rejected then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_MEMBERSHIP_GATE_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_USER_EDIT_MEMBERSHIP_GATE=PASS';

  insert into public.account_deletion_requests (
    user_id,
    request_id,
    status,
    expected_workspace_ids,
    attempt_count,
    lease_expires_at
  ) values (
    actor_id,
    deletion_request_id,
    'processing',
    array[workspace_id],
    1,
    now() + interval '5 minutes'
  );

  rejected := false;
  begin
    perform public.create_transcript_user_edit_version_v1(
      session_id,
      later_edit_version_id,
      gen_random_uuid(),
      'Deletion-gated edit.'
    );
  exception
    when others then
      get stacked diagnostics caught_message = message_text;
      if caught_message = 'TRANSCRIPT_EDIT_FORBIDDEN' then
        rejected := true;
      else
        raise;
      end if;
  end;

  delete from public.account_deletion_requests
  where user_id = actor_id;

  if not rejected then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_USER_EDIT_ACCOUNT_DELETION_GATE_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_USER_EDIT_ACCOUNT_DELETION_GATE=PASS';

  delete from public.transcription_runs
  where id = run_id;

  if exists (
    select 1
    from public.transcript_versions transcript_version
    where transcript_version.id in (
      provider_version_id,
      edit_version_id,
      later_edit_version_id
    )
      and transcript_version.transcription_run_id is not null
  )
  or not exists (
    select 1
    from public.transcript_versions transcript_version
    where transcript_version.id = later_edit_version_id
      and transcript_version.is_current is true
      and transcript_version.plain_text = 'Later edited transcript.'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPT_RUN_DELETE_SET_NULL_COMPATIBILITY_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPT_RUN_DELETE_SET_NULL_COMPATIBILITY=PASS';
  raise notice 'PROJECT_RECALL_TRANSCRIPT_USER_EDIT_VERSIONING=PASS';
end;
$$;

rollback;
