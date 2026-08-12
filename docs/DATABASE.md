# Database

## Tables (all in `public` schema)

| Table                    | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `profiles`               | 1:1 with `auth.users`. App-level user preferences.          |
| `workspaces`             | Personal or team workspace. Owner has full rights.          |
| `workspace_members`      | Membership + role + status link between users & workspaces. |
| `projects`               | Groups sessions inside a workspace.                         |
| `sessions`               | Recording session with language + sync metadata.            |
| `session_user_preferences` | Per-user session star and future organization preferences. |
| `account_deletion_requests` | Durable Delete Account gate, lease, retry, and safe error state. |
| `recordings`             | Audio artefact for a session (1:1).                         |
| `media_assets`           | Photos, videos, documents attached during a session.        |
| `attachment_events`      | Audit rows for asset add/remove.                            |
| `user_notes`             | Timestamped free-text notes.                                |
| `bookmarks`              | Timestamped bookmarks.                                      |
| `timeline_events`        | Unified event stream for the chronological timeline.        |
| `upload_queue_records`   | Server-side mirror of the mobile upload queue.              |
| `feature_flags`          | Boolean flags read by clients.                              |
| `processing_jobs`        | Durable batch-processing jobs with leases, retry, and idempotency. |
| `transcription_runs`     | Provider execution attempts linked to one durable job.      |
| `transcript_versions`    | Versioned transcript text and language summary.              |
| `transcript_segments`    | Timestamped, language-aware transcript segments.             |

## Relationships

- `profiles.id` FK → `auth.users.id` (`on delete cascade`).
- `workspaces.owner_user_id` FK → `auth.users.id`.
- `workspace_members(workspace_id, user_id)` PK-like unique constraint.
- `projects.workspace_id` FK → `workspaces.id`.
- `sessions.workspace_id, project_id, created_by`.
- `session_user_preferences(user_id, session_id)` composite primary key with
  cascade cleanup from both the user and session.
- `recordings.session_id` unique.
- `media_assets.session_id`, `user_notes.session_id`, `bookmarks.session_id`,
  `timeline_events.session_id`.
- `upload_queue_records (user_id, idempotency_key)` unique.
- `account_deletion_requests.user_id` is a one-row-per-user primary key and cascades from `auth.users`.
- `processing_jobs(recording_id, session_id, workspace_id)` is bound to the canonical recording scope.
- `transcription_runs(processing_job_id, run_attempt)` records retry/provider attempts without overwriting history and cascades with its durable job.
- `transcript_versions(session_id, version)` is unique, with at most one `is_current=true` row per session. Run-linked versions use one canonical composite FK that clears only `transcription_run_id` when a provider run/job is removed; the version remains session-scoped until its session or workspace is deleted.
- `transcript_segments(transcript_version_id, segment_index)` is unique and cascades with the version.

## Constraints & checks

Enum-like check constraints:

- `default_spoken_language_mode` ∈ `{AUTO_DETECT, SINGLE_LANGUAGE, MULTILINGUAL}`
- `session.status` — free text but validated by state machine on client.
- `upload_status` / `queue_status` — bounded set (see migration 0001).
- processing jobs enforce bounded attempts, active leases, and non-empty idempotency keys.
- transcription runs enforce provider/model identity, request mode, language cardinality, and positive attempt numbers.
- transcript segments enforce ordered non-negative timestamps, non-empty text, and confidence in `[0, 1]`.

## Indexes

Every FK column commonly used in queries is indexed. RLS predicates use these
indexes:

- `idx_workspaces_owner`, `idx_wm_user`, `idx_wm_workspace`
- `idx_projects_workspace`
- `idx_sessions_workspace`, `idx_sessions_project`
- `idx_session_user_preferences_session`,
  `idx_session_user_preferences_starred`
- `idx_media_session`
- `idx_timeline_session(session_id, recording_offset_ms)`
- `idx_processing_jobs_claim(status, next_attempt_at, priority, created_at)`
- `idx_transcription_runs_session(session_id, created_at)`
- `idx_transcription_runs_creator(created_by, created_at)`
- `idx_transcript_versions_one_current(session_id) WHERE is_current`
- `idx_transcript_versions_run_scope(transcription_run_id, session_id, workspace_id)` for non-null run links
- `idx_transcript_versions_creator(created_by, created_at)`
- `idx_transcript_segments_session_time(session_id, start_ms, segment_index)`

