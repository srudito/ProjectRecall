-- ============================================================================
-- 0013_transcription_foundation_v1.sql
-- Milestone 2A: durable, provider-neutral batch-transcription foundation.
--
-- This migration hardens the three foundation tables created in 0001 and adds
-- immutable, timestamped transcript segments. It does not enable the feature
-- flag and does not call any transcription provider.
-- ============================================================================

begin;

-- Freeze the disabled foundation while the empty-table precondition and
-- NOT NULL/composite constraints are installed. This closes the small race
-- where a legacy authenticated client could otherwise insert a row between
-- the precondition and the ALTER TABLE statements.
lock table
  public.processing_jobs,
  public.transcription_runs,
  public.transcript_versions
in access exclusive mode;

-- The Milestone 1 feature flag was disabled and no application path could
-- create rows in these foundation tables. Fail closed instead of guessing how
-- to transform unexpected pre-Milestone-2 data.
do $$
begin
  if exists (select 1 from public.processing_jobs)
     or exists (select 1 from public.transcription_runs)
     or exists (select 1 from public.transcript_versions) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_FOUNDATION_ALREADY_IN_USE';
  end if;
end $$;

-- Composite uniqueness lets child rows enforce canonical workspace/session
-- scope through ordinary foreign keys rather than trusting client payloads.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sessions_id_workspace_unique'
      and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions
      add constraint sessions_id_workspace_unique
      unique (id, workspace_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'recordings_id_session_workspace_unique'
      and conrelid = 'public.recordings'::regclass
  ) then
    alter table public.recordings
      add constraint recordings_id_session_workspace_unique
      unique (id, session_id, workspace_id);
  end if;
end $$;

-- Durable processing job ----------------------------------------------------
alter table public.processing_jobs
  alter column status set default 'queued',
  add column if not exists job_type text not null default 'batch_transcription',
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists recording_id uuid not null references public.recordings(id) on delete cascade,
  add column if not exists idempotency_key text not null,
  add column if not exists priority integer not null default 100,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempts integer not null default 5,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_safe_error text,
  add column if not exists request_payload jsonb not null default '{}'::jsonb;

update public.processing_jobs
set status = 'queued'
where status = 'not_started';

alter table public.processing_jobs
  add constraint processing_jobs_job_type_check
    check (job_type in ('batch_transcription')),
  add constraint processing_jobs_status_check
    check (status in ('queued','leased','processing','succeeded','failed','cancelled')),
  add constraint processing_jobs_attempt_count_check
    check (attempt_count >= 0),
  add constraint processing_jobs_max_attempts_check
    check (max_attempts > 0 and attempt_count <= max_attempts),
  add constraint processing_jobs_priority_check
    check (priority >= 0),
  add constraint processing_jobs_idempotency_key_check
    check (length(btrim(idempotency_key)) > 0),
  add constraint processing_jobs_lease_check
    check (
      (status not in ('leased','processing'))
      or (lease_owner is not null and lease_expires_at is not null)
    ),
  add constraint processing_jobs_recording_scope_fk
    foreign key (recording_id, session_id, workspace_id)
    references public.recordings(id, session_id, workspace_id)
    on delete cascade,
  add constraint processing_jobs_id_scope_unique
    unique (id, session_id, workspace_id, recording_id),
  add constraint processing_jobs_workspace_idempotency_unique
    unique (workspace_id, idempotency_key);

create index if not exists idx_processing_jobs_claim
  on public.processing_jobs(status, next_attempt_at, priority, created_at);
create index if not exists idx_processing_jobs_session
  on public.processing_jobs(session_id, created_at desc);
create index if not exists idx_processing_jobs_creator
  on public.processing_jobs(created_by, created_at desc);

-- Provider execution record ------------------------------------------------
alter table public.transcription_runs
  alter column status set default 'queued',
  add column if not exists processing_job_id uuid not null,
  add column if not exists workspace_id uuid not null,
  add column if not exists recording_id uuid not null,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists run_attempt integer not null default 1,
  add column if not exists provider_key text not null,
  add column if not exists provider_model text not null,
  add column if not exists request_mode text not null default 'AUTO_DETECT',
  add column if not exists requested_languages text[] not null default '{}',
  add column if not exists provider_job_id text,
  add column if not exists detected_languages text[] not null default '{}',
  add column if not exists primary_detected_language text,
  add column if not exists language_detection_status text not null default 'NOT_STARTED',
  add column if not exists provider_metadata jsonb not null default '{}'::jsonb,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_safe_error text;

