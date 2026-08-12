-- Milestone 2B.1B disposable PostgreSQL behavior verification.
-- Run only after migrations 0001-0014 on a disposable Supabase project with
-- at least two confirmed Auth users. The transaction is rolled back.

begin;

do $$
<<behavior>>
declare
  actor_id uuid;
  secondary_actor_id uuid;
  workspace_id uuid;
  request_session_id uuid := gen_random_uuid();
  request_recording_id uuid := gen_random_uuid();
  request_job_id uuid;
  request_job_id_again uuid;
  request_job_id_changed_intent uuid;
  first_claim record;
  second_claim record;
  first_attempt_count integer;
  second_attempt_count integer;
  null_retryable_rejected boolean := false;
  feature_disabled_rejected boolean := false;

  ambiguous_session_id uuid := gen_random_uuid();
  ambiguous_recording_id uuid := gen_random_uuid();
  ambiguous_job_id uuid;
  ambiguous_claim record;
  ambiguous_retry_claim record;

  deadline_session_id uuid := gen_random_uuid();
  deadline_recording_id uuid := gen_random_uuid();
  deadline_job_id uuid;
  deadline_claim record;

  complete_session_id uuid := gen_random_uuid();
  complete_recording_id uuid := gen_random_uuid();
  complete_job_id uuid;
  complete_claim record;
  complete_poll_claim record;
  complete_poll_claim_again record;
  complete_version_id uuid;
  completion_intent_rejected boolean := false;
  submission_reconciliation_state text;
  attempt_count_before_poll integer;
  attempt_count_after_poll integer;
  cleanup_claim record;
  cleanup_claim_again record;
  cleanup_blocked_claim record;
  cleanup_released_claim record;
  cleanup_blocked_job_id uuid;
  cleanup_bypass_job_id uuid := gen_random_uuid();
  complete_provider_job_id uuid := gen_random_uuid();

  membership_session_id uuid := gen_random_uuid();
  membership_recording_id uuid := gen_random_uuid();
  membership_job_id uuid;
  membership_claim record;
  membership_terminal_session_id uuid := gen_random_uuid();
  membership_terminal_recording_id uuid := gen_random_uuid();
  membership_terminal_job_id uuid;
  membership_terminal_claim record;
  membership_post_submit_retry_session_id uuid := gen_random_uuid();
  membership_post_submit_retry_recording_id uuid := gen_random_uuid();
  membership_post_submit_retry_job_id uuid;
  membership_post_submit_retry_claim record;
  membership_post_submit_retry_result text;
  membership_post_submit_terminal_session_id uuid := gen_random_uuid();
  membership_post_submit_terminal_recording_id uuid := gen_random_uuid();
  membership_post_submit_terminal_job_id uuid;
  membership_post_submit_terminal_claim record;
  membership_post_submit_terminal_result text;
  membership_cleanup_session_id uuid := gen_random_uuid();
  membership_cleanup_recording_id uuid := gen_random_uuid();
  membership_cleanup_job_id uuid;
  membership_cleanup_claim record;
  membership_cleanup_provider_job_id uuid := gen_random_uuid();
  membership_cleanup_cleanup_claim record;
  membership_cleanup_completed boolean := false;

  gate_session_id uuid := gen_random_uuid();
  gate_recording_id uuid := gen_random_uuid();
  gate_job_id uuid := gen_random_uuid();
  gate_run_id uuid := gen_random_uuid();

  recovery_result record;
  gate_error text;
  caught_error_message text;
  metadata_rejected boolean := false;
  metadata_case_rejected boolean;
  metadata_case jsonb;
  metadata_rejection_count integer := 0;