## Row Level Security

Enabled on **every** user-owned table. Access is granted only when
`public.is_workspace_member(workspace_id)` returns true. Two exceptions:

- `profiles`: owner-only (matched by `auth.uid()`).
- `feature_flags`: read-only for `authenticated`.

The original policy set is in `supabase/migrations/0002_rls_policies.sql`.
`0006_session_user_preferences.sql` adds self-only policies for personal
session organization preferences and also requires access to the referenced
session workspace. `0007_account_deletion_gate.sql` adds a durable deletion
gate, distributed advisory-lock write serialization, write-guard triggers, and
gated Storage mutation policies. `0008_workspace_scope_integrity.sql` binds
every session-scoped write to the session's canonical workspace and prevents
cross-workspace identifiers from bypassing the deletion gate.
`0009_guard_function_privileges.sql` removes direct trigger-function execution
from `PUBLIC`, `anon`, and `authenticated` while preserving trigger-based
enforcement. `0010_account_deletion_gate_final_hardening.sql` restricts
internal helper execution and makes `sessions.workspace_id` immutable.
`0011_guard_trigger_record_safety.sql` makes the generic trigger safe across
tables with different row structures by using JSON record access instead of
direct field dereferences. `0012_profile_account_deletion_gate.sql` adds a
profile-specific write guard so profile updates are also frozen while the
durable account-deletion gate is active.

`0013_transcription_foundation_v1.sql` hardens the three disabled foundation
tables, adds transcript segments, binds every row to canonical recording and
session scope, replaces the legacy run/version FK with one deterministic
scoped relationship and explicit run-reference nulling, and replaces broad
authenticated write policies with read-only member policies. It also defines
an explicit Data API privilege matrix: no anonymous table access,
authenticated SELECT-only access, and server-side DML for `service_role`.
Direct provider/result writes are server-only. Delete Account
preflight and final-reference checks include all three new `created_by`
relationships. It also keeps `transcription_enabled=false`.


`0014_transcription_request_worker_v1.sql` adds the disabled durable execution
state machine: authenticated request RPC, one-active-job-per-recording index,
`FOR UPDATE SKIP LOCKED` worker claims, `submitting` state before provider POST,
finite polling deadlines, atomic transcript/version/segment completion, and
provider-artifact cleanup leases. It guards direct processing-job/recording and
session deletion while provider state is unresolved, removes safe provider-free
terminal graphs after membership loss, and re-queues an ambiguous no-ID
submission only after explicit provider-absence confirmation. Digest-using
security-definer RPCs resolve `pgcrypto` through the fixed `extensions` search
path. Worker RPCs remain `service_role` only and the migration ends with
`transcription_enabled=false`.

## Storage policies

Bucket `session-assets` (private, 500 MB / object). Insert / select / update /
delete policies check that the first path segment (`workspace_id`) belongs to
the caller's active workspace membership. Migration `0007` additionally
requires the workspace/account write gate to be open for Storage mutations.

See `SECURITY.md` for the RLS test matrix and the exact CLI commands to
verify each policy.

## Authentication provider metadata migration

`0005_auth_provider_metadata.sql` updates the new-auth-user trigger to use social-provider display-name fields such as `full_name` and `name`. It does not add or remove tables.

## Local SQLite deletion privacy

The native SQLite connection uses WAL mode and enables
`PRAGMA secure_delete = ON`. After scoped Delete Account cleanup commits, the
repository requires `PRAGMA wal_checkpoint(TRUNCATE)` to finish before the
persistent deletion marker can be removed. This preserves other users' rows in
the shared database while preventing deleted account metadata from remaining
in reusable pages or the WAL journal. Automatic `VACUUM` is not used during
account deletion.


## Milestone 2A local SQLite tables

SQLite schema version `10` adds provider-neutral local cache/queue tables. JSON
arrays and objects are stored as text and parsed by repositories in later
phases. The schema is intentionally created before any UI is enabled so app
restart, offline request queuing, session deletion, and Delete Account cleanup
have a durable contract from the beginning.

The semantic request idempotency key includes contract version, workspace,
session, recording, spoken-language mode, and normalized language hints. Cloud
jobs deduplicate that key per workspace. The retained local request queue adds
`user_id` to its unique constraint, so two users sharing one device can keep the
same semantic request independently; a changed language request still creates
a different key.