update public.transcription_runs
set status = 'queued'
where status = 'not_started';

alter table public.transcription_runs
  add constraint transcription_runs_attempt_check
    check (run_attempt > 0),
  add constraint transcription_runs_status_check
    check (status in ('queued','processing','succeeded','failed','cancelled')),
  add constraint transcription_runs_request_mode_check
    check (request_mode in ('AUTO_DETECT','SINGLE_LANGUAGE','MULTILINGUAL')),
  add constraint transcription_runs_language_status_check
    check (
      language_detection_status in (
        'NOT_STARTED','DETECTING','DETECTED','PARTIALLY_DETECTED',
        'USER_CONFIRMED','FAILED'
      )
    ),
  add constraint transcription_runs_provider_key_check
    check (length(btrim(provider_key)) > 0),
  add constraint transcription_runs_provider_model_check
    check (length(btrim(provider_model)) > 0),
  add constraint transcription_runs_language_selection_check
    check (
      request_mode = 'AUTO_DETECT'
      or (request_mode = 'SINGLE_LANGUAGE' and cardinality(requested_languages) = 1)
      or (request_mode = 'MULTILINGUAL' and cardinality(requested_languages) >= 2)
    ),
  add constraint transcription_runs_processing_job_scope_fk
    foreign key (processing_job_id, session_id, workspace_id, recording_id)
    references public.processing_jobs(id, session_id, workspace_id, recording_id)
    on delete cascade,
  add constraint transcription_runs_processing_job_attempt_unique
    unique (processing_job_id, run_attempt),
  add constraint transcription_runs_id_scope_unique
    unique (id, session_id, workspace_id);

create index if not exists idx_transcription_runs_session
  on public.transcription_runs(session_id, created_at desc);
create index if not exists idx_transcription_runs_creator
  on public.transcription_runs(created_by, created_at desc);
create unique index if not exists idx_transcription_runs_provider_job
  on public.transcription_runs(provider_key, provider_job_id)
  where provider_job_id is not null;

-- Versioned transcript record ---------------------------------------------
-- Replace the legacy single-column ON DELETE SET NULL foreign key from
-- migration 0001 with one canonical scoped foreign key. Only the nullable run
-- reference is cleared when a provider run is removed; session/workspace scope
-- remains enforced by the separate session-scope foreign key.
alter table public.transcript_versions
  drop constraint if exists transcript_versions_transcription_run_id_fkey;

alter table public.transcript_versions
  add column if not exists workspace_id uuid not null,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists version_origin text not null default 'provider',
  add column if not exists version_status text not null default 'final',
  add column if not exists parent_version_id uuid,
  add column if not exists plain_text text not null default '',
  add column if not exists language_summary jsonb not null default '{}'::jsonb,
  add column if not exists content_checksum_sha256 text,
  add column if not exists is_current boolean not null default false;

alter table public.transcript_versions
  add constraint transcript_versions_version_check
    check (version > 0),
  add constraint transcript_versions_origin_check
    check (version_origin in ('provider','user_edit','import')),
  add constraint transcript_versions_status_check
    check (version_status in ('draft','final')),
  add constraint transcript_versions_checksum_check
    check (
      content_checksum_sha256 is null
      or content_checksum_sha256 ~ '^[0-9A-Fa-f]{64}$'
    ),
  add constraint transcript_versions_run_scope_fk
    foreign key (transcription_run_id, session_id, workspace_id)
    references public.transcription_runs(id, session_id, workspace_id)
    on delete set null (transcription_run_id),
  add constraint transcript_versions_session_scope_fk
    foreign key (session_id, workspace_id)
    references public.sessions(id, workspace_id)
    on delete cascade,
  add constraint transcript_versions_id_scope_unique
    unique (id, session_id, workspace_id),
  add constraint transcript_versions_session_version_unique
    unique (session_id, version),
  add constraint transcript_versions_parent_scope_fk
    foreign key (parent_version_id, session_id, workspace_id)
    references public.transcript_versions(id, session_id, workspace_id);