begin
  select auth_user.id into actor_id
  from auth.users auth_user
  order by auth_user.created_at, auth_user.id
  limit 1;

  if actor_id is null then
    raise exception using errcode = 'P0001', message = 'M2B1B_AUTH_USER_REQUIRED';
  end if;

  select auth_user.id into secondary_actor_id
  from auth.users auth_user
  where auth_user.id <> actor_id
  order by auth_user.created_at, auth_user.id
  limit 1;

  if secondary_actor_id is null then
    raise exception using errcode = 'P0001', message = 'M2B1B_SECOND_AUTH_USER_REQUIRED';
  end if;

  select workspace.id into workspace_id
  from public.workspaces workspace
  where workspace.owner_user_id = actor_id
  order by workspace.created_at, workspace.id
  limit 1;

  if workspace_id is null then
    raise exception using errcode = 'P0001', message = 'M2B1B_WORKSPACE_REQUIRED';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated')::text,
    true
  );

  begin
    perform public.request_transcription_job(gen_random_uuid());
  exception when others then
    get stacked diagnostics caught_error_message = message_text;
    if caught_error_message = 'TRANSCRIPTION_FEATURE_DISABLED' then
      feature_disabled_rejected := true;
    else
      raise;
    end if;
  end;
  if not feature_disabled_rejected then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_FEATURE_DISABLED_REQUEST_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_FEATURE_DISABLED_REQUEST_CHECK=PASS';

  update public.feature_flags
  set enabled = true, updated_at = now()
  where flag_key = 'transcription_enabled';

  -- Request idempotency and queued-run reuse after a pre-submission lease loss.
  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    request_session_id, workspace_id, actor_id, 'M2B1B request', 'recorded',
    'SINGLE_LANGUAGE', array['id'], 'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    request_recording_id, workspace_id, request_session_id,
    workspace_id::text || '/' || request_session_id::text || '/' ||
      request_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );

  select job_id into request_job_id
  from public.request_transcription_job(request_recording_id);
  select job_id into request_job_id_again
  from public.request_transcription_job(request_recording_id);

  if request_job_id is null or request_job_id_again <> request_job_id then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_REQUEST_IDEMPOTENCY_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_REQUEST_IDEMPOTENCY_CHECK=PASS';

  update public.sessions
  set spoken_language_mode = 'MULTILINGUAL',
      expected_spoken_languages = array['en','id']
  where id = request_session_id;

  select job_id into request_job_id_changed_intent
  from public.request_transcription_job(request_recording_id);

  if request_job_id_changed_intent <> request_job_id
     or (
       select count(*)
       from public.processing_jobs job
       where job.recording_id = request_recording_id
         and job.status in ('queued','leased','processing')
     ) <> 1 then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_ACTIVE_RECORDING_JOB_REUSE_CHECK_FAILED';
  end if;

  update public.sessions
  set spoken_language_mode = 'SINGLE_LANGUAGE',
      expected_spoken_languages = array['id']
  where id = request_session_id;

  raise notice 'TRANSCRIPTION_ACTIVE_RECORDING_JOB_REUSE_CHECK=PASS';

  select * into first_claim
  from public.claim_transcription_jobs('smoke-worker-a', 1, 45);

  if first_claim.job_id <> request_job_id or first_claim.action <> 'submit' then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_FIRST_CLAIM_FAILED';
  end if;

  select attempt_count into first_attempt_count
  from public.processing_jobs where id = request_job_id;
  if first_attempt_count <> 0 then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_PRE_SUBMISSION_ATTEMPT_ACCOUNTING_CHECK_FAILED';
  end if;

  begin
    perform public.record_transcription_submission_failure(
      first_claim.job_id,
      first_claim.run_id,
      'smoke-worker-a',
      'TRANSCRIPTION_PROVIDER_NETWORK_FAILED',
      'Provider unavailable.',
      null,
      null,
      30
    );
  exception when others then
    get stacked diagnostics caught_error_message = message_text;
    if caught_error_message = 'TRANSCRIPTION_FAILURE_INPUT_INVALID' then
      null_retryable_rejected := true;
    else
      raise;
    end if;
  end;
  if not null_retryable_rejected then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_NULL_RETRYABLE_REJECTION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_NULL_RETRYABLE_REJECTION_CHECK=PASS';

  if public.record_transcription_submission_failure(
    first_claim.job_id,
    first_claim.run_id,
    'smoke-worker-a',
    'TRANSCRIPTION_STORAGE_SIGNING_FAILED',
    'The synchronized recording could not be prepared for transcription.',
    true,
    null,
    1
  ) <> 'retry_submission' then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_PRE_SUBMISSION_RETRY_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_PRE_SUBMISSION_RETRY_CHECK=PASS';

  update public.processing_jobs
  set next_attempt_at = now()
  where id = request_job_id;

  select * into second_claim
  from public.claim_transcription_jobs('smoke-worker-b', 1, 45);

  if second_claim.job_id <> request_job_id
     or second_claim.run_id <> first_claim.run_id
     or second_claim.action <> 'submit' then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_QUEUED_RUN_REUSE_CHECK_FAILED';
  end if;

  select attempt_count into second_attempt_count
  from public.processing_jobs where id = request_job_id;
  if second_attempt_count <> 1 then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_PRE_SUBMISSION_ATTEMPT_ACCOUNTING_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_PRE_SUBMISSION_ATTEMPT_ACCOUNTING_CHECK=PASS';

  update public.transcription_runs
  set status = 'failed', completed_at = now()
  where id = second_claim.run_id;
  update public.processing_jobs
  set status = 'failed', lease_owner = null, lease_expires_at = null,
      completed_at = now()
  where id = request_job_id;
  raise notice 'TRANSCRIPTION_QUEUED_RUN_REUSE_CHECK=PASS';

  -- A provider-free queued request must not become an unclaimable account-
  -- deletion blocker after its creator loses workspace membership.
  insert into public.workspace_members (
    workspace_id, user_id, role, membership_status
  ) values (
    workspace_id, secondary_actor_id, 'member', 'active'
  ) on conflict on constraint workspace_members_workspace_id_user_id_key do update
    set membership_status = 'active', role = 'member';

  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    membership_session_id, workspace_id, secondary_actor_id,
    'Membership loss request', 'recorded', 'SINGLE_LANGUAGE', array['id'],
    'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    membership_recording_id, workspace_id, membership_session_id,
    workspace_id::text || '/' || membership_session_id::text || '/' ||
      membership_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', secondary_actor_id, 'role', 'authenticated')::text,
    true
  );

  select job_id into membership_job_id
  from public.request_transcription_job(membership_recording_id);

  select * into membership_claim
  from public.claim_transcription_jobs('smoke-worker-membership', 1, 45);

  if membership_claim.job_id <> membership_job_id
     or membership_claim.action <> 'submit' then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_CLAIM_CHECK_FAILED';
  end if;

  update public.workspace_members member
  set membership_status = 'removed'
  where member.workspace_id = behavior.workspace_id
    and member.user_id = secondary_actor_id;

  if membership_job_id is null
     or exists (
       select 1 from public.processing_jobs where id = membership_job_id
     )
     or exists (
       select 1 from public.transcription_runs
       where id = membership_claim.run_id
     ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_CANCELLATION_CHECK_FAILED';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated')::text,
    true
  );

  raise notice 'TRANSCRIPTION_MEMBERSHIP_LOSS_CANCELLATION_CHECK=PASS';

  -- A terminal provider-free failure has no provider artifact or transcript
  -- content and must not remain as a permanent non-owned-workspace blocker.
  insert into public.workspace_members (
    workspace_id, user_id, role, membership_status
  ) values (
    workspace_id, secondary_actor_id, 'member', 'active'
  ) on conflict on constraint workspace_members_workspace_id_user_id_key do update
    set membership_status = 'active', role = 'member';

  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    membership_terminal_session_id, workspace_id, secondary_actor_id,
    'Membership terminal failure', 'recorded', 'SINGLE_LANGUAGE', array['id'],
    'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    membership_terminal_recording_id, workspace_id,
    membership_terminal_session_id,
    workspace_id::text || '/' || membership_terminal_session_id::text || '/' ||
      membership_terminal_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', secondary_actor_id, 'role', 'authenticated')::text,
    true
  );

  select job_id into membership_terminal_job_id
  from public.request_transcription_job(membership_terminal_recording_id);

  select * into membership_terminal_claim
  from public.claim_transcription_jobs('smoke-worker-membership-terminal', 1, 45);

  if membership_terminal_claim.job_id <> membership_terminal_job_id
     or membership_terminal_claim.action <> 'submit'
     or public.record_transcription_submission_failure(
       membership_terminal_claim.job_id,
       membership_terminal_claim.run_id,
       'smoke-worker-membership-terminal',
       'TRANSCRIPTION_PROVIDER_AUTH_FAILED',
       'The transcription provider is not configured correctly.',
       false,
       null,
       30
     ) <> 'failed' then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_TERMINAL_PROVIDER_FREE_CHECK_FAILED';
  end if;

  update public.workspace_members member
  set membership_status = 'removed'
  where member.workspace_id = behavior.workspace_id
    and member.user_id = secondary_actor_id;

  if exists (
       select 1 from public.processing_jobs
       where id = membership_terminal_job_id
     )
     or exists (
       select 1 from public.transcription_runs
       where id = membership_terminal_claim.run_id
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_TERMINAL_PROVIDER_FREE_CHECK_FAILED';
  end if;

  raise notice 'TRANSCRIPTION_MEMBERSHIP_LOSS_TERMINAL_PROVIDER_FREE_CHECK=PASS';

  -- Membership can be revoked after the durable submitting boundary commits
  -- but before a provider-free failure is persisted. Both retryable and
  -- terminal no-ID failures must prune the now-safe graph immediately rather
  -- than leave an unclaimable non-owned-workspace creator reference.
  insert into public.workspace_members (
    workspace_id, user_id, role, membership_status
  ) values (
    workspace_id, secondary_actor_id, 'member', 'active'
  ) on conflict on constraint workspace_members_workspace_id_user_id_key do update
    set membership_status = 'active', role = 'member';

  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    membership_post_submit_retry_session_id, workspace_id, secondary_actor_id,
    'Membership post-submit retryable failure', 'recorded',
    'SINGLE_LANGUAGE', array['id'], 'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    membership_post_submit_retry_recording_id, workspace_id,
    membership_post_submit_retry_session_id,
    workspace_id::text || '/' || membership_post_submit_retry_session_id::text || '/' ||
      membership_post_submit_retry_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', secondary_actor_id, 'role', 'authenticated')::text,
    true
  );

  select job_id into membership_post_submit_retry_job_id
  from public.request_transcription_job(membership_post_submit_retry_recording_id);

  select * into membership_post_submit_retry_claim
  from public.claim_transcription_jobs(
    'smoke-worker-membership-post-submit-retry', 1, 45
  );

  if membership_post_submit_retry_claim.job_id <>
       membership_post_submit_retry_job_id
     or not public.begin_transcription_submission(
       membership_post_submit_retry_claim.job_id,
       membership_post_submit_retry_claim.run_id,
       'smoke-worker-membership-post-submit-retry'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_SUBMISSION_FAILURE_CHECK_FAILED';
  end if;

  update public.workspace_members member
  set membership_status = 'removed'
  where member.workspace_id = behavior.workspace_id
    and member.user_id = secondary_actor_id;

  select public.record_transcription_submission_failure(
    membership_post_submit_retry_claim.job_id,
    membership_post_submit_retry_claim.run_id,
    'smoke-worker-membership-post-submit-retry',
    'TRANSCRIPTION_PROVIDER_RATE_LIMITED',
    'The transcription provider is temporarily unavailable.',
    true,
    null,
    30
  ) into membership_post_submit_retry_result;

  if membership_post_submit_retry_result <> 'failed'
     or exists (
       select 1 from public.processing_jobs
       where id = membership_post_submit_retry_job_id
     )
     or exists (
       select 1 from public.transcription_runs
       where id = membership_post_submit_retry_claim.run_id
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_SUBMISSION_FAILURE_CHECK_FAILED';
  end if;

  insert into public.workspace_members (
    workspace_id, user_id, role, membership_status
  ) values (
    workspace_id, secondary_actor_id, 'member', 'active'
  ) on conflict on constraint workspace_members_workspace_id_user_id_key do update
    set membership_status = 'active', role = 'member';

  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    membership_post_submit_terminal_session_id, workspace_id, secondary_actor_id,
    'Membership post-submit terminal failure', 'recorded',
    'SINGLE_LANGUAGE', array['id'], 'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    membership_post_submit_terminal_recording_id, workspace_id,
    membership_post_submit_terminal_session_id,
    workspace_id::text || '/' || membership_post_submit_terminal_session_id::text || '/' ||
      membership_post_submit_terminal_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );

  select job_id into membership_post_submit_terminal_job_id
  from public.request_transcription_job(membership_post_submit_terminal_recording_id);

  select * into membership_post_submit_terminal_claim
  from public.claim_transcription_jobs(
    'smoke-worker-membership-post-submit-terminal', 1, 45
  );

  if membership_post_submit_terminal_claim.job_id <>
       membership_post_submit_terminal_job_id
     or not public.begin_transcription_submission(
       membership_post_submit_terminal_claim.job_id,
       membership_post_submit_terminal_claim.run_id,
       'smoke-worker-membership-post-submit-terminal'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_SUBMISSION_FAILURE_CHECK_FAILED';
  end if;

  update public.workspace_members member
  set membership_status = 'removed'
  where member.workspace_id = behavior.workspace_id
    and member.user_id = secondary_actor_id;

  select public.record_transcription_submission_failure(
    membership_post_submit_terminal_claim.job_id,
    membership_post_submit_terminal_claim.run_id,
    'smoke-worker-membership-post-submit-terminal',
    'TRANSCRIPTION_PROVIDER_AUTH_FAILED',
    'The transcription provider is not configured correctly.',
    false,
    null,
    30
  ) into membership_post_submit_terminal_result;

  if membership_post_submit_terminal_result <> 'failed'
     or exists (
       select 1 from public.processing_jobs
       where id = membership_post_submit_terminal_job_id
     )
     or exists (
       select 1 from public.transcription_runs
       where id = membership_post_submit_terminal_claim.run_id
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_SUBMISSION_FAILURE_CHECK_FAILED';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated')::text,
    true
  );

  raise notice 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_SUBMISSION_FAILURE_CHECK=PASS';

  -- If membership is removed while a provider artifact still needs cleanup,
  -- keep the graph until deletion is confirmed, then prune the now-safe
  -- queued/terminal provider graph so it cannot become a permanent creator blocker.
  insert into public.workspace_members (
    workspace_id, user_id, role, membership_status
  ) values (
    workspace_id, secondary_actor_id, 'member', 'active'
  ) on conflict on constraint workspace_members_workspace_id_user_id_key do update
    set membership_status = 'active', role = 'member';

  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    membership_cleanup_session_id, workspace_id, secondary_actor_id,
    'Membership cleanup pending', 'recorded', 'SINGLE_LANGUAGE', array['id'],
    'synchronized', 'synchronized'
  );

  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    membership_cleanup_recording_id, workspace_id,
    membership_cleanup_session_id,
    workspace_id::text || '/' || membership_cleanup_session_id::text || '/' ||
      membership_cleanup_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', secondary_actor_id, 'role', 'authenticated')::text,
    true
  );

  select job_id into membership_cleanup_job_id
  from public.request_transcription_job(membership_cleanup_recording_id);

  select * into membership_cleanup_claim
  from public.claim_transcription_jobs('smoke-worker-membership-cleanup', 1, 45);

  if membership_cleanup_claim.job_id <> membership_cleanup_job_id
     or not public.begin_transcription_submission(
       membership_cleanup_claim.job_id,
       membership_cleanup_claim.run_id,
       'smoke-worker-membership-cleanup'
     )
     or not public.mark_transcription_job_submitted(
       membership_cleanup_claim.job_id,
       membership_cleanup_claim.run_id,
       'smoke-worker-membership-cleanup',
       membership_cleanup_provider_job_id::text,
       jsonb_build_object(
         'region','EU','speechModelRequested','universal-2','status','queued'
       ),
       1,
       3600
     ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_CLEANUP_CHECK_FAILED';
  end if;

  update public.processing_jobs
  set next_attempt_at = now()
  where id = membership_cleanup_job_id;

  select * into membership_cleanup_claim
  from public.claim_transcription_jobs('smoke-worker-membership-cleanup-poll', 1, 45);

  if public.record_transcription_poll_failure(
       membership_cleanup_claim.job_id,
       membership_cleanup_claim.run_id,
       'smoke-worker-membership-cleanup-poll',
       'TRANSCRIPTION_PROVIDER_RESULT_INVALID',
       'The transcription provider returned an invalid result.',
       true,
       true,
       30
     ) <> 'retry_new_run' then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_CLEANUP_CHECK_FAILED';
  end if;

  update public.workspace_members member
  set membership_status = 'removed'
  where member.workspace_id = behavior.workspace_id
    and member.user_id = secondary_actor_id;

  if not exists (
    select 1 from public.processing_jobs
    where id = membership_cleanup_job_id and status = 'queued'
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_CLEANUP_CHECK_FAILED';
  end if;

  select * into membership_cleanup_cleanup_claim
  from public.claim_transcription_cleanup(
    'smoke-worker-membership-cleanup-delete', 1, 45
  );

  membership_cleanup_completed := public.complete_transcription_cleanup(
    membership_cleanup_cleanup_claim.run_id,
    'smoke-worker-membership-cleanup-delete',
    membership_cleanup_cleanup_claim.provider_job_id
  );

  if membership_cleanup_cleanup_claim.run_id <> membership_cleanup_claim.run_id
     or not membership_cleanup_completed
     or exists (
       select 1 from public.processing_jobs where id = membership_cleanup_job_id
     )
     or exists (
       select 1 from public.transcription_runs
       where id = membership_cleanup_claim.run_id
     ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_CLEANUP_CHECK_FAILED';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated')::text,
    true
  );

  raise notice 'TRANSCRIPTION_MEMBERSHIP_LOSS_POST_CLEANUP_CHECK=PASS';

  -- Expired lease after durable submitting state must fail closed.
  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    ambiguous_session_id, workspace_id, actor_id, 'Ambiguous submit', 'recorded',
    'SINGLE_LANGUAGE', array['id'], 'synchronized', 'synchronized'
  );
  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    ambiguous_recording_id, workspace_id, ambiguous_session_id,
    workspace_id::text || '/' || ambiguous_session_id::text || '/' ||
      ambiguous_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );
  select job_id into ambiguous_job_id
  from public.request_transcription_job(ambiguous_recording_id);
  select * into ambiguous_claim
  from public.claim_transcription_jobs('smoke-worker-c', 1, 45);
  if not public.begin_transcription_submission(
    ambiguous_claim.job_id, ambiguous_claim.run_id, 'smoke-worker-c'
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_BEGIN_SUBMISSION_FAILED';
  end if;
  update public.processing_jobs
  set lease_expires_at = now() - interval '1 second'
  where id = ambiguous_job_id;
  perform * from public.recover_expired_transcription_work(20);

  if not exists (
    select 1 from public.processing_jobs job
    join public.transcription_runs run on run.processing_job_id = job.id
    where job.id = ambiguous_job_id
      and job.status = 'failed'
      and run.status = 'failed'
      and run.provider_cleanup_status = 'manual_review'
      and run.last_error_code = 'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_AMBIGUOUS_SUBMISSION_RECOVERY_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_AMBIGUOUS_SUBMISSION_RECOVERY_CHECK=PASS';

  if public.confirm_transcription_provider_absence(
       ambiguous_claim.run_id
     ) is not true then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_CONFIRMED_ABSENCE_FUNCTION_FALSE';
  end if;

  if not exists (
    select 1
    from public.transcription_runs
    where id = ambiguous_claim.run_id
      and provider_job_id is null
      and provider_cleanup_status = 'succeeded'
      and provider_cleanup_completed_at is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_CONFIRMED_ABSENCE_RUN_NOT_CLEAN';
  end if;

  if not exists (
    select 1
    from public.processing_jobs
    where id = ambiguous_job_id
      and status = 'queued'
      and completed_at is null
      and next_attempt_at is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_CONFIRMED_ABSENCE_JOB_NOT_REQUEUED';
  end if;
  raise notice 'TRANSCRIPTION_CONFIRMED_ABSENCE_CHECK=PASS';

  select * into ambiguous_retry_claim
  from public.claim_transcription_jobs('smoke-worker-c-retry', 1, 45);

  if ambiguous_retry_claim.job_id <> ambiguous_job_id
     or ambiguous_retry_claim.action <> 'submit'
     or ambiguous_retry_claim.run_id = ambiguous_claim.run_id
     or not exists (
       select 1 from public.transcription_runs
       where id = ambiguous_retry_claim.run_id
         and processing_job_id = ambiguous_job_id
         and run_attempt = 2
         and status = 'queued'
     ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_CONFIRMED_ABSENCE_RETRY_CHECK_FAILED';
  end if;

  update public.transcription_runs
  set status = 'failed', completed_at = now()
  where id = ambiguous_retry_claim.run_id;
  update public.processing_jobs
  set status = 'failed', lease_owner = null, lease_expires_at = null,
      completed_at = now(), next_attempt_at = null
  where id = ambiguous_job_id;

  raise notice 'TRANSCRIPTION_CONFIRMED_ABSENCE_RETRY_CHECK=PASS';

  -- Provider processing deadline must create durable cleanup work.
  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    deadline_session_id, workspace_id, actor_id, 'Deadline', 'recorded',
    'SINGLE_LANGUAGE', array['id'], 'synchronized', 'synchronized'
  );
  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    deadline_recording_id, workspace_id, deadline_session_id,
    workspace_id::text || '/' || deadline_session_id::text || '/' ||
      deadline_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );
  select job_id into deadline_job_id
  from public.request_transcription_job(deadline_recording_id);
  select * into deadline_claim
  from public.claim_transcription_jobs('smoke-worker-d', 1, 45);
  perform public.begin_transcription_submission(
    deadline_claim.job_id, deadline_claim.run_id, 'smoke-worker-d'
  );
  perform public.mark_transcription_job_submitted(
    deadline_claim.job_id,
    deadline_claim.run_id,
    'smoke-worker-d',
    gen_random_uuid()::text,
    jsonb_build_object('status','queued','region','EU','speechModelRequested','universal-2'),
    15,
    3600
  );
  select public.record_transcription_submission_failure(
    deadline_claim.job_id,
    deadline_claim.run_id,
    'smoke-worker-d',
    'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
    'Submission response persistence was uncertain.',
    false,
    (select provider_job_id from public.transcription_runs where id = deadline_claim.run_id),
    30
  ) into submission_reconciliation_state;
  if submission_reconciliation_state <> 'already_submitted' then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_SUBMISSION_RECONCILIATION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_SUBMISSION_RECONCILIATION_CHECK=PASS';

  update public.transcription_runs
  set provider_processing_deadline_at = now() - interval '1 second'
  where id = deadline_claim.run_id;
  perform * from public.recover_expired_transcription_work(20);

  if not exists (
    select 1 from public.transcription_runs run
    join public.processing_jobs job on job.id = run.processing_job_id
    where run.id = deadline_claim.run_id
      and run.status = 'failed'
      and run.provider_cleanup_status = 'pending'
      and job.status = 'failed'
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_PROVIDER_DEADLINE_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_PROVIDER_DEADLINE_CHECK=PASS';

  select * into cleanup_claim
  from public.claim_transcription_cleanup('smoke-worker-deadline', 1, 45);
  if cleanup_claim.run_id <> deadline_claim.run_id
     or public.fail_transcription_cleanup(
       cleanup_claim.run_id,
       'smoke-worker-deadline',
       'TRANSCRIPTION_PROVIDER_JOB_FAILED',
       'Provider cleanup requires manual confirmation.',
       false,
       60
     ) <> 'manual_review'
     or not public.confirm_transcription_provider_absence(cleanup_claim.run_id) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_CLEANUP_MANUAL_REVIEW_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_CLEANUP_MANUAL_REVIEW_CHECK=PASS';

  -- Complete one provider result atomically, then verify cleanup retry.
  insert into public.sessions (
    id, workspace_id, created_by, title, status, spoken_language_mode,
    expected_spoken_languages, local_sync_status, cloud_sync_status
  ) values (
    complete_session_id, workspace_id, actor_id, 'Complete', 'recorded',
    'SINGLE_LANGUAGE', array['id'], 'synchronized', 'synchronized'
  );
  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    complete_recording_id, workspace_id, complete_session_id,
    workspace_id::text || '/' || complete_session_id::text || '/' ||
      complete_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );
  select job_id into complete_job_id
  from public.request_transcription_job(complete_recording_id);
  select * into complete_claim
  from public.claim_transcription_jobs('smoke-worker-e', 1, 45);
  perform public.begin_transcription_submission(
    complete_claim.job_id, complete_claim.run_id, 'smoke-worker-e'
  );
  perform public.mark_transcription_job_submitted(
    complete_claim.job_id,
    complete_claim.run_id,
    'smoke-worker-e',
    complete_provider_job_id::text,
    jsonb_build_object('status','queued','region','EU','speechModelRequested','universal-2'),
    1,
    3600
  );
  select attempt_count into attempt_count_before_poll
  from public.processing_jobs where id = complete_job_id;
  if attempt_count_before_poll <> 1 then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_SUBMISSION_ATTEMPT_ACCOUNTING_CHECK_FAILED';
  end if;

  update public.processing_jobs set next_attempt_at = now()
  where id = complete_job_id;
  select * into complete_poll_claim
  from public.claim_transcription_jobs('smoke-worker-f', 1, 45);
  if not public.record_transcription_poll_result(
    complete_poll_claim.job_id,
    complete_poll_claim.run_id,
    'smoke-worker-f',
    jsonb_build_object('status','processing','region','EU'),
    1
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_POLL_PERSISTENCE_CHECK_FAILED';
  end if;

  select attempt_count into attempt_count_after_poll
  from public.processing_jobs where id = complete_job_id;
  if attempt_count_after_poll <> attempt_count_before_poll then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_POLL_ATTEMPT_ACCOUNTING_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_POLL_ATTEMPT_ACCOUNTING_CHECK=PASS';

  update public.processing_jobs set next_attempt_at = now()
  where id = complete_job_id;
  select * into complete_poll_claim_again
  from public.claim_transcription_jobs('smoke-worker-f2', 1, 45);

  begin
    perform public.complete_transcription_job(
      complete_poll_claim_again.job_id,
      complete_poll_claim_again.run_id,
      'smoke-worker-f2',
      complete_provider_job_id::text,
      'Halo dunia.',
      jsonb_build_object(
        'primaryLanguage','id',
        'detectedLanguages',jsonb_build_array('id'),
        'confidence',0.99,
        'detectionEnabled',true
      ),
      jsonb_build_array(jsonb_build_object(
        'segmentIndex',0,
        'startMs',0,
        'endMs',1000,
        'text','Halo dunia.',
        'confidence',0.99,
        'languageCode','id',
        'speakerLabel',null,
        'providerSegmentId',complete_provider_job_id::text || ':word:0'
      )),
      jsonb_build_object(
        'status','completed',
        'speechModelUsed','universal-2',
        'audioDurationSeconds',1,
        'languageConfidence',0.99,
        'speakerLabels',false,
        'wordCount',1,
        'utteranceCount',0,
        'region','EU'
      ),
      '30addc6b7cb964fcc87804aea7c968dcc97ab5f0c15ebb9b2926ad60c89999ea'
    );
  exception when others then
    get stacked diagnostics caught_error_message = message_text;
    if caught_error_message = 'TRANSCRIPTION_RESULT_INVALID' then
      completion_intent_rejected := true;
    else
      raise;
    end if;
  end;
  if not completion_intent_rejected then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_COMPLETION_INTENT_MISMATCH_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_COMPLETION_INTENT_MISMATCH_CHECK=PASS';

  select public.complete_transcription_job(
    complete_poll_claim_again.job_id,
    complete_poll_claim_again.run_id,
    'smoke-worker-f2',
    complete_provider_job_id::text,
    'Halo dunia.',
    jsonb_build_object(
      'primaryLanguage','id',
      'detectedLanguages',jsonb_build_array('id'),
      'confidence',0.99,
      'detectionEnabled',false
    ),
    jsonb_build_array(jsonb_build_object(
      'segmentIndex',0,
      'startMs',0,
      'endMs',1000,
      'text','Halo dunia.',
      'confidence',0.99,
      'languageCode','id',
      'speakerLabel',null,
      'providerSegmentId',complete_provider_job_id::text || ':word:0'
    )),
    jsonb_build_object(
      'status','completed',
      'speechModelUsed','universal-2',
      'audioDurationSeconds',1,
      'languageConfidence',0.99,
      'speakerLabels',false,
      'wordCount',1,
      'utteranceCount',0,
      'region','EU'
    ),
    '30addc6b7cb964fcc87804aea7c968dcc97ab5f0c15ebb9b2926ad60c89999ea'
  ) into complete_version_id;

  if complete_version_id is null
     or not exists (
       select 1 from public.processing_jobs where id = complete_job_id and status = 'succeeded'
     )
     or not exists (
       select 1 from public.transcription_runs
       where id = complete_claim.run_id
         and status = 'succeeded'
         and provider_cleanup_status = 'pending'
     )
     or not exists (
       select 1 from public.transcript_versions
       where id = complete_version_id and is_current and plain_text = 'Halo dunia.'
     )
     or not exists (
       select 1 from public.transcript_segments
       where transcript_version_id = complete_version_id and segment_index = 0
     ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_ATOMIC_COMPLETION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_ATOMIC_COMPLETION_CHECK=PASS';

  -- A new intent for the same recording must reuse the terminal job while
  -- its provider artifact is unresolved. Defense-in-depth claim logic also
  -- blocks a directly inserted queued job until cleanup succeeds.
  update public.sessions
  set spoken_language_mode = 'MULTILINGUAL',
      expected_spoken_languages = array['en','id']
  where id = complete_session_id;

  select job_id into cleanup_blocked_job_id
  from public.request_transcription_job(complete_recording_id);

  if cleanup_blocked_job_id <> complete_job_id
     or exists (
       select 1
       from public.processing_jobs job
       where job.recording_id = complete_recording_id
         and job.status in ('queued','leased','processing')
     ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_NEW_REQUEST_BLOCKED_BY_CLEANUP_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_NEW_REQUEST_BLOCKED_BY_CLEANUP_CHECK=PASS';

  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by,
    idempotency_key, status, next_attempt_at, request_payload
  ) values (
    cleanup_bypass_job_id, workspace_id, complete_session_id,
    complete_recording_id, actor_id, 'm2b1b:cleanup-bypass', 'queued', now(),
    jsonb_build_object(
      'contractVersion',1,
      'languageMode','MULTILINGUAL',
      'requestedLanguages',jsonb_build_array('en','id'),
      'speakerDiarization',false
    )
  );

  select * into cleanup_blocked_claim
  from public.claim_transcription_jobs('smoke-worker-cleanup-blocked', 1, 45);

  if cleanup_blocked_claim.job_id is not null then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_RETRY_BLOCKED_BY_CLEANUP_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_RETRY_BLOCKED_BY_CLEANUP_CHECK=PASS';

  select * into cleanup_claim
  from public.claim_transcription_cleanup('smoke-worker-g', 1, 45);
  if public.fail_transcription_cleanup(
    cleanup_claim.run_id,
    'smoke-worker-g',
    'TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN',
    'Provider deletion could not be confirmed.',
    true,
    1
  ) <> 'retry_cleanup' then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_CLEANUP_RETRY_CHECK_FAILED';
  end if;
  update public.transcription_runs set provider_cleanup_next_attempt_at = now()
  where id = cleanup_claim.run_id;
  select * into cleanup_claim_again
  from public.claim_transcription_cleanup('smoke-worker-h', 1, 45);
  if not public.complete_transcription_cleanup(
    cleanup_claim_again.run_id,
    'smoke-worker-h',
    cleanup_claim_again.provider_job_id
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_CLEANUP_RETRY_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_CLEANUP_RETRY_CHECK=PASS';

  select * into cleanup_released_claim
  from public.claim_transcription_jobs('smoke-worker-cleanup-released', 1, 45);

  if cleanup_released_claim.job_id <> cleanup_bypass_job_id
     or cleanup_released_claim.action <> 'submit'
     or cleanup_released_claim.run_id = complete_claim.run_id then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_RETRY_AFTER_CLEANUP_CHECK_FAILED';
  end if;

  update public.transcription_runs
  set status = 'failed', completed_at = now()
  where id = cleanup_released_claim.run_id;
  update public.processing_jobs
  set status = 'failed', lease_owner = null, lease_expires_at = null,
      completed_at = now()
  where id = cleanup_released_claim.job_id;

  raise notice 'TRANSCRIPTION_RETRY_AFTER_CLEANUP_CHECK=PASS';

  -- Session deletion must block provider submission and cleanup work.
  insert into public.sessions (
    id, workspace_id, created_by, title, status,
    local_sync_status, cloud_sync_status
  ) values (
    gate_session_id, workspace_id, actor_id, 'Delete gate', 'recorded',
    'synchronized', 'synchronized'
  );
  insert into public.recordings (
    id, workspace_id, session_id, private_storage_path, mime_type,
    original_file_name, file_size, duration_ms, recording_format, upload_status
  ) values (
    gate_recording_id, workspace_id, gate_session_id,
    workspace_id::text || '/' || gate_session_id::text || '/' ||
      gate_recording_id::text || '/recording.m4a',
    'audio/mp4', 'recording.m4a', 1, 1000, 'm4a', 'synchronized'
  );
  insert into public.processing_jobs (
    id, workspace_id, session_id, recording_id, created_by,
    idempotency_key, request_payload, status
  ) values (
    gate_job_id, workspace_id, gate_session_id, gate_recording_id, actor_id,
    'm2b1b:delete-gate',
    jsonb_build_object(
      'contractVersion',1,
      'languageMode','SINGLE_LANGUAGE',
      'requestedLanguages',jsonb_build_array('id'),
      'speakerDiarization',false
    ),
    'processing'
  );
  insert into public.transcription_runs (
    id, processing_job_id, workspace_id, session_id, recording_id, created_by,
    run_attempt, provider_key, provider_model, provider_region,
    request_mode, requested_languages, status, provider_metadata,
    submission_started_at, started_at
  ) values (
    gate_run_id, gate_job_id, workspace_id, gate_session_id,
    gate_recording_id, actor_id, 1, 'assemblyai', 'universal-2', 'EU',
    'SINGLE_LANGUAGE', array['id'], 'submitting',
    jsonb_build_object('region','EU','speechModelRequested','universal-2'),
    now(), now()
  );

  begin
    delete from public.recordings where id = gate_recording_id;
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_RECORDING_DELETE_GATE_CHECK_FAILED';
  exception when others then
    get stacked diagnostics gate_error = message_text;
    if gate_error <> 'TRANSCRIPTION_PROVIDER_SUBMISSION_IN_PROGRESS' then
      raise;
    end if;
  end;

  begin
    delete from public.sessions where id = gate_session_id;
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_SESSION_DELETE_GATE_CHECK_FAILED';
  exception when others then
    get stacked diagnostics gate_error = message_text;
    if gate_error <> 'TRANSCRIPTION_PROVIDER_SUBMISSION_IN_PROGRESS' then
      raise;
    end if;
  end;

  update public.transcription_runs
  set status = 'failed',
      provider_job_id = gen_random_uuid()::text,
      completed_at = now(),
      provider_cleanup_status = 'pending',
      provider_cleanup_next_attempt_at = now(),
      provider_processing_deadline_at = null
  where id = gate_run_id;
  update public.processing_jobs set status = 'failed' where id = gate_job_id;

  begin
    delete from public.recordings where id = gate_recording_id;
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_RECORDING_DELETE_GATE_CHECK_FAILED';
  exception when others then
    get stacked diagnostics gate_error = message_text;
    if gate_error <> 'TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED' then
      raise;
    end if;
  end;

  begin
    delete from public.sessions where id = gate_session_id;
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_SESSION_DELETE_GATE_CHECK_FAILED';
  exception when others then
    get stacked diagnostics gate_error = message_text;
    if gate_error <> 'TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED' then
      raise;
    end if;
  end;
  raise notice 'TRANSCRIPTION_RECORDING_DELETE_GATE_CHECK=PASS';
  raise notice 'TRANSCRIPTION_SESSION_DELETE_GATE_CHECK=PASS';

  foreach metadata_case in array array[
    jsonb_build_object('audio_url','https://secret.example'),
    jsonb_build_object('nested',jsonb_build_object('authorization','Bearer hidden')),
    jsonb_build_object('apiKey','hidden-provider-key'),
    jsonb_build_object('safe','sb_' || 'secret_hidden_value_1234567890'),
    jsonb_build_object('safe','eyJabcdefghijk.abcdefghijk.abcdefghijk'),
    jsonb_build_object(
      'a', jsonb_build_object(
        'b', jsonb_build_object(
          'c', jsonb_build_object(
            'd', jsonb_build_object(
              'e', jsonb_build_object('f','too-deep')
            )
          )
        )
      )
    )
  ]::jsonb[] loop
    metadata_case_rejected := false;
    begin
      update public.transcription_runs
      set provider_metadata = metadata_case
      where id = complete_claim.run_id;
    exception when check_violation then
      metadata_case_rejected := true;
    end;
    if not metadata_case_rejected then
      raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_METADATA_SECRET_REJECTION_CHECK_FAILED';
    end if;
    metadata_rejection_count := metadata_rejection_count + 1;
  end loop;
  metadata_rejected := metadata_rejection_count = 6;
  if not metadata_rejected then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_METADATA_SECRET_REJECTION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_METADATA_SECRET_REJECTION_CHECK=PASS';

  update public.feature_flags
  set enabled = false, updated_at = now()
  where flag_key = 'transcription_enabled';

  if coalesce((
    select enabled from public.feature_flags where flag_key = 'transcription_enabled'
  ), true) is not false then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_FEATURE_FLAG_DISABLED_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_FEATURE_FLAG_DISABLED=PASS';
  raise notice 'PROJECT_RECALL_TRANSCRIPTION_REQUEST_WORKER_BEHAVIOR=PASS';
end;
$$;

rollback;
