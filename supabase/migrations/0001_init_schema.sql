-- ==========================================================================
-- 0001_init_schema.sql
-- Project Recall Milestone 1 base schema.
--
-- All application data lives in the `public` schema. Row Level Security is
-- enabled in migration 0002. Storage bucket + policies are in 0003. Trigger
-- for automatic profile/workspace/membership creation is in 0004.
-- ==========================================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- Profiles ------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  app_language text not null default 'en',
  default_spoken_language_mode text not null default 'AUTO_DETECT'
    check (default_spoken_language_mode in ('AUTO_DETECT','SINGLE_LANGUAGE','MULTILINGUAL')),
  default_expected_spoken_languages text[] not null default '{}',
  default_summary_output_language text not null default 'en',
  default_translation_target_language text,
  preserve_original_language boolean not null default true,
  prefer_bilingual_view boolean not null default false,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Workspaces ----------------------------------------------------------------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  workspace_type text not null default 'personal'
    check (workspace_type in ('personal','team')),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_workspaces_owner on public.workspaces(owner_user_id);

-- Workspace members ---------------------------------------------------------
create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('owner','admin','member','viewer')),
  membership_status text not null default 'active'
    check (membership_status in ('active','invited','suspended','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists idx_wm_user on public.workspace_members(user_id);
create index if not exists idx_wm_workspace on public.workspace_members(workspace_id);

-- Projects ------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active'
    check (status in ('active','archived')),
  default_spoken_language_mode text
    check (default_spoken_language_mode in ('AUTO_DETECT','SINGLE_LANGUAGE','MULTILINGUAL')),
  default_expected_spoken_languages text[],
  default_summary_output_language text,
  default_translation_target_language text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_projects_workspace on public.projects(workspace_id);

-- Sessions ------------------------------------------------------------------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  created_by uuid not null references auth.users(id),
  title text not null default 'Untitled session',
  session_type text not null default 'standard',
  status text not null default 'draft',
  started_at timestamptz,
  stopped_at timestamptz,
  total_recorded_duration_ms bigint not null default 0,
  spoken_language_mode text not null default 'AUTO_DETECT'
    check (spoken_language_mode in ('AUTO_DETECT','SINGLE_LANGUAGE','MULTILINGUAL')),
  expected_spoken_languages text[] not null default '{}',
  detected_spoken_languages text[] not null default '{}',
  primary_detected_language text,
  language_detection_status text not null default 'NOT_STARTED'
    check (language_detection_status in ('NOT_STARTED','DETECTING','DETECTED','PARTIALLY_DETECTED','USER_CONFIRMED','FAILED')),
  summary_output_language text,
  translation_target_language text,
  transcript_display_mode text not null default 'ORIGINAL'
    check (transcript_display_mode in ('ORIGINAL','TRANSLATED','BILINGUAL')),
  language_metadata jsonb,
  local_sync_status text not null default 'local_only',
  cloud_sync_status text not null default 'local_only',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_sessions_workspace on public.sessions(workspace_id);
create index if not exists idx_sessions_project on public.sessions(project_id);
create index if not exists idx_sessions_created_by on public.sessions(created_by);

-- Recordings ----------------------------------------------------------------
create table if not exists public.recordings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  local_file_uri text,
  private_storage_path text,
  mime_type text not null,
  original_file_name text not null,
  file_size bigint not null default 0,
  duration_ms bigint not null default 0,
  recording_format text not null,
  checksum_sha256 text,
  upload_status text not null default 'local_only'
    check (upload_status in ('local_only','pending','uploading','uploaded','synchronized','failed','cancelled')),
  upload_error_code text,
  upload_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id)
);

-- Media assets --------------------------------------------------------------
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  added_by uuid not null references auth.users(id),
  asset_type text not null check (asset_type in ('image','video','document','audio_attachment')),
  mime_type text not null,
  original_file_name text not null,
  sanitized_file_name text not null,
  local_file_uri text,
  private_storage_path text,
  file_size bigint not null default 0,
  duration_ms bigint,
  image_width integer,
  image_height integer,
  page_count integer,
  captured_at timestamptz,
  recording_offset_ms bigint not null default 0,
  user_caption text,
  checksum_sha256 text,
  upload_status text not null default 'local_only'
    check (upload_status in ('local_only','pending','uploading','uploaded','synchronized','failed','cancelled')),
  upload_error_code text,
  upload_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_media_session on public.media_assets(session_id);

-- Attachment events (audit) -------------------------------------------------
create table if not exists public.attachment_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  media_asset_id uuid references public.media_assets(id) on delete set null,
  recording_offset_ms bigint not null default 0,
  event_type text not null check (event_type in ('image_added','video_added','document_added','audio_attachment_added','asset_removed')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- User notes ----------------------------------------------------------------
create table if not exists public.user_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  text text not null,
  recording_offset_ms bigint not null default 0,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Bookmarks -----------------------------------------------------------------
create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  label text not null default 'Bookmark',
  recording_offset_ms bigint not null default 0,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Timeline events -----------------------------------------------------------
create table if not exists public.timeline_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  event_type text not null check (event_type in (
    'recording_started','recording_paused','recording_resumed','recording_stopped',
    'bookmark_added','note_added','image_added','video_added','document_added','evidence_removed'
  )),
  source_entity_type text,
  source_entity_id uuid,
  recording_offset_ms bigint not null default 0,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_timeline_session on public.timeline_events(session_id, recording_offset_ms);

-- Upload queue --------------------------------------------------------------
-- Server-side mirror for auditing; the durable queue lives in mobile SQLite.
create table if not exists public.upload_queue_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  source_entity_type text not null,
  source_entity_id uuid not null,
  local_file_uri text,
  target_storage_path text not null,
  queue_status text not null default 'pending'
    check (queue_status in ('pending','uploading','uploaded','failed','cancelled')),
  attempt_count integer not null default 0,
  next_retry_at timestamptz,
  last_error_code text,
  last_safe_error text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

-- Feature flags -------------------------------------------------------------
create table if not exists public.feature_flags (
  flag_key text primary key,
  enabled boolean not null default false,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.feature_flags (flag_key, enabled, description) values
  ('ask_ai_enabled', false, 'Enable Ask AI screens.'),
  ('transcription_enabled', false, 'Enable batch transcription features.'),
  ('live_transcription_enabled', false, 'Enable live transcription.'),
  ('billing_enabled', false, 'Enable billing / subscription screens.'),
  ('ads_enabled', false, 'Enable advertising.'),
  ('admin_enabled', false, 'Enable administration control panel.')
on conflict (flag_key) do nothing;

-- Foundation-only future tables --------------------------------------------
create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null default 'not_started',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transcription_runs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  status text not null default 'not_started',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transcript_versions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  transcription_run_id uuid references public.transcription_runs(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
