# Synchronization

## Current implementation boundary

Milestone 1 currently provides durable local-to-cloud synchronization for:

- projects and sessions;
- notes, bookmarks, and supported timeline events;
- primary recording metadata and private audio files;
- image, video, and document evidence metadata and private files.

The remaining synchronization gaps are:

- audio-attachment evidence;
- post-recording evidence capture UI;
- project-level deletion;
- resumable upload and numeric progress hardening.

## Native metadata lifecycle

```text
Create or update entity
  -> write canonical row to SQLite
  -> enqueue one stable metadata UPSERT
  -> show Pending immediately
  -> shared metadata worker upserts through the signed-in Supabase session
  -> mark local entity Synchronized
```

If the device is offline or the service is temporarily unavailable, the local
row remains usable and the operation is rescheduled with exponential backoff.
Failed projects and sessions can be requeued from the UI.

The worker is requested when:

- authentication becomes ready;
- a project, session, note, bookmark, or timeline event is created or changed;
- a recording or evidence upload becomes eligible;
- the application becomes active;
- connectivity returns;
- cloud data is refreshed.

Only one in-process worker can run at a time. Interrupted `in_progress`
operations are reset to `pending` on a later run.

## Web preview

SQLite is intentionally unavailable in the Emergent web preview. Project and
session create/read/update operations therefore use authenticated Supabase
calls directly. The web UI must report a real remote failure and must not
pretend a local write succeeded.

## Dependency ordering

Metadata priorities currently are:

```text
project:                    100
session:                    200
note/bookmark:              300
recording/content timeline: 400
evidence timeline:          500
```

A session with a parent project is deferred until the local project is marked
`synchronized`. Notes and bookmarks are deferred until their session is
synchronized. A note/bookmark timeline event is deferred until both its session
and source entity are synchronized. Recording lifecycle events depend on the
session. Image/video/document timeline events wait until both the session and
their `media_asset` binary/metadata upload are synchronized. Dependency
deferral does not consume the normal retry budget.

## Queue and UI states

Metadata queue states:

```text
pending -> in_progress -> removed after success
                    \-> pending with next_retry_at after transient failure
                    \-> failed after permanent failure or retry exhaustion
```

Local metadata sync states (project, session, note, bookmark, and timeline):

```text
local_only | pending | synchronizing | synchronized | failed
```

## Retry and backoff

`src/services/upload-queue/backoff.ts` provides the shared calculation:

- initial delay: 2 seconds;
- factor: 2;
- cap: 5 minutes;
- jitter: plus or minus 25 percent;
- maximum attempts: 8.

Network, rate-limit, authentication-expiry, and temporary server failures are
retryable. RLS denial, schema validation, permanent conflict, or a failed parent
project are not retried indefinitely.

## Idempotency

Deterministic metadata keys are:

```text
upsert:project:<project_uuid>
upsert:session:<session_uuid>
upsert:note:<note_uuid>
upsert:bookmark:<bookmark_uuid>
upsert:timeline_event:<timeline_uuid>
```

The queue has a unique constraint on `idempotency_key`. A newer local change
reactivates the same operation, and the worker reads the latest canonical row
from SQLite. The same entity UUID is used locally and remotely, and remote
writes use UPSERT on `id`.

## Cloud-to-local merge

On native platforms:

1. local rows are returned first;
2. authorized cloud rows are retrieved when possible;
3. cloud rows are merged by stable UUID;
4. a newer pending local edit is not overwritten by an older cloud row;
5. a matching cloud row reconciles a pending local row to `synchronized`;
6. absence from one cloud response never deletes an unsynchronized local row;
7. cloud hydration preserves cloud `updated_at` and does not create a sync loop;
8. a locally soft-deleted session is not resurrected.

## Session lifecycle metadata

The same session UUID is updated as the recorder moves through:

```text
draft -> recording -> paused -> recording -> recorded
```

Session synchronization includes start/stop timestamps, recorded duration,
project association, and spoken-language preferences. The primary recording is
persisted separately, uploaded to private Storage, and represented by one
stable `public.recordings` row per session.

## Session content metadata

Notes, bookmarks, and supported timeline events are now local-first on native
and remote-backed on web. Native note/bookmark creation writes the source row,
its timeline event, and both queue operations in one SQLite transaction.

The synchronized timeline types are recording start/pause/resume/stop, note,
bookmark, image, video, and document events. Evidence timeline events are
finalized only after the source media asset is synchronized.

Session Detail returns local content first, refreshes cloud content in the
background, merges it into SQLite by stable UUID, and reloads when reconciliation
changed local data. This allows synchronized timeline content to return after an
Expo Go reinstall.

## Workspace handling

The actual personal workspace UUID returned by Supabase is cached per user.
When Supabase is configured, the app never invents an alternate workspace UUID
while offline. The string `anonymous` must never be sent to UUID columns or
filters.

## Binary upload queue

`local_upload_queue` is dedicated to recording and evidence binaries. It is
separate from `local_metadata_sync_queue`; metadata operations do not have a
file URI or Storage path.

Two filtered workers currently process:

```text
source_entity_type = recording
source_entity_type = media_asset
```

Both workers are user-scoped, mutually exclusive, honor Wi-Fi-only settings,
reuse stable UUIDs/paths, and upload to the private `session-assets` bucket.
Standard Upload is currently used; resumable TUS is a later hardening step for
large or unstable transfers.

## Cloud-aware session deletion

Native deletion hides a session immediately and writes one durable
`local_session_deletion_queue` job. Pending metadata and binary uploads for that
session are cancelled so they cannot recreate content while cleanup is in
progress.

Cleanup order is:

```text
private Storage objects
-> cloud session row and database cascades
-> local files and session directory
-> local SQLite graph
```

Before Storage removal, the worker recursively lists the full
`{workspace_id}/{session_id}` prefix to discover orphan objects left by partial
uploads. Progress flags make the job restart-safe. Web performs the same ordered
cleanup synchronously because it has no SQLite queue.

Project-level deletion remains outside the current boundary.

## Background limitations

- Android force-stop prevents immediate background work. Pending SQLite
  operations resume when the app is launched again.
- Native synchronization requires Expo Go or an Android development build; web
  preview validates only the direct remote path.
- Synchronized recording/evidence metadata should be considered fully restored
  only after the matching private Storage object is present.
- Browser blob URLs are temporary; failed web uploads cannot resume after a
  reload.
