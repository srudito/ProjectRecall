# Synchronization

## Current implementation boundary

Milestone 1 currently provides durable local-to-cloud metadata synchronization
for:

- projects;
- sessions.

The following still use their original local-only or file-queue paths:

- recording metadata;
- notes;
- bookmarks;
- timeline events;
- media metadata;
- audio, image, video, and document binaries.

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
- a project or session is created or changed;
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
project:        100
session:        200
note/bookmark:  300
timeline event: 400
```

A session with a parent project is deferred until the local project is marked
`synchronized`. Notes and bookmarks are deferred until their session is
synchronized. A note/bookmark timeline event is deferred until both its session
and source entity are synchronized; recording lifecycle events depend only on
the session. Dependency deferral does not consume the normal retry budget.

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
project association, and spoken-language preferences. Audio content itself is
not uploaded by this pass.

## Session content metadata

Notes, bookmarks, and supported timeline events are now local-first on native
and remote-backed on web. Native note/bookmark creation writes the source row,
its timeline event, and both queue operations in one SQLite transaction.

The synchronized timeline types are recording start/pause/resume/stop plus note
and bookmark events. Media-related timeline events remain local-only until media
metadata and private Storage synchronization are implemented.

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

`local_upload_queue` remains dedicated to recordings, images, videos, and
documents. It is separate from `local_metadata_sync_queue`; metadata operations
do not have a file URI or storage path.

Binary upload to the private `session-assets` bucket remains a later Milestone 1
closure task.

## Deletion boundary

Project and session cloud-aware deletion is not complete. Local session deletion
hides the row and removes pending session UPSERT operations. Cloud rows and
binary objects require a later durable deletion queue and must not be described
as fully removed yet.

## Background limitations

- Android force-stop prevents immediate background work. Pending SQLite
  operations resume when the app is launched again.
- Native synchronization requires Expo Go or an Android development build; web
  preview validates only the direct remote path.
- Metadata synchronization does not imply that recording or evidence files are
  stored in Supabase Storage.