create unique index if not exists idx_transcript_versions_one_current
  on public.transcript_versions(session_id)
  where is_current;
create index if not exists idx_transcript_versions_session_created
  on public.transcript_versions(session_id, created_at desc);
create index if not exists idx_transcript_versions_run_scope
  on public.transcript_versions(
    transcription_run_id,
    session_id,
    workspace_id
  )
  where transcription_run_id is not null;
create index if not exists idx_transcript_versions_creator
  on public.transcript_versions(created_by, created_at desc);

-- Timestamped, language-aware segments -------------------------------------
create table if not exists public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  session_id uuid not null,
  transcript_version_id uuid not null,
  segment_index integer not null,
  start_ms bigint not null,
  end_ms bigint not null,
  text text not null,
  language_code text,
  speaker_label text,
  confidence numeric,
  provider_segment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transcript_segments_index_check check (segment_index >= 0),
  constraint transcript_segments_start_check check (start_ms >= 0),
  constraint transcript_segments_end_check check (end_ms >= start_ms),
  constraint transcript_segments_text_check check (length(btrim(text)) > 0),
  constraint transcript_segments_confidence_check
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint transcript_segments_version_scope_fk
    foreign key (transcript_version_id, session_id, workspace_id)
    references public.transcript_versions(id, session_id, workspace_id)
    on delete cascade,
  unique (transcript_version_id, segment_index)
);

create index if not exists idx_transcript_segments_session_time
  on public.transcript_segments(session_id, start_ms, segment_index);
create index if not exists idx_transcript_segments_version
  on public.transcript_segments(transcript_version_id, segment_index);

-- RLS and write gates -------------------------------------------------------
-- Mobile clients may read workspace-visible processing state and transcripts,
-- but provider execution and transcript writes are server-only. The service
-- role used by a reviewed worker bypasses RLS. A later milestone may add a
-- narrow RPC for user edits without widening direct table mutation rights.
alter table public.transcript_segments enable row level security;

drop policy if exists processing_jobs_member_all
  on public.processing_jobs;
drop policy if exists tr_runs_member_all
  on public.transcription_runs;
drop policy if exists tv_member_all
  on public.transcript_versions;
drop policy if exists transcript_segments_member_all
  on public.transcript_segments;

create policy processing_jobs_member_select
  on public.processing_jobs
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy transcription_runs_member_select
  on public.transcription_runs
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy transcript_versions_member_select
  on public.transcript_versions
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy transcript_segments_member_select
  on public.transcript_segments
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

-- Normalize table privileges explicitly. New Supabase projects no longer
-- guarantee automatic public-schema grants, so the reviewed server writer must
-- not depend on project creation defaults. Authenticated clients remain
-- read-only, anon remains unable to access these tables, and only the trusted
-- service role receives provider/result mutation privileges.
revoke all privileges
  on table public.processing_jobs,
           public.transcription_runs,
           public.transcript_versions,
           public.transcript_segments
  from public, anon, authenticated, service_role;

grant select
  on table public.processing_jobs,
           public.transcription_runs,
           public.transcript_versions,
           public.transcript_segments
  to authenticated;

grant select, insert, update, delete
  on table public.processing_jobs,
           public.transcription_runs,
           public.transcript_versions,
           public.transcript_segments
  to service_role;

drop trigger if exists guard_account_deletion_write
  on public.transcript_segments;
create trigger guard_account_deletion_write
  before insert or update on public.transcript_segments
  for each row execute function public.guard_account_deletion_write();

drop trigger if exists set_updated_at
  on public.transcript_segments;
create trigger set_updated_at
  before update on public.transcript_segments
  for each row execute function public.touch_updated_at();

-- The feature remains off until provider execution, result ingestion, and UI
-- are implemented and reviewed in later Milestone 2 phases.
update public.feature_flags
set enabled = false,
    updated_at = now()
where flag_key = 'transcription_enabled';

commit;
