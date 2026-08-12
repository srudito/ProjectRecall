-- ============================================================================
-- 0014_transcription_request_worker_v1.sql
-- Milestone 2B.1B: durable transcription request endpoint and polling worker.
--
-- This migration keeps transcription disabled. It adds atomic RPCs, explicit
-- submission ambiguity handling, bounded leases/recovery, provider-artifact
-- cleanup state, and deletion guards. It does not create secrets or Cron jobs.
-- ============================================================================

begin;

lock table
  public.processing_jobs,
  public.transcription_runs,
  public.transcript_versions,
  public.transcript_segments
in access exclusive mode;

-- The Milestone 2A feature remained disabled. Refuse to alter durable worker
-- semantics if any foundation data already exists so this append-only migration
-- can be reviewed before live work is ever admitted.
do $$
begin
  if exists (select 1 from public.processing_jobs)
     or exists (select 1 from public.transcription_runs)
     or exists (select 1 from public.transcript_versions)
     or exists (select 1 from public.transcript_segments) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKER_FOUNDATION_ALREADY_IN_USE';
  end if;
end;
$$;

-- --------------------------------------------------------------------------
-- Shared validation helpers
-- --------------------------------------------------------------------------

create or replace function public.is_canonical_transcription_storage_path(
  p_path text,
  p_workspace_id uuid,
  p_session_id uuid,
  p_recording_id uuid
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  expected_prefix text;
  suffix text;
  path_segment text;
begin
  if p_path is null
     or p_path = ''
     or length(p_path) > 2048
     or btrim(p_path) <> p_path
     or position(E'\\' in p_path) > 0
     or p_path ~ '[[:cntrl:]]' then
    return false;
  end if;

  expected_prefix :=
    p_workspace_id::text || '/' ||
    p_session_id::text || '/' ||
    p_recording_id::text || '/';

  if left(p_path, length(expected_prefix)) <> expected_prefix then
    return false;
  end if;

  suffix := substr(p_path, length(expected_prefix) + 1);
  if suffix = '' or suffix like '/%' or suffix like '%/' then
    return false;
  end if;

  foreach path_segment in array string_to_array(suffix, '/') loop
    if path_segment is null
       or path_segment = ''
       or path_segment in ('.', '..')
       or btrim(path_segment) <> path_segment then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function public.transcription_request_payload_is_valid(
  p_payload jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  mode_value text;
  language_values text[];
  language_value text;
  normalized_value text;
  normalized_values text[] := array[]::text[];
  speaker_value jsonb;
begin
  if p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 4096
     or p_payload <> jsonb_strip_nulls(p_payload)
     or jsonb_typeof(p_payload->'contractVersion') <> 'number'
     or p_payload->'contractVersion' <> '1'::jsonb
     or jsonb_typeof(p_payload->'languageMode') <> 'string'
     or not (p_payload ? 'contractVersion')
     or not (p_payload ? 'languageMode')
     or not (p_payload ? 'requestedLanguages')
     or not (p_payload ? 'speakerDiarization')
     or (select count(*) from jsonb_object_keys(p_payload)) <> 4
     or p_payload->>'contractVersion' <> '1'
     or jsonb_typeof(p_payload->'requestedLanguages') <> 'array'
     or jsonb_typeof(p_payload->'speakerDiarization') <> 'boolean' then
    return false;
  end if;

  mode_value := p_payload->>'languageMode';
  if mode_value not in ('AUTO_DETECT', 'SINGLE_LANGUAGE', 'MULTILINGUAL') then
    return false;
  end if;

  speaker_value := p_payload->'speakerDiarization';
  if speaker_value not in ('true'::jsonb, 'false'::jsonb) then
    return false;
  end if;

  select coalesce(array_agg(value order by ordinal), array[]::text[])
    into language_values
  from jsonb_array_elements_text(p_payload->'requestedLanguages')
    with ordinality as language(value, ordinal);

  if cardinality(language_values) > 2 then
    return false;
  end if;

  foreach language_value in array language_values loop
    if language_value = ''
       or btrim(language_value) <> language_value
       or language_value ~ '[[:cntrl:]]' then
      return false;
    end if;

    normalized_value := lower(replace(language_value, '_', '-'));
    if normalized_value not in ('en', 'id') then
      return false;
    end if;

    if normalized_value = any(normalized_values) then
      if mode_value <> 'AUTO_DETECT' then
        return false;
      end if;
    else
      normalized_values := array_append(normalized_values, normalized_value);
    end if;
  end loop;

  normalized_values := (
    select coalesce(array_agg(value order by value), array[]::text[])
    from unnest(normalized_values) as value
  );

  -- Durable request intent is canonical. The request RPC may normalize session
  -- preferences, but direct server inserts must not leave ordering, casing, or
  -- duplicate semantics for the worker to reinterpret later.
  if language_values is distinct from normalized_values then
    return false;
  end if;

  if mode_value = 'AUTO_DETECT' then
    return cardinality(normalized_values) between 0 and 2;
  end if;

  if mode_value = 'SINGLE_LANGUAGE' then
    return cardinality(language_values) = 1
      and cardinality(normalized_values) = 1;
  end if;

  return cardinality(language_values) = 2
    and normalized_values = array['en', 'id']::text[];
exception
  when others then
    return false;
end;
$$;

create or replace function public.transcription_provider_metadata_is_safe(
  p_metadata jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  node_count integer;
  max_depth integer;
  unsafe_content boolean;
begin
  if p_metadata is null
     or jsonb_typeof(p_metadata) <> 'object'
     or octet_length(p_metadata::text) > 16384 then
    return false;
  end if;

  with recursive walk(value, key_name, depth) as (
    select p_metadata, null::text, 0
    union all
    select child.value, child.key_name, walk.depth + 1
    from walk
    cross join lateral (
      select object_value as value, object_key as key_name
      from jsonb_each(
        case when jsonb_typeof(walk.value) = 'object'
          then walk.value else '{}'::jsonb end
      ) as object_entry(object_key, object_value)
      union all
      select array_value as value, null::text as key_name
      from jsonb_array_elements(
        case when jsonb_typeof(walk.value) = 'array'
          then walk.value else '[]'::jsonb end
      ) as array_entry(array_value)
    ) child
  )
  select
    count(*)::int,
    coalesce(max(depth), 0)::int,
    coalesce(bool_or(
      (
        key_name is not null
        and lower(key_name) ~ '(url|authorization|api[_-]?key|secret|token|service[_-]?role|jwt|password|credential|signed[_-]?url)'
      )
      or
      (
        jsonb_typeof(value) = 'string'
        and (
          value #>> '{}' ~* 'https?://'
          or value #>> '{}' ~* '(^|[[:space:]])bearer[[:space:]]+'
          or value #>> '{}' ~ 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
          or value #>> '{}' ~* 'sb_(secret|publishable)_[A-Za-z0-9_-]+'
          or value #>> '{}' ~ '[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
        )
      )
    ), false)
    into node_count, max_depth, unsafe_content
  from walk;

  return node_count <= 128
    and max_depth <= 5
    and not unsafe_content;
exception
  when others then
    return false;
end;
$$;

create or replace function public.transcription_worker_id_is_valid(
  p_worker_id text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_worker_id is not null
    and length(p_worker_id) between 1 and 200
    and p_worker_id = btrim(p_worker_id)
    and p_worker_id !~ '[[:cntrl:]]';
$$;

create or replace function public.transcription_safe_error_code_is_valid(
  p_error_code text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_error_code is not null
    and p_error_code = btrim(p_error_code)
    and p_error_code ~ '^[A-Z0-9_]{1,120}$';
$$;

create or replace function public.transcription_safe_error_message_is_valid(
  p_safe_error text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_safe_error is not null
    and p_safe_error = btrim(p_safe_error)
    and length(p_safe_error) between 1 and 500
    and p_safe_error !~ '[[:cntrl:]]'
    and p_safe_error !~* 'https?://'
    and p_safe_error !~* '(^|[[:space:]])bearer[[:space:]]+'
    and p_safe_error !~* 'sb_(secret|publishable)_[A-Za-z0-9_-]+'
    and p_safe_error !~ 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
    and p_safe_error !~ '[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}';
$$;

create or replace function public.transcription_jsonb_number_between(
  p_value jsonb,
  p_min numeric,
  p_max numeric
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  numeric_value numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    return false;
  end if;
  numeric_value := (p_value #>> '{}')::numeric;
  return numeric_value >= p_min and numeric_value <= p_max;
exception
  when others then
    return false;
end;
$$;

create or replace function public.transcription_jsonb_integer_between(
  p_value jsonb,
  p_min numeric,
  p_max numeric
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  numeric_value numeric;
begin
  if not public.transcription_jsonb_number_between(p_value, p_min, p_max) then
    return false;
  end if;
  numeric_value := (p_value #>> '{}')::numeric;
  return trunc(numeric_value) = numeric_value;
exception
  when others then
    return false;
end;
$$;

create or replace function public.transcription_language_code_is_supported(
  p_language_code text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_language_code is not null
    and p_language_code = btrim(p_language_code)
    and p_language_code = lower(replace(p_language_code, '_', '-'))
    and p_language_code = any(array[
        'en',
        'en-au',
        'en-uk',
        'en-us',
        'es',
        'fr',
        'de',
        'it',
        'pt',
        'nl',
        'af',
        'sq',
        'am',
        'ar',
        'hy',
        'as',
        'az',
        'ba',
        'eu',
        'be',
        'bn',
        'bs',
        'br',
        'bg',
        'my',
        'ca',
        'zh',
        'hr',
        'cs',
        'da',
        'et',
        'fo',
        'fi',
        'gl',
        'ka',
        'el',
        'gu',
        'ht',
        'ha',
        'haw',
        'he',
        'hi',
        'hu',
        'is',
        'id',
        'ja',
        'jw',
        'kn',
        'kk',
        'km',
        'ko',
        'lo',
        'la',
        'lv',
        'ln',
        'lt',
        'lb',
        'mk',
        'mg',
        'ms',
        'ml',
        'mt',
        'mi',
        'mr',
        'mn',
        'ne',
        'no',
        'nn',
        'oc',
        'pa',
        'ps',
        'fa',
        'pl',
        'ro',
        'ru',
        'sa',
        'sr',
        'sn',
        'sd',
        'si',
        'sk',
        'sl',
        'so',
        'su',
        'sw',
        'sv',
        'tl',
        'tg',
        'ta',
        'tt',
        'te',
        'th',
        'bo',
        'tr',
        'tk',
        'uk',
        'ur',
        'uz',
        'vi',
        'cy',
        'yi',
        'yo'
      ]::text[]);
$$;

create or replace function public.transcription_language_summary_matches_request(
  p_request_payload jsonb,
  p_language_summary jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  mode_value text;
  requested_values text[];
  detected_values text[];
  normalized_detected_values text[];
  primary_value text;
  normalized_primary text;
  detection_enabled boolean;
  confidence_value numeric;
begin
  if not public.transcription_request_payload_is_valid(p_request_payload)
     or p_language_summary is null
     or jsonb_typeof(p_language_summary) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_language_summary) key)
       is distinct from array[
         'confidence','detectedLanguages','detectionEnabled','primaryLanguage'
       ]::text[]
     or jsonb_typeof(p_language_summary->'primaryLanguage') <> 'string'
     or jsonb_typeof(p_language_summary->'detectedLanguages') <> 'array'
     or jsonb_typeof(p_language_summary->'detectionEnabled') <> 'boolean'
     or jsonb_array_length(p_language_summary->'detectedLanguages') not between 1 and 2 then
    return false;
  end if;

  mode_value := p_request_payload->>'languageMode';
  select coalesce(array_agg(value order by ordinal), array[]::text[])
    into requested_values
  from jsonb_array_elements_text(p_request_payload->'requestedLanguages')
    with ordinality as language(value, ordinal);

  select coalesce(array_agg(value order by ordinal), array[]::text[])
    into detected_values
  from jsonb_array_elements_text(p_language_summary->'detectedLanguages')
    with ordinality as language(value, ordinal);

  if cardinality(detected_values) <> cardinality(array(
       select distinct value from unnest(detected_values) value
     ))
     or exists (
       select 1 from unnest(detected_values) value
       where not public.transcription_language_code_is_supported(value)
     ) then
    return false;
  end if;

  primary_value := p_language_summary->>'primaryLanguage';
  if not public.transcription_language_code_is_supported(primary_value)
     or not (primary_value = any(detected_values)) then
    return false;
  end if;

  if jsonb_typeof(p_language_summary->'confidence') = 'null' then
    confidence_value := null;
  elsif jsonb_typeof(p_language_summary->'confidence') = 'number' then
    confidence_value := (p_language_summary->>'confidence')::numeric;
    if confidence_value < 0 or confidence_value > 1 then
      return false;
    end if;
  else
    return false;
  end if;

  detection_enabled := (p_language_summary->>'detectionEnabled')::boolean;
  normalized_detected_values := array(
    select case when value in ('en','en-au','en-uk','en-us') then 'en' else value end
    from unnest(detected_values) value
  );
  normalized_primary := case
    when primary_value in ('en','en-au','en-uk','en-us') then 'en'
    else primary_value
  end;

  if mode_value = 'AUTO_DETECT' then
    return detection_enabled;
  end if;

  if detection_enabled then
    return false;
  end if;

  if mode_value = 'SINGLE_LANGUAGE' then
    return cardinality(requested_values) = 1
      and cardinality(normalized_detected_values) = 1
      and normalized_primary = requested_values[1]
      and normalized_detected_values[1] = requested_values[1];
  end if;

  return cardinality(normalized_detected_values) = 2
    and array(
      select distinct value
      from unnest(normalized_detected_values) value
      order by value
    ) = array['en','id']::text[]
    and normalized_primary = any(array['en','id']::text[]);
exception
  when others then
    return false;
end;
$$;

-- --------------------------------------------------------------------------
-- Durable state columns and constraints
-- --------------------------------------------------------------------------

alter table public.processing_jobs
  drop constraint if exists processing_jobs_lease_check;

alter table public.processing_jobs
  add constraint processing_jobs_lease_check
    check (
      (status = 'leased' and lease_owner is not null and lease_expires_at is not null)
      or
      (status <> 'leased' and lease_owner is null and lease_expires_at is null)
    );

alter table public.processing_jobs
  add constraint processing_jobs_request_payload_check
    check (public.transcription_request_payload_is_valid(request_payload));

create or replace function public.guard_processing_job_request_intent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.session_id is distinct from old.session_id
     or new.recording_id is distinct from old.recording_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_payload is distinct from old.request_payload then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_REQUEST_INTENT_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_processing_job_request_intent
  on public.processing_jobs;
create trigger guard_processing_job_request_intent
  before update on public.processing_jobs
  for each row execute function public.guard_processing_job_request_intent();

alter table public.transcription_runs
  add column if not exists provider_region text not null default 'EU',
  add column if not exists submission_started_at timestamptz,
  add column if not exists provider_processing_deadline_at timestamptz,
  add column if not exists provider_cleanup_status text not null default 'not_required',
  add column if not exists provider_cleanup_attempt_count integer not null default 0,
  add column if not exists provider_cleanup_max_attempts integer not null default 8,
  add column if not exists provider_cleanup_next_attempt_at timestamptz,
  add column if not exists provider_cleanup_lease_owner text,
  add column if not exists provider_cleanup_lease_expires_at timestamptz,
  add column if not exists provider_cleanup_completed_at timestamptz,
  add column if not exists provider_cleanup_last_error_code text,
  add column if not exists provider_cleanup_last_safe_error text;

alter table public.transcription_runs
  drop constraint if exists transcription_runs_status_check;

alter table public.transcription_runs
  add constraint transcription_runs_status_check
    check (status in ('queued','submitting','processing','succeeded','failed','cancelled')),
  add constraint transcription_runs_provider_region_check
    check (provider_region in ('EU','US')),
  add constraint transcription_runs_provider_job_id_check
    check (
      provider_job_id is null
      or provider_key <> 'assemblyai'
      or (
        provider_job_id = lower(provider_job_id)
        and provider_job_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    ),
  add constraint transcription_runs_provider_metadata_safe_check
    check (public.transcription_provider_metadata_is_safe(provider_metadata)),
  add constraint transcription_runs_execution_state_check
    check (
      (status = 'queued'
        and provider_job_id is null
        and submission_started_at is null
        and provider_processing_deadline_at is null
        and completed_at is null)
      or
      (status = 'submitting'
        and provider_job_id is null
        and submission_started_at is not null
        and provider_processing_deadline_at is null
        and completed_at is null)
      or
      (status = 'processing'
        and provider_job_id is not null
        and submission_started_at is not null
        and provider_processing_deadline_at is not null
        and completed_at is null)
      or
      (status = 'succeeded'
        and provider_job_id is not null
        and submission_started_at is not null
        and provider_processing_deadline_at is not null
        and completed_at is not null)
      or
      (status in ('failed','cancelled') and completed_at is not null)
    ),
  add constraint transcription_runs_cleanup_attempt_check
    check (
      provider_cleanup_attempt_count >= 0
      and provider_cleanup_max_attempts > 0
      and provider_cleanup_attempt_count <= provider_cleanup_max_attempts
    ),
  add constraint transcription_runs_cleanup_status_check
    check (
      provider_cleanup_status in (
        'not_required','pending','leased','succeeded','manual_review'
      )
    ),
  add constraint transcription_runs_terminal_cleanup_check
    check (
      provider_job_id is null
      or status in ('submitting','processing')
      or provider_cleanup_status <> 'not_required'
    ),
  add constraint transcription_runs_cleanup_state_check
    check (
      (provider_cleanup_status = 'not_required'
        and provider_cleanup_next_attempt_at is null
        and provider_cleanup_lease_owner is null
        and provider_cleanup_lease_expires_at is null
        and provider_cleanup_completed_at is null
        and (provider_job_id is null or status = 'processing'))
      or
      (provider_cleanup_status = 'pending'
        and provider_job_id is not null
        and provider_cleanup_next_attempt_at is not null
        and provider_cleanup_lease_owner is null
        and provider_cleanup_lease_expires_at is null
        and provider_cleanup_completed_at is null)
      or
      (provider_cleanup_status = 'leased'
        and provider_job_id is not null
        and provider_cleanup_next_attempt_at is null
        and provider_cleanup_lease_owner is not null
        and provider_cleanup_lease_expires_at is not null
        and provider_cleanup_completed_at is null)
      or
      (provider_cleanup_status = 'succeeded'
        and provider_cleanup_next_attempt_at is null
        and provider_cleanup_lease_owner is null
        and provider_cleanup_lease_expires_at is null
        and provider_cleanup_completed_at is not null)
      or
      (provider_cleanup_status = 'manual_review'
        and provider_cleanup_next_attempt_at is null
        and provider_cleanup_lease_owner is null
        and provider_cleanup_lease_expires_at is null
        and provider_cleanup_completed_at is null)
    );

create unique index if not exists idx_processing_jobs_one_active_recording
  on public.processing_jobs(recording_id)
  where status in ('queued','leased','processing');

create unique index if not exists idx_transcription_runs_one_active
  on public.transcription_runs(processing_job_id)
  where status in ('queued','submitting','processing');

create index if not exists idx_transcription_runs_cleanup_claim
  on public.transcription_runs(
    provider_cleanup_status,
    provider_cleanup_next_attempt_at,
    updated_at
  );

create index if not exists idx_transcription_runs_processing_deadline
  on public.transcription_runs(provider_processing_deadline_at)
  where status = 'processing';

create index if not exists idx_transcription_runs_recording_cleanup
  on public.transcription_runs(recording_id, provider_cleanup_status, updated_at);


-- --------------------------------------------------------------------------
-- Session deletion safety
-- --------------------------------------------------------------------------

create or replace function public.guard_session_delete_transcription_provider_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.transcription_runs run
    where run.session_id = old.id
      and run.status in ('submitting','processing')
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_PROVIDER_SUBMISSION_IN_PROGRESS';
  end if;

  if exists (
    select 1
    from public.transcription_runs run
    where run.session_id = old.id
      and (
        run.provider_cleanup_status in ('pending','leased','manual_review')
        or (
          run.provider_job_id is not null
          and run.provider_cleanup_status <> 'succeeded'
        )
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED';
  end if;

  return old;
end;
$$;

revoke all on function public.guard_session_delete_transcription_provider_state()
  from public, anon, authenticated;
grant execute on function public.guard_session_delete_transcription_provider_state()
  to service_role;

drop trigger if exists guard_session_delete_transcription_provider_state
  on public.sessions;
create trigger guard_session_delete_transcription_provider_state
  before delete on public.sessions
  for each row execute function public.guard_session_delete_transcription_provider_state();

-- Guard the durable provider graph at its immediate parent. This protects
-- direct recording deletes and every session/workspace cascade regardless of
-- foreign-key trigger ordering. Provider-free jobs remain deletable.
create or replace function public.guard_processing_job_delete_transcription_provider_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.transcription_runs run
    where run.processing_job_id = old.id
      and run.status in ('submitting','processing')
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_PROVIDER_SUBMISSION_IN_PROGRESS';
  end if;

  if exists (
    select 1
    from public.transcription_runs run
    where run.processing_job_id = old.id
      and (
        run.provider_cleanup_status in ('pending','leased','manual_review')
        or (
          run.provider_job_id is not null
          and run.provider_cleanup_status <> 'succeeded'
        )
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED';
  end if;

  return old;
end;
$$;

revoke all on function public.guard_processing_job_delete_transcription_provider_state()
  from public, anon, authenticated;
grant execute on function public.guard_processing_job_delete_transcription_provider_state()
  to service_role;

drop trigger if exists guard_processing_job_delete_transcription_provider_state
  on public.processing_jobs;
create trigger guard_processing_job_delete_transcription_provider_state
  before delete on public.processing_jobs
  for each row execute function public.guard_processing_job_delete_transcription_provider_state();

-- --------------------------------------------------------------------------
-- User request RPC
-- --------------------------------------------------------------------------

create or replace function public.request_transcription_job(
  p_recording_id uuid
)
returns table (
  job_id uuid,
  job_status text,
  workspace_id uuid,
  session_id uuid,
  recording_id uuid,
  created boolean
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
#variable_conflict use_column
declare
  actor_id uuid := auth.uid();
  recording_record record;
  raw_languages text[];
  normalized_languages text[] := array[]::text[];
  raw_language text;
  normalized_language text;
  request_payload_value jsonb;
  idempotency_value text;
  active_job_record record;
  inserted_id uuid;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if p_recording_id is null then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_REQUEST_INVALID';
  end if;

  if coalesce((
    select flag.enabled
    from public.feature_flags flag
    where flag.flag_key = 'transcription_enabled'
  ), false) is not true then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_FEATURE_DISABLED';
  end if;

  select
    recording.id,
    recording.workspace_id,
    recording.session_id,
    recording.private_storage_path,
    recording.upload_status,
    recording.mime_type,
    recording.duration_ms,
    session_record.spoken_language_mode,
    session_record.expected_spoken_languages,
    session_record.status as session_status,
    session_record.deleted_at
  into recording_record
  from public.recordings recording
  join public.sessions session_record
    on session_record.id = recording.session_id
   and session_record.workspace_id = recording.workspace_id
  join public.workspace_members member
    on member.workspace_id = recording.workspace_id
   and member.user_id = actor_id
   and member.membership_status = 'active'
  where recording.id = p_recording_id
  for update of recording, session_record, member;

  if not found then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_RECORDING_NOT_FOUND';
  end if;

  if recording_record.deleted_at is not null
     or recording_record.session_status in ('deleting','deleted') then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_SESSION_UNAVAILABLE';
  end if;

  if recording_record.upload_status <> 'synchronized'
     or recording_record.duration_ms is null
     or recording_record.duration_ms <= 0
     or recording_record.duration_ms > 9007199254740991
     or recording_record.mime_type is null
     or recording_record.mime_type !~ '^(audio|video)/[A-Za-z0-9.+-]+$'
     or recording_record.private_storage_path is null
     or not public.is_canonical_transcription_storage_path(
       recording_record.private_storage_path,
       recording_record.workspace_id,
       recording_record.session_id,
       recording_record.id
     ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED';
  end if;

  raw_languages := coalesce(recording_record.expected_spoken_languages, array[]::text[]);
  foreach raw_language in array raw_languages loop
    if raw_language is null
       or raw_language = ''
       or btrim(raw_language) <> raw_language
       or raw_language ~ '[[:cntrl:]]' then
      raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LANGUAGE_UNSUPPORTED';
    end if;

    normalized_language := lower(replace(raw_language, '_', '-'));
    if normalized_language in ('en','en-au','en-gb','en-uk','en-us') then
      normalized_language := 'en';
    elsif normalized_language = 'id' then
      normalized_language := 'id';
    else
      raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LANGUAGE_UNSUPPORTED';
    end if;

    if normalized_language = any(normalized_languages) then
      if recording_record.spoken_language_mode <> 'AUTO_DETECT' then
        raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LANGUAGE_UNSUPPORTED';
      end if;
    else
      normalized_languages := array_append(normalized_languages, normalized_language);
    end if;
  end loop;

  normalized_languages := (
    select coalesce(array_agg(value order by value), array[]::text[])
    from unnest(normalized_languages) value
  );

  if recording_record.spoken_language_mode = 'AUTO_DETECT' then
    if cardinality(normalized_languages) > 2 then
      raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LANGUAGE_UNSUPPORTED';
    end if;
  elsif recording_record.spoken_language_mode = 'SINGLE_LANGUAGE' then
    if cardinality(raw_languages) <> 1 or cardinality(normalized_languages) <> 1 then
      raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LANGUAGE_UNSUPPORTED';
    end if;
  elsif recording_record.spoken_language_mode = 'MULTILINGUAL' then
    if cardinality(raw_languages) <> 2
       or normalized_languages <> array['en','id']::text[] then
      raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LANGUAGE_UNSUPPORTED';
    end if;
  else
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LANGUAGE_UNSUPPORTED';
  end if;

  request_payload_value := jsonb_build_object(
    'contractVersion', 1,
    'languageMode', recording_record.spoken_language_mode,
    'requestedLanguages', to_jsonb(normalized_languages),
    'speakerDiarization', false
  );

  if not public.transcription_request_payload_is_valid(request_payload_value) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_REQUEST_INVALID';
  end if;

  idempotency_value := encode(
    digest(
      concat_ws(
        '|',
        'batch_transcription_v1',
        recording_record.workspace_id::text,
        recording_record.session_id::text,
        recording_record.id::text,
        request_payload_value::text
      ),
      'sha256'
    ),
    'hex'
  );

  -- Serialize requests for the same recording through the recording row lock
  -- and reuse any active job regardless of a later preference change. This
  -- prevents two paid provider jobs from running concurrently for one evidence
  -- recording while preserving workspace-scoped idempotency for terminal rows.
  select job.* into active_job_record
  from public.processing_jobs job
  where job.recording_id = recording_record.id
    and job.workspace_id = recording_record.workspace_id
    and job.session_id = recording_record.session_id
    and (
      job.status in ('queued','leased','processing')
      or exists (
        select 1
        from public.transcription_runs prior_run
        where prior_run.processing_job_id = job.id
          and (
            prior_run.provider_cleanup_status in ('pending','leased','manual_review')
            or (
              prior_run.provider_job_id is not null
              and prior_run.provider_cleanup_status <> 'succeeded'
            )
          )
      )
    )
  order by
    case when job.status in ('queued','leased','processing') then 0 else 1 end,
    job.updated_at desc,
    job.id
  limit 1;

  if found then
    return query
    select active_job_record.id, active_job_record.status,
      active_job_record.workspace_id, active_job_record.session_id,
      active_job_record.recording_id, false;
    return;
  end if;

  insert into public.processing_jobs (
    workspace_id,
    session_id,
    recording_id,
    created_by,
    idempotency_key,
    status,
    next_attempt_at,
    request_payload
  ) values (
    recording_record.workspace_id,
    recording_record.session_id,
    recording_record.id,
    actor_id,
    idempotency_value,
    'queued',
    now(),
    request_payload_value
  )
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    return query
    select inserted_id, 'queued'::text, recording_record.workspace_id,
      recording_record.session_id, recording_record.id, true;
    return;
  end if;

  return query
  select job.id, job.status, job.workspace_id, job.session_id,
    job.recording_id, false
  from public.processing_jobs job
  where job.workspace_id = recording_record.workspace_id
    and job.idempotency_key = idempotency_value;
end;
$$;

revoke all on function public.request_transcription_job(uuid)
  from public, anon, service_role;
grant execute on function public.request_transcription_job(uuid)
  to authenticated;

-- Remove provider-free terminal/request work when its creator loses
-- workspace access. Never remove a graph that may still have an in-flight
-- provider submission, unresolved provider artifact, or a transcript version
-- linked to the run. This avoids permanent creator-reference blockers without
-- discarding completed evidence provenance.
create or replace function public.remove_unsubmitted_transcription_requests_on_membership_loss()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lost_workspace_id uuid := old.workspace_id;
  lost_user_id uuid := old.user_id;
begin
  if tg_op = 'UPDATE' and new.membership_status = 'active' then
    return new;
  end if;

  delete from public.processing_jobs job
  where job.workspace_id = lost_workspace_id
    and job.created_by = lost_user_id
    and not exists (
      select 1
      from public.transcription_runs run
      where run.processing_job_id = job.id
        and (
          (
            run.provider_job_id is not null
            and run.provider_cleanup_status <> 'succeeded'
          )
          or run.status in ('submitting','processing')
          or run.provider_cleanup_status in ('pending','leased','manual_review')
        )
    )
    and not exists (
      select 1
      from public.transcript_versions version
      join public.transcription_runs run
        on run.id = version.transcription_run_id
      where run.processing_job_id = job.id
    );

  return coalesce(new, old);
end;
$$;

revoke all on function public.remove_unsubmitted_transcription_requests_on_membership_loss()
  from public, anon, authenticated;
grant execute on function public.remove_unsubmitted_transcription_requests_on_membership_loss()
  to service_role;

drop trigger if exists remove_unsubmitted_transcription_requests_on_membership_loss
  on public.workspace_members;
create trigger remove_unsubmitted_transcription_requests_on_membership_loss
  after update of membership_status or delete on public.workspace_members
  for each row execute function public.remove_unsubmitted_transcription_requests_on_membership_loss();

-- After a provider artifact is confirmed absent/deleted, remove a now-safe
-- provider graph only when its creator no longer has active membership and no
-- transcript version depends on the run. Successful evidence remains intact.
create or replace function public.prune_transcription_job_after_membership_loss(
  p_job_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  job_record record;
begin
  if p_job_id is null then
    return false;
  end if;

  select job.* into job_record
  from public.processing_jobs job
  where job.id = p_job_id
  for update;

  if not found
     or job_record.status not in ('queued','failed','cancelled','succeeded') then
    return false;
  end if;

  if job_record.created_by is not null
     and exists (
       select 1
       from public.workspace_members member
       where member.workspace_id = job_record.workspace_id
         and member.user_id = job_record.created_by
         and member.membership_status = 'active'
     ) then
    return false;
  end if;

  if exists (
    select 1
    from public.transcription_runs run
    where run.processing_job_id = p_job_id
      and (
        run.status in ('submitting','processing')
        or run.provider_cleanup_status in ('pending','leased','manual_review')
        or (
          run.provider_job_id is not null
          and run.provider_cleanup_status <> 'succeeded'
        )
      )
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.transcript_versions version
    join public.transcription_runs run
      on run.id = version.transcription_run_id
    where run.processing_job_id = p_job_id
  ) then
    return false;
  end if;

  delete from public.processing_jobs
  where id = p_job_id;

  return found;
end;
$$;

revoke all on function public.prune_transcription_job_after_membership_loss(uuid)
  from public, anon, authenticated;
grant execute on function public.prune_transcription_job_after_membership_loss(uuid)
  to service_role;

-- --------------------------------------------------------------------------
-- Worker recovery and claim RPCs
-- --------------------------------------------------------------------------

create or replace function public.recover_expired_transcription_work(
  p_limit integer default 20
)
returns table (
  requeued_jobs integer,
  ambiguous_jobs integer,
  repoll_jobs integer,
  deadline_failed_jobs integer,
  cleanup_requeued_runs integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  work_record record;
  requeued_count integer := 0;
  ambiguous_count integer := 0;
  repoll_count integer := 0;
  deadline_count integer := 0;
  cleanup_count integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_RECOVERY_LIMIT_INVALID';
  end if;

  for work_record in
    select job.id as job_id, run.id as run_id, run.status as run_status
    from public.processing_jobs job
    left join lateral (
      select candidate.id, candidate.status
      from public.transcription_runs candidate
      where candidate.processing_job_id = job.id
        and candidate.status in ('queued','submitting','processing')
      order by candidate.run_attempt desc
      limit 1
    ) run on true
    where job.status = 'leased'
      and job.lease_expires_at <= now()
    order by job.lease_expires_at, job.id
    for update of job skip locked
    limit p_limit
  loop
    if work_record.run_status = 'submitting' then
      update public.transcription_runs
      set status = 'failed',
          completed_at = now(),
          last_error_code = 'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
          last_safe_error = 'The provider submission outcome requires reconciliation.',
          provider_cleanup_status = 'manual_review',
          provider_cleanup_next_attempt_at = null,
          updated_at = now()
      where id = work_record.run_id;

      update public.processing_jobs
      set status = 'failed',
          lease_owner = null,
          lease_expires_at = null,
          completed_at = now(),
          last_error_code = 'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
          last_safe_error = 'The provider submission outcome requires reconciliation.',
          updated_at = now()
      where id = work_record.job_id;
      ambiguous_count := ambiguous_count + 1;
    elsif work_record.run_status = 'processing' then
      update public.processing_jobs
      set status = 'processing',
          lease_owner = null,
          lease_expires_at = null,
          next_attempt_at = now(),
          updated_at = now()
      where id = work_record.job_id;
      repoll_count := repoll_count + 1;
    else
      update public.processing_jobs
      set status = 'queued',
          lease_owner = null,
          lease_expires_at = null,
          next_attempt_at = now(),
          updated_at = now()
      where id = work_record.job_id;
      requeued_count := requeued_count + 1;
    end if;
  end loop;

  for work_record in
    select run.id as run_id, run.processing_job_id as job_id
    from public.transcription_runs run
    join public.processing_jobs job on job.id = run.processing_job_id
    where run.status = 'processing'
      and run.provider_processing_deadline_at <= now()
      and job.status = 'processing'
    order by run.provider_processing_deadline_at, run.id
    for update of run, job skip locked
    limit p_limit
  loop
    update public.transcription_runs
    set status = 'failed',
        completed_at = now(),
        last_error_code = 'TRANSCRIPTION_PROVIDER_PROCESSING_TIMEOUT',
        last_safe_error = 'The transcription provider did not finish before the processing deadline.',
        provider_cleanup_status = case when provider_job_id is null
          then 'manual_review' else 'pending' end,
        provider_cleanup_next_attempt_at = case when provider_job_id is null
          then null else now() end,
        updated_at = now()
    where id = work_record.run_id;

    update public.processing_jobs
    set status = 'failed',
        completed_at = now(),
        next_attempt_at = null,
        last_error_code = 'TRANSCRIPTION_PROVIDER_PROCESSING_TIMEOUT',
        last_safe_error = 'The transcription provider did not finish before the processing deadline.',
        updated_at = now()
    where id = work_record.job_id;
    deadline_count := deadline_count + 1;
  end loop;

  with expired_cleanup as (
    select run.id
    from public.transcription_runs run
    where run.provider_cleanup_status = 'leased'
      and run.provider_cleanup_lease_expires_at <= now()
    order by run.provider_cleanup_lease_expires_at, run.id
    for update skip locked
    limit p_limit
  )
  update public.transcription_runs run
  set provider_cleanup_status = case
        when run.provider_cleanup_attempt_count < run.provider_cleanup_max_attempts
          then 'pending'
        else 'manual_review'
      end,
      provider_cleanup_lease_owner = null,
      provider_cleanup_lease_expires_at = null,
      provider_cleanup_next_attempt_at = case
        when run.provider_cleanup_attempt_count < run.provider_cleanup_max_attempts
          then now()
        else null
      end,
      provider_cleanup_last_error_code = case
        when run.provider_cleanup_attempt_count < run.provider_cleanup_max_attempts
          then run.provider_cleanup_last_error_code
        else coalesce(
          run.provider_cleanup_last_error_code,
          'TRANSCRIPTION_PROVIDER_CLEANUP_LEASE_EXHAUSTED'
        )
      end,
      provider_cleanup_last_safe_error = case
        when run.provider_cleanup_attempt_count < run.provider_cleanup_max_attempts
          then run.provider_cleanup_last_safe_error
        else coalesce(
          run.provider_cleanup_last_safe_error,
          'Provider cleanup requires manual review.'
        )
      end,
      updated_at = now()
  from expired_cleanup
  where run.id = expired_cleanup.id;
  get diagnostics cleanup_count = row_count;

  return query select requeued_count, ambiguous_count, repoll_count,
    deadline_count, cleanup_count;
end;
$$;

create or replace function public.claim_transcription_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 45
)
returns table (
  job_id uuid,
  run_id uuid,
  action text,
  workspace_id uuid,
  session_id uuid,
  recording_id uuid,
  private_storage_path text,
  mime_type text,
  duration_ms bigint,
  request_payload jsonb,
  provider_key text,
  provider_model text,
  provider_region text,
  provider_job_id text,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_job record;
  selected_run record;
  feature_enabled boolean;
begin
  if not public.transcription_worker_id_is_valid(p_worker_id)
     or p_limit is null or p_limit < 1 or p_limit > 10
     or p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_CLAIM_INPUT_INVALID';
  end if;

  feature_enabled := coalesce((
    select flag.enabled
    from public.feature_flags flag
    where flag.flag_key = 'transcription_enabled'
  ), false);

  for selected_job in
    select job.*
    from public.processing_jobs job
    where coalesce(job.next_attempt_at, now()) <= now()
      and exists (
        select 1
        from public.sessions session_record
        join public.recordings recording
          on recording.id = job.recording_id
         and recording.session_id = job.session_id
         and recording.workspace_id = job.workspace_id
        where session_record.id = job.session_id
          and session_record.workspace_id = job.workspace_id
          and session_record.deleted_at is null
          and session_record.status not in ('deleting','deleted')
          and recording.upload_status = 'synchronized'
          and recording.duration_ms > 0
          and recording.duration_ms <= 9007199254740991
          and recording.mime_type ~ '^(audio|video)/[A-Za-z0-9.+-]+$'
          and recording.private_storage_path is not null
          and public.is_canonical_transcription_storage_path(
            recording.private_storage_path,
            job.workspace_id,
            job.session_id,
            job.recording_id
          )
      )
      and (
        (
          job.status = 'queued'
          and feature_enabled
          and job.attempt_count < job.max_attempts
          and job.created_by is not null
          and exists (
            select 1
            from public.workspace_members member
            where member.workspace_id = job.workspace_id
              and member.user_id = job.created_by
              and member.membership_status = 'active'
          )
          and not exists (
            select 1
            from public.transcription_runs prior_run
            where prior_run.recording_id = job.recording_id
              and (
                prior_run.provider_cleanup_status in ('pending','leased','manual_review')
                or (
                  prior_run.provider_job_id is not null
                  and prior_run.provider_cleanup_status <> 'succeeded'
                )
              )
          )
        )
        or
        (job.status = 'processing' and exists (
          select 1
          from public.transcription_runs active_run
          where active_run.processing_job_id = job.id
            and active_run.status = 'processing'
            and active_run.provider_job_id is not null
            and active_run.provider_processing_deadline_at > now()
        ))
      )
    order by job.priority, coalesce(job.next_attempt_at, job.created_at), job.id
    for update skip locked
    limit p_limit
  loop
    update public.processing_jobs
    set status = 'leased',
        lease_owner = p_worker_id,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        started_at = coalesce(started_at, now()),
        updated_at = now()
    where id = selected_job.id;

    if selected_job.status = 'queued' then
      select run.* into selected_run
      from public.transcription_runs run
      where run.processing_job_id = selected_job.id
        and run.status = 'queued'
      order by run.run_attempt desc
      limit 1
      for update;

      if not found then
        insert into public.transcription_runs (
          processing_job_id,
          workspace_id,
          session_id,
          recording_id,
          created_by,
          run_attempt,
          provider_key,
          provider_model,
          provider_region,
          request_mode,
          requested_languages,
          status,
          provider_metadata
        ) values (
          selected_job.id,
          selected_job.workspace_id,
          selected_job.session_id,
          selected_job.recording_id,
          selected_job.created_by,
          coalesce((
            select max(existing_run.run_attempt) + 1
            from public.transcription_runs existing_run
            where existing_run.processing_job_id = selected_job.id
          ), 1),
          'assemblyai',
          'universal-2',
          'EU',
          selected_job.request_payload->>'languageMode',
          array(
            select jsonb_array_elements_text(
              selected_job.request_payload->'requestedLanguages'
            )
          ),
          'queued',
          jsonb_build_object('region', 'EU', 'speechModelRequested', 'universal-2')
        ) returning * into selected_run;
      end if;

      return query
      select selected_job.id, selected_run.id, 'submit'::text,
        selected_job.workspace_id, selected_job.session_id,
        selected_job.recording_id, recording.private_storage_path,
        recording.mime_type, recording.duration_ms,
        selected_job.request_payload, selected_run.provider_key,
        selected_run.provider_model, selected_run.provider_region,
        selected_run.provider_job_id,
        now() + make_interval(secs => p_lease_seconds)
      from public.recordings recording
      where recording.id = selected_job.recording_id;
    else
      select run.* into selected_run
      from public.transcription_runs run
      where run.processing_job_id = selected_job.id
        and run.status = 'processing'
      order by run.run_attempt desc
      limit 1
      for update;

      if not found or selected_run.provider_job_id is null then
        raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_CLAIM_STATE_INVALID';
      end if;

      return query
      select selected_job.id, selected_run.id, 'poll'::text,
        selected_job.workspace_id, selected_job.session_id,
        selected_job.recording_id, recording.private_storage_path,
        recording.mime_type, recording.duration_ms,
        selected_job.request_payload, selected_run.provider_key,
        selected_run.provider_model, selected_run.provider_region,
        selected_run.provider_job_id,
        now() + make_interval(secs => p_lease_seconds)
      from public.recordings recording
      where recording.id = selected_job.recording_id;
    end if;
  end loop;
end;
$$;

create or replace function public.begin_transcription_submission(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  job_record record;
  run_record record;
begin
  if p_job_id is null
     or p_run_id is null
     or not public.transcription_worker_id_is_valid(p_worker_id) then
    raise exception using
      errcode = '22023',
      message = 'TRANSCRIPTION_SUBMISSION_INPUT_INVALID';
  end if;

  select job.*, run.id as run_id, run.status as run_status
    into job_record
  from public.processing_jobs job
  join public.transcription_runs run
    on run.processing_job_id = job.id
  where job.id = p_job_id
    and run.id = p_run_id
    and job.status = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_expires_at > now()
  for update of job, run;

  if not found or job_record.run_status <> 'queued' then
    return false;
  end if;

  -- Re-check active membership at the last durable boundary before a
  -- provider POST. If membership was revoked after claim but before the
  -- submitting boundary, the provider-free graph is safe to discard.
  perform 1
  from public.workspace_members member
  where member.workspace_id = job_record.workspace_id
    and member.user_id = job_record.created_by
    and member.membership_status = 'active'
  for share;

  if not found then
    delete from public.processing_jobs where id = p_job_id;
    return false;
  end if;

  -- Re-check the kill switch at the last durable boundary before a provider
  -- POST. A flag change after claim may spend one signed URL, but must not
  -- create a new paid provider job.
  if coalesce((
    select flag.enabled
    from public.feature_flags flag
    where flag.flag_key = 'transcription_enabled'
  ), false) is not true then
    update public.processing_jobs
    set status = 'queued',
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = now(),
        updated_at = now()
    where id = p_job_id;
    return false;
  end if;

  if job_record.attempt_count >= job_record.max_attempts then
    update public.transcription_runs
    set status = 'failed',
        completed_at = now(),
        last_error_code = 'TRANSCRIPTION_SUBMISSION_ATTEMPTS_EXHAUSTED',
        last_safe_error = 'The transcription submission retry limit was reached.',
        updated_at = now()
    where id = p_run_id;

    update public.processing_jobs
    set status = 'failed',
        lease_owner = null,
        lease_expires_at = null,
        completed_at = now(),
        next_attempt_at = null,
        last_error_code = 'TRANSCRIPTION_SUBMISSION_ATTEMPTS_EXHAUSTED',
        last_safe_error = 'The transcription submission retry limit was reached.',
        updated_at = now()
    where id = p_job_id;
    return false;
  end if;

  update public.processing_jobs
  set attempt_count = attempt_count + 1,
      updated_at = now()
  where id = p_job_id;

  update public.transcription_runs
  set status = 'submitting',
      submission_started_at = now(),
      started_at = coalesce(started_at, now()),
      last_error_code = null,
      last_safe_error = null,
      updated_at = now()
  where id = p_run_id;

  return true;
end;
$$;

create or replace function public.mark_transcription_job_submitted(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_provider_job_id text,
  p_provider_metadata jsonb,
  p_poll_after_seconds integer default 15,
  p_processing_timeout_seconds integer default 3600
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_provider_job_id text := lower(p_provider_job_id);
begin
  if p_job_id is null
     or p_run_id is null
     or not public.transcription_worker_id_is_valid(p_worker_id)
     or p_provider_job_id is null
     or normalized_provider_job_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or not public.transcription_provider_metadata_is_safe(p_provider_metadata)
     or (select array_agg(key order by key) from jsonb_object_keys(p_provider_metadata) key)
       is distinct from array['region','speechModelRequested','status']::text[]
     or p_provider_metadata->>'status' not in ('queued','processing','completed')
     or p_provider_metadata->>'speechModelRequested' <> 'universal-2'
     or p_provider_metadata->>'region' not in ('EU','US')
     or p_poll_after_seconds is null or p_poll_after_seconds < 1 or p_poll_after_seconds > 3600
     or p_processing_timeout_seconds is null
     or p_processing_timeout_seconds < 300
     or p_processing_timeout_seconds > 86400 then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_SUBMISSION_INPUT_INVALID';
  end if;

  if exists (
    select 1
    from public.transcription_runs run
    where run.id = p_run_id
      and run.processing_job_id = p_job_id
      and run.status = 'processing'
      and lower(run.provider_job_id) = normalized_provider_job_id
  ) then
    return true;
  end if;

  update public.transcription_runs run
  set status = 'processing',
      provider_job_id = normalized_provider_job_id,
      provider_metadata = p_provider_metadata,
      provider_processing_deadline_at = now() + make_interval(secs => p_processing_timeout_seconds),
      language_detection_status = case when run.request_mode = 'AUTO_DETECT'
        then 'DETECTING' else 'NOT_STARTED' end,
      last_error_code = null,
      last_safe_error = null,
      updated_at = now()
  from public.processing_jobs job
  where run.id = p_run_id
    and run.processing_job_id = p_job_id
    and run.status = 'submitting'
    and job.id = p_job_id
    and job.status = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_expires_at > now()
    and p_provider_metadata->>'region' = run.provider_region;

  if not found then
    return false;
  end if;

  update public.processing_jobs
  set status = 'processing',
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = now() + make_interval(secs => p_poll_after_seconds),
      last_error_code = null,
      last_safe_error = null,
      updated_at = now()
  where id = p_job_id;

  return true;
end;
$$;

create or replace function public.record_transcription_submission_failure(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_error_code text,
  p_safe_error text,
  p_retryable boolean,
  p_provider_job_id text default null,
  p_retry_after_seconds integer default 30
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_provider_job_id text := case when p_provider_job_id is null
    then null else lower(p_provider_job_id) end;
  current_state record;
begin
  if p_job_id is null
     or p_run_id is null
     or not public.transcription_worker_id_is_valid(p_worker_id)
     or p_retryable is null
     or not public.transcription_safe_error_code_is_valid(p_error_code)
     or not public.transcription_safe_error_message_is_valid(p_safe_error)
     or p_retry_after_seconds is null
     or p_retry_after_seconds < 1 or p_retry_after_seconds > 86400
     or (
       normalized_provider_job_id is not null
       and normalized_provider_job_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     )
     or (
       p_error_code = 'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'
       and normalized_provider_job_id is null
       and p_retryable
     ) then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_FAILURE_INPUT_INVALID';
  end if;

  select
    run.*,
    job.status as job_status,
    job.lease_owner as job_lease_owner,
    job.lease_expires_at as job_lease_expires_at,
    job.attempt_count as job_attempt_count,
    job.max_attempts as job_max_attempts,
    job.last_error_code as job_last_error_code
  into current_state
  from public.transcription_runs run
  join public.processing_jobs job on job.id = run.processing_job_id
  where run.id = p_run_id
    and run.processing_job_id = p_job_id
  for update of run, job;

  if not found then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LEASE_LOST';
  end if;

  if current_state.status = 'processing'
     and normalized_provider_job_id is not null
     and lower(current_state.provider_job_id) = normalized_provider_job_id then
    return 'already_submitted';
  end if;

  -- Once a provider ID is known, preserve it even if the short worker lease
  -- expired or bounded recovery already marked the ambiguous submission for
  -- manual review. This transition never performs a second provider POST.
  if normalized_provider_job_id is not null then
    if not (
      (
        current_state.status = 'submitting'
        and current_state.job_status = 'leased'
        and current_state.job_lease_owner = p_worker_id
      )
      or
      (
        current_state.status = 'failed'
        and current_state.last_error_code = 'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'
        and current_state.provider_cleanup_status = 'manual_review'
        and current_state.job_status = 'failed'
        and current_state.job_last_error_code = 'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'
      )
    ) then
      raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LEASE_LOST';
    end if;

    update public.transcription_runs
    set status = 'processing',
        provider_job_id = normalized_provider_job_id,
        submission_started_at = coalesce(submission_started_at, now()),
        provider_processing_deadline_at = coalesce(
          provider_processing_deadline_at,
          now() + interval '1 hour'
        ),
        completed_at = null,
        provider_cleanup_status = 'not_required',
        provider_cleanup_next_attempt_at = null,
        provider_cleanup_lease_owner = null,
        provider_cleanup_lease_expires_at = null,
        provider_cleanup_completed_at = null,
        last_error_code = left(p_error_code, 120),
        last_safe_error = left(p_safe_error, 500),
        updated_at = now()
    where id = p_run_id;

    update public.processing_jobs
    set status = 'processing',
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = now() + make_interval(secs => p_retry_after_seconds),
        completed_at = null,
        last_error_code = left(p_error_code, 120),
        last_safe_error = left(p_safe_error, 500),
        updated_at = now()
    where id = p_job_id;
    return 'reconcile_provider_job';
  end if;

  if current_state.job_status <> 'leased'
     or current_state.job_lease_owner <> p_worker_id
     or current_state.job_lease_expires_at <= now()
     or current_state.status not in ('queued','submitting') then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LEASE_LOST';
  end if;

  -- Failures before begin_submission (for example signed-URL creation) occur
  -- while the run is queued. Count them once here so repeated pre-provider
  -- failures remain bounded by processing_jobs.max_attempts.
  if current_state.status = 'queued'
     and current_state.job_attempt_count < current_state.job_max_attempts then
    update public.processing_jobs
    set attempt_count = attempt_count + 1,
        updated_at = now()
    where id = p_job_id;
    current_state.job_attempt_count := current_state.job_attempt_count + 1;
  end if;

  if p_retryable
     and current_state.job_attempt_count < current_state.job_max_attempts then
    update public.transcription_runs
    set status = 'queued',
        submission_started_at = null,
        last_error_code = left(p_error_code, 120),
        last_safe_error = left(p_safe_error, 500),
        updated_at = now()
    where id = p_run_id;

    update public.processing_jobs
    set status = 'queued',
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = now() + make_interval(secs => p_retry_after_seconds),
        last_error_code = left(p_error_code, 120),
        last_safe_error = left(p_safe_error, 500),
        updated_at = now()
    where id = p_job_id;

    -- Membership can be revoked after begin_transcription_submission commits
    -- but before the provider call returns. Once a provider-free failure has
    -- been persisted, remove the now-safe graph so it cannot become an
    -- unclaimable shared-workspace creator reference or permanent Delete
    -- Account blocker.
    if public.prune_transcription_job_after_membership_loss(p_job_id) then
      return 'failed';
    end if;

    return 'retry_submission';
  end if;

  update public.transcription_runs
  set status = 'failed',
      completed_at = now(),
      last_error_code = left(p_error_code, 120),
      last_safe_error = left(p_safe_error, 500),
      provider_cleanup_status = case
        when p_error_code = 'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'
          then 'manual_review'
        else 'not_required'
      end,
      provider_cleanup_next_attempt_at = null,
      updated_at = now()
  where id = p_run_id;

  update public.processing_jobs
  set status = 'failed',
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = null,
      completed_at = now(),
      last_error_code = left(p_error_code, 120),
      last_safe_error = left(p_safe_error, 500),
      updated_at = now()
  where id = p_job_id;

  perform public.prune_transcription_job_after_membership_loss(p_job_id);
  return 'failed';
end;
$$;

create or replace function public.record_transcription_poll_result(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_provider_metadata jsonb,
  p_poll_after_seconds integer default 15
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_job_id is null
     or p_run_id is null
     or not public.transcription_worker_id_is_valid(p_worker_id)
     or not public.transcription_provider_metadata_is_safe(p_provider_metadata)
     or (select array_agg(key order by key) from jsonb_object_keys(p_provider_metadata) key)
       is distinct from array['region','status']::text[]
     or p_provider_metadata->>'status' not in ('queued','processing')
     or p_provider_metadata->>'region' not in ('EU','US')
     or p_poll_after_seconds is null or p_poll_after_seconds < 1
     or p_poll_after_seconds > 3600 then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_POLL_INPUT_INVALID';
  end if;

  update public.transcription_runs run
  set provider_metadata = p_provider_metadata,
      updated_at = now()
  from public.processing_jobs job
  where run.id = p_run_id
    and run.processing_job_id = p_job_id
    and run.status = 'processing'
    and job.id = p_job_id
    and job.status = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_expires_at > now()
    and p_provider_metadata->>'region' = run.provider_region;

  if not found then return false; end if;

  update public.processing_jobs
  set status = 'processing',
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = now() + make_interval(secs => p_poll_after_seconds),
      last_error_code = null,
      last_safe_error = null,
      updated_at = now()
  where id = p_job_id;

  return true;
end;
$$;

create or replace function public.record_transcription_poll_failure(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_error_code text,
  p_safe_error text,
  p_retryable boolean,
  p_provider_terminal boolean,
  p_retry_after_seconds integer default 30
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  job_record record;
  run_record record;
begin
  if p_job_id is null
     or p_run_id is null
     or not public.transcription_worker_id_is_valid(p_worker_id)
     or p_retryable is null
     or p_provider_terminal is null
     or not public.transcription_safe_error_code_is_valid(p_error_code)
     or not public.transcription_safe_error_message_is_valid(p_safe_error)
     or p_retry_after_seconds is null
     or p_retry_after_seconds < 1 or p_retry_after_seconds > 86400 then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_FAILURE_INPUT_INVALID';
  end if;

  select job.*, run.id as run_id, run.provider_job_id
    into job_record
  from public.processing_jobs job
  join public.transcription_runs run on run.processing_job_id = job.id
  where job.id = p_job_id
    and run.id = p_run_id
    and job.status = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_expires_at > now()
    and run.status = 'processing'
  for update of job, run;

  if not found then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_LEASE_LOST';
  end if;

  if p_retryable and not p_provider_terminal then
    update public.transcription_runs
    set last_error_code = left(p_error_code, 120),
        last_safe_error = left(p_safe_error, 500),
        updated_at = now()
    where id = p_run_id;

    update public.processing_jobs
    set status = 'processing',
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = now() + make_interval(secs => p_retry_after_seconds),
        last_error_code = left(p_error_code, 120),
        last_safe_error = left(p_safe_error, 500),
        updated_at = now()
    where id = p_job_id;
    return 'retry_poll';
  end if;

  update public.transcription_runs
  set status = 'failed',
      completed_at = now(),
      last_error_code = left(p_error_code, 120),
      last_safe_error = left(p_safe_error, 500),
      provider_cleanup_status = case when provider_job_id is null
        then 'manual_review' else 'pending' end,
      provider_cleanup_next_attempt_at = case when provider_job_id is null
        then null else now() end,
      updated_at = now()
  where id = p_run_id;

  update public.processing_jobs
  set status = case
        when p_retryable and attempt_count < max_attempts then 'queued'
        else 'failed'
      end,
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = case
        when p_retryable and attempt_count < max_attempts
          then now() + make_interval(secs => p_retry_after_seconds)
        else null
      end,
      completed_at = case
        when p_retryable and attempt_count < max_attempts then null
        else now()
      end,
      last_error_code = left(p_error_code, 120),
      last_safe_error = left(p_safe_error, 500),
      updated_at = now()
  where id = p_job_id;

  return case when p_retryable and job_record.attempt_count < job_record.max_attempts
    then 'retry_new_run' else 'failed' end;
end;
$$;

create or replace function public.complete_transcription_job(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_provider_job_id text,
  p_plain_text text,
  p_language_summary jsonb,
  p_segments jsonb,
  p_provider_metadata jsonb,
  p_checksum_sha256 text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  job_record record;
  run_record record;
  next_version integer;
  version_id uuid := gen_random_uuid();
  segment_record record;
  expected_segment_index integer := 0;
  previous_start_ms numeric := -1;
  segment_count integer := 0;
  validation_message text;
  validation_state text;
begin
  if p_job_id is null
     or p_run_id is null
     or not public.transcription_worker_id_is_valid(p_worker_id)
     or p_provider_job_id is null
     or lower(p_provider_job_id) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_plain_text is null
     or btrim(p_plain_text) = ''
     or octet_length(p_plain_text) > 8 * 1024 * 1024
     or p_checksum_sha256 is null
     or p_checksum_sha256 !~ '^[0-9a-f]{64}$'
     or encode(digest(p_plain_text, 'sha256'), 'hex') <> p_checksum_sha256
     or p_segments is null
     or jsonb_typeof(p_segments) <> 'array'
     or jsonb_array_length(p_segments) < 1
     or jsonb_array_length(p_segments) > 200000
     or octet_length(p_segments::text) > 16 * 1024 * 1024
     or not public.transcription_provider_metadata_is_safe(p_provider_metadata) then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_RESULT_INVALID';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_segments) element
    where jsonb_typeof(element) <> 'object'
       or (select array_agg(key order by key) from jsonb_object_keys(element) key)
          is distinct from array[
            'confidence','endMs','languageCode','providerSegmentId',
            'segmentIndex','speakerLabel','startMs','text'
          ]::text[]
       or not public.transcription_jsonb_integer_between(
         element->'segmentIndex', 0, 199999
       )
       or not public.transcription_jsonb_integer_between(
         element->'startMs', 0, 9007199254740991
       )
       or not public.transcription_jsonb_integer_between(
         element->'endMs', 0, 9007199254740991
       )
       or jsonb_typeof(element->'text') <> 'string'
       or jsonb_typeof(element->'providerSegmentId') <> 'string'
       or jsonb_typeof(element->'confidence') not in ('number','null')
       or (
         jsonb_typeof(element->'confidence') = 'number'
         and not public.transcription_jsonb_number_between(
           element->'confidence', 0, 1
         )
       )
       or jsonb_typeof(element->'languageCode') not in ('string','null')
       or jsonb_typeof(element->'speakerLabel') not in ('string','null')
  ) then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_RESULT_INVALID';
  end if;

  select job.* into job_record
  from public.processing_jobs job
  where job.id = p_job_id
    and job.status = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_expires_at > now()
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_JOB_NOT_FOUND';
  end if;

  select run.* into run_record
  from public.transcription_runs run
  where run.id = p_run_id
    and run.processing_job_id = p_job_id
    and run.status = 'processing'
    and lower(run.provider_job_id) = lower(p_provider_job_id)
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_JOB_NOT_FOUND';
  end if;

  begin
    if run_record.provider_key <> 'assemblyai'
       or run_record.provider_model <> 'universal-2'
       or run_record.provider_region not in ('EU','US')
       or run_record.provider_processing_deadline_at is null
       or run_record.request_mode <> job_record.request_payload->>'languageMode'
       or to_jsonb(run_record.requested_languages)
          is distinct from job_record.request_payload->'requestedLanguages'
       or not public.transcription_request_payload_is_valid(job_record.request_payload)
       or not public.transcription_language_summary_matches_request(
         job_record.request_payload,
         p_language_summary
       )
       or (select array_agg(key order by key) from jsonb_object_keys(p_provider_metadata) key)
          is distinct from array[
            'audioDurationSeconds','languageConfidence','region','speakerLabels',
            'speechModelUsed','status','utteranceCount','wordCount'
          ]::text[]
       or p_provider_metadata->>'status' <> 'completed'
       or p_provider_metadata->>'speechModelUsed' <> 'universal-2'
       or p_provider_metadata->>'region' <> run_record.provider_region
       or jsonb_typeof(p_provider_metadata->'speakerLabels') <> 'boolean'
       or p_provider_metadata->'speakerLabels'
          is distinct from job_record.request_payload->'speakerDiarization'
       or not public.transcription_jsonb_integer_between(
         p_provider_metadata->'wordCount', 1, 200000
       )
       or (p_provider_metadata->>'wordCount')::numeric
          <> jsonb_array_length(p_segments)
       or not public.transcription_jsonb_integer_between(
         p_provider_metadata->'utteranceCount', 0, 200000
       )
       or (p_provider_metadata->>'utteranceCount')::numeric
          > (p_provider_metadata->>'wordCount')::numeric
       or jsonb_typeof(p_provider_metadata->'audioDurationSeconds') not in ('number','null')
       or (
         jsonb_typeof(p_provider_metadata->'audioDurationSeconds') = 'number'
         and not public.transcription_jsonb_number_between(
           p_provider_metadata->'audioDurationSeconds', 0, 9007199254740991
         )
       )
       or jsonb_typeof(p_provider_metadata->'languageConfidence') not in ('number','null')
       or p_provider_metadata->'languageConfidence'
          is distinct from p_language_summary->'confidence'
       or (
         jsonb_typeof(p_provider_metadata->'languageConfidence') = 'number'
         and not public.transcription_jsonb_number_between(
           p_provider_metadata->'languageConfidence', 0, 1
         )
       ) then
      raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_RESULT_INVALID';
    end if;

    for segment_record in
      select *
      from jsonb_to_recordset(p_segments) as segment(
        "segmentIndex" numeric,
        "startMs" numeric,
        "endMs" numeric,
        text text,
        confidence numeric,
        "languageCode" text,
        "speakerLabel" text,
        "providerSegmentId" text
      )
      order by "segmentIndex"
    loop
      if segment_record."segmentIndex" is null
         or trunc(segment_record."segmentIndex") <> segment_record."segmentIndex"
         or segment_record."segmentIndex" <> expected_segment_index
         or segment_record."startMs" is null
         or segment_record."endMs" is null
         or segment_record."startMs" < 0
         or segment_record."startMs" < previous_start_ms
         or segment_record."endMs" < segment_record."startMs"
         or segment_record."startMs" > 9007199254740991
         or segment_record."endMs" > 9007199254740991
         or trunc(segment_record."startMs") <> segment_record."startMs"
         or trunc(segment_record."endMs") <> segment_record."endMs"
         or segment_record.text is null
         or btrim(segment_record.text) = ''
         or octet_length(segment_record.text) > 10000
         or (segment_record.confidence is not null and (
           segment_record.confidence < 0 or segment_record.confidence > 1
         ))
         or (
           segment_record."languageCode" is not null
           and (
             not public.transcription_language_code_is_supported(
               segment_record."languageCode"
             )
             or not (
               p_language_summary->'detectedLanguages'
               @> jsonb_build_array(segment_record."languageCode")
             )
           )
         )
         or (
           (job_record.request_payload->>'speakerDiarization')::boolean is false
           and segment_record."speakerLabel" is not null
         )
         or (
           segment_record."speakerLabel" is not null
           and (
             btrim(segment_record."speakerLabel") = ''
             or length(segment_record."speakerLabel") > 200
             or segment_record."speakerLabel" ~ '[[:cntrl:]]'
           )
         )
         or segment_record."providerSegmentId" is null
         or segment_record."providerSegmentId" <>
            lower(p_provider_job_id) || ':word:' || segment_record."segmentIndex"::text
         or length(segment_record."providerSegmentId") > 500
         or segment_record."providerSegmentId" ~ '[[:cntrl:]]' then
        raise exception using errcode = '22023', message = 'TRANSCRIPTION_RESULT_INVALID';
      end if;
      expected_segment_index := expected_segment_index + 1;
      previous_start_ms := segment_record."startMs";
      segment_count := segment_count + 1;
    end loop;

    if segment_count <> jsonb_array_length(p_segments)
       or (
         select count(distinct element->>'providerSegmentId')
         from jsonb_array_elements(p_segments) element
       ) <> segment_count then
      raise exception using errcode = '22023', message = 'TRANSCRIPTION_RESULT_INVALID';
    end if;
  exception
    when others then
      get stacked diagnostics
        validation_message = message_text,
        validation_state = returned_sqlstate;
      if validation_state = 'P0001'
         and validation_message = 'TRANSCRIPTION_RESULT_INVALID' then
        raise;
      end if;
      raise exception using
        errcode = 'P0001',
        message = 'TRANSCRIPTION_RESULT_INVALID';
  end;

  perform 1
  from public.sessions session_record
  where session_record.id = job_record.session_id
    and session_record.workspace_id = job_record.workspace_id
    and session_record.deleted_at is null
    and session_record.status not in ('deleting','deleted')
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_SESSION_UNAVAILABLE';
  end if;

  select coalesce(max(version.version), 0) + 1
    into next_version
  from public.transcript_versions version
  where version.session_id = job_record.session_id;

  update public.transcript_versions
  set is_current = false,
      updated_at = now()
  where session_id = job_record.session_id
    and is_current;

  insert into public.transcript_versions (
    id, workspace_id, session_id, transcription_run_id, created_by,
    version, version_origin, version_status, plain_text,
    language_summary, content_checksum_sha256, is_current
  ) values (
    version_id, job_record.workspace_id, job_record.session_id,
    p_run_id, job_record.created_by, next_version,
    'provider', 'final', p_plain_text, p_language_summary,
    p_checksum_sha256, true
  );

  insert into public.transcript_segments (
    workspace_id, session_id, transcript_version_id, segment_index,
    start_ms, end_ms, text, confidence, language_code,
    speaker_label, provider_segment_id
  )
  select
    job_record.workspace_id,
    job_record.session_id,
    version_id,
    segment."segmentIndex"::integer,
    segment."startMs"::bigint,
    segment."endMs"::bigint,
    segment.text,
    segment.confidence,
    segment."languageCode",
    segment."speakerLabel",
    segment."providerSegmentId"
  from jsonb_to_recordset(p_segments) as segment(
    "segmentIndex" numeric,
    "startMs" numeric,
    "endMs" numeric,
    text text,
    confidence numeric,
    "languageCode" text,
    "speakerLabel" text,
    "providerSegmentId" text
  )
  order by segment."segmentIndex";

  update public.transcription_runs
  set status = 'succeeded',
      detected_languages = array(
        select jsonb_array_elements_text(p_language_summary->'detectedLanguages')
      ),
      primary_detected_language = p_language_summary->>'primaryLanguage',
      language_detection_status = case
        when run_record.request_mode = 'AUTO_DETECT' then 'DETECTED'
        else 'USER_CONFIRMED'
      end,
      provider_metadata = p_provider_metadata,
      completed_at = now(),
      provider_cleanup_status = 'pending',
      provider_cleanup_next_attempt_at = now(),
      last_error_code = null,
      last_safe_error = null,
      updated_at = now()
  where id = p_run_id;

  update public.processing_jobs
  set status = 'succeeded',
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = null,
      completed_at = now(),
      last_error_code = null,
      last_safe_error = null,
      updated_at = now()
  where id = p_job_id;

  return version_id;
end;
$$;

create or replace function public.claim_transcription_cleanup(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 45
)
returns table (
  run_id uuid,
  provider_key text,
  provider_region text,
  provider_job_id text,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_run record;
begin
  if not public.transcription_worker_id_is_valid(p_worker_id)
     or p_limit is null or p_limit < 1 or p_limit > 10
     or p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_CLEANUP_CLAIM_INPUT_INVALID';
  end if;

  for selected_run in
    select run.*
    from public.transcription_runs run
    where run.provider_cleanup_status = 'pending'
      and run.provider_job_id is not null
      and run.provider_cleanup_attempt_count < run.provider_cleanup_max_attempts
      and coalesce(run.provider_cleanup_next_attempt_at, now()) <= now()
    order by coalesce(run.provider_cleanup_next_attempt_at, run.updated_at), run.id
    for update skip locked
    limit p_limit
  loop
    update public.transcription_runs
    set provider_cleanup_status = 'leased',
        provider_cleanup_attempt_count = provider_cleanup_attempt_count + 1,
        provider_cleanup_lease_owner = p_worker_id,
        provider_cleanup_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        provider_cleanup_next_attempt_at = null,
        updated_at = now()
    where id = selected_run.id;

    return query
    select selected_run.id, selected_run.provider_key,
      selected_run.provider_region, selected_run.provider_job_id,
      now() + make_interval(secs => p_lease_seconds);
  end loop;
end;
$$;

create or replace function public.complete_transcription_cleanup(
  p_run_id uuid,
  p_worker_id text,
  p_provider_job_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  job_id_value uuid;
  cleanup_updated boolean := false;
begin
  if p_run_id is null
     or not public.transcription_worker_id_is_valid(p_worker_id)
     or p_provider_job_id is null
     or lower(p_provider_job_id) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_CLEANUP_INPUT_INVALID';
  end if;

  update public.transcription_runs
  set provider_cleanup_status = 'succeeded',
      provider_cleanup_next_attempt_at = null,
      provider_cleanup_lease_owner = null,
      provider_cleanup_lease_expires_at = null,
      provider_cleanup_completed_at = now(),
      provider_cleanup_last_error_code = null,
      provider_cleanup_last_safe_error = null,
      updated_at = now()
  where id = p_run_id
    and provider_cleanup_status = 'leased'
    and provider_cleanup_lease_owner = p_worker_id
    and provider_cleanup_lease_expires_at > now()
    and lower(provider_job_id) = lower(p_provider_job_id)
  returning processing_job_id into job_id_value;

  cleanup_updated := found;
  if cleanup_updated then
    perform public.prune_transcription_job_after_membership_loss(job_id_value);
  end if;

  return cleanup_updated;
end;
$$;

create or replace function public.fail_transcription_cleanup(
  p_run_id uuid,
  p_worker_id text,
  p_error_code text,
  p_safe_error text,
  p_retryable boolean,
  p_retry_after_seconds integer default 60
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run_record record;
begin
  if p_run_id is null
     or not public.transcription_worker_id_is_valid(p_worker_id)
     or p_retryable is null
     or not public.transcription_safe_error_code_is_valid(p_error_code)
     or not public.transcription_safe_error_message_is_valid(p_safe_error)
     or p_retry_after_seconds is null
     or p_retry_after_seconds < 1 or p_retry_after_seconds > 86400 then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_FAILURE_INPUT_INVALID';
  end if;

  select * into run_record
  from public.transcription_runs
  where id = p_run_id
    and provider_cleanup_status = 'leased'
    and provider_cleanup_lease_owner = p_worker_id
    and provider_cleanup_lease_expires_at > now()
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_CLEANUP_LEASE_LOST';
  end if;

  update public.transcription_runs
  set provider_cleanup_status = case
        when p_retryable
          and provider_cleanup_attempt_count < provider_cleanup_max_attempts
          then 'pending'
        else 'manual_review'
      end,
      provider_cleanup_lease_owner = null,
      provider_cleanup_lease_expires_at = null,
      provider_cleanup_next_attempt_at = case
        when p_retryable
          and provider_cleanup_attempt_count < provider_cleanup_max_attempts
          then now() + make_interval(secs => p_retry_after_seconds)
        else null
      end,
      provider_cleanup_last_error_code = left(p_error_code, 120),
      provider_cleanup_last_safe_error = left(p_safe_error, 500),
      updated_at = now()
  where id = p_run_id;

  return case
    when p_retryable
      and run_record.provider_cleanup_attempt_count < run_record.provider_cleanup_max_attempts
      then 'retry_cleanup'
    else 'manual_review'
  end;
end;
$$;

create or replace function public.confirm_transcription_provider_absence(
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run_record record;
  absence_confirmed boolean := false;
  creator_active boolean := false;
begin
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'TRANSCRIPTION_CLEANUP_INPUT_INVALID';
  end if;

  select run.*, job.status as job_status, job.created_by as job_created_by,
    job.attempt_count as job_attempt_count, job.max_attempts as job_max_attempts
  into run_record
  from public.transcription_runs run
  join public.processing_jobs job
    on job.id = run.processing_job_id
  where run.id = p_run_id
    and run.provider_cleanup_status = 'manual_review'
  for update of run, job;

  if not found then
    return false;
  end if;

  update public.transcription_runs
  set provider_cleanup_status = 'succeeded',
      provider_cleanup_lease_owner = null,
      provider_cleanup_lease_expires_at = null,
      provider_cleanup_next_attempt_at = null,
      provider_cleanup_completed_at = now(),
      provider_cleanup_last_error_code = null,
      provider_cleanup_last_safe_error = null,
      updated_at = now()
  where id = p_run_id;

  absence_confirmed := true;

  creator_active := run_record.job_created_by is not null
    and exists (
      select 1
      from public.workspace_members member
      where member.workspace_id = run_record.workspace_id
        and member.user_id = run_record.job_created_by
        and member.membership_status = 'active'
    );

  -- Only a no-ID ambiguous submission can be safely retried after an operator
  -- has explicitly confirmed that no provider artifact exists. Reuse the same
  -- immutable durable job so the workspace idempotency key remains stable.
  if run_record.provider_job_id is null
     and run_record.status = 'failed'
     and run_record.last_error_code = 'TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN'
     and run_record.job_status = 'failed'
     and creator_active
     and run_record.job_attempt_count < run_record.job_max_attempts then
    update public.processing_jobs
    set status = 'queued',
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = now(),
        completed_at = null,
        cancelled_at = null,
        last_error_code = null,
        last_safe_error = null,
        updated_at = now()
    where id = run_record.processing_job_id;
  else
    perform public.prune_transcription_job_after_membership_loss(
      run_record.processing_job_id
    );
  end if;

  return absence_confirmed;
end;
$$;

-- Worker RPCs are service-role only. User request is authenticated only.
do $$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'public.recover_expired_transcription_work(integer)',
    'public.claim_transcription_jobs(text,integer,integer)',
    'public.begin_transcription_submission(uuid,uuid,text)',
    'public.mark_transcription_job_submitted(uuid,uuid,text,text,jsonb,integer,integer)',
    'public.record_transcription_submission_failure(uuid,uuid,text,text,text,boolean,text,integer)',
    'public.record_transcription_poll_result(uuid,uuid,text,jsonb,integer)',
    'public.record_transcription_poll_failure(uuid,uuid,text,text,text,boolean,boolean,integer)',
    'public.complete_transcription_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text)',
    'public.claim_transcription_cleanup(text,integer,integer)',
    'public.complete_transcription_cleanup(uuid,text,text)',
    'public.fail_transcription_cleanup(uuid,text,text,text,boolean,integer)',
    'public.confirm_transcription_provider_absence(uuid)',
    'public.prune_transcription_job_after_membership_loss(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', function_signature);
    execute format('grant execute on function %s to service_role', function_signature);
  end loop;
end;
$$;

-- Keep the feature disabled through this server foundation rollout.
update public.feature_flags
set enabled = false,
    updated_at = now()
where flag_key = 'transcription_enabled';

commit;
