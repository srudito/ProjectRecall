# Database

## Tables (all in `public` schema)

| Table                    | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `profiles`               | 1:1 with `auth.users`. App-level user preferences.          |
| `workspaces`             | Personal or team workspace. Owner has full rights.          |
| `workspace_members`      | Membership + role + status link between users & workspaces. |
| `projects`               | Groups sessions inside a workspace.                         |
| `sessions`               | Recording session with language + sync metadata.            |
| `recordings`             | Audio artefact for a session (1:1).                         |
| `media_assets`           | Photos, videos, documents attached during a session.        |
| `attachment_events`      | Audit rows for asset add/remove.                            |
| `user_notes`             | Timestamped free-text notes.                                |
| `bookmarks`              | Timestamped bookmarks.                                      |
| `timeline_events`        | Unified event stream for the chronological timeline.        |
| `upload_queue_records`   | Server-side mirror of the mobile upload queue.              |
| `feature_flags`          | Boolean flags read by clients.                              |
| `processing_jobs`        | Foundation for future async processing.                     |
| `transcription_runs`     | Foundation for future transcription pipelines.              |
| `transcript_versions`    | Foundation for future transcript editing.                   |

## Relationships

- `profiles.id` FK → `auth.users.id` (`on delete cascade`).
- `workspaces.owner_user_id` FK → `auth.users.id`.
- `workspace_members(workspace_id, user_id)` PK-like unique constraint.
- `projects.workspace_id` FK → `workspaces.id`.
- `sessions.workspace_id, project_id, created_by`.
- `recordings.session_id` unique.
- `media_assets.session_id`, `user_notes.session_id`, `bookmarks.session_id`,
  `timeline_events.session_id`.
- `upload_queue_records (user_id, idempotency_key)` unique.

## Constraints & checks

Enum-like check constraints:

- `default_spoken_language_mode` ∈ `{AUTO_DETECT, SINGLE_LANGUAGE, MULTILINGUAL}`
- `session.status` — free text but validated by state machine on client.
- `upload_status` / `queue_status` — bounded set (see migration 0001).

## Indexes

Every FK column commonly used in queries is indexed. RLS predicates use these
indexes:

- `idx_workspaces_owner`, `idx_wm_user`, `idx_wm_workspace`
- `idx_projects_workspace`
- `idx_sessions_workspace`, `idx_sessions_project`
- `idx_media_session`
- `idx_timeline_session(session_id, recording_offset_ms)`

## Row Level Security

Enabled on **every** user-owned table. Access is granted only when
`public.is_workspace_member(workspace_id)` returns true. Two exceptions:

- `profiles`: owner-only (matched by `auth.uid()`).
- `feature_flags`: read-only for `authenticated`.

Full policy list is in `supabase/migrations/0002_rls_policies.sql`.

## Storage policies

Bucket `session-assets` (private, 500 MB / object). Insert / select / update /
delete policies check that the first path segment (`workspace_id`) belongs to
the caller's active workspace membership.

See `SECURITY.md` for the RLS test matrix and the exact CLI commands to
verify each policy.

## Authentication provider metadata migration

`0005_auth_provider_metadata.sql` updates the new-auth-user trigger to use social-provider display-name fields such as `full_name` and `name`. It does not add or remove tables.
