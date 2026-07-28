# Synchronization

## Current implementation boundary

Milestone 1 currently implements durable cloud synchronization for **projects**.
Sessions, recordings, notes, bookmarks, timeline events, media metadata, and
binary uploads still use their original local-only/file-queue paths and are the
next synchronization pass.

## Project metadata lifecycle

### Native Android and iOS

```text
Create project
  -> write project to SQLite
  -> enqueue one idempotent project UPSERT operation
  -> display Pending immediately
  -> project worker upserts public.projects through the signed-in user session
  -> mark the local project Synchronized
```

If the network or cloud service is temporarily unavailable, the project remains
available locally and the operation is rescheduled with exponential backoff. A
failed project can also be requeued explicitly from the Library screen.

Local schema version 3 backfills project UPSERT operations for active projects
that were created before the project worker existed, so earlier local projects
do not remain permanently local-only.

The worker is requested when:

- authentication becomes ready;
- a project is created;
- the application becomes active;
- network connectivity returns;
- project data is refreshed.

Only one in-process project worker can run at a time. Operations left in
`in_progress` by an interrupted process are reset to `pending` on the next run.

### Web preview

SQLite is intentionally unavailable in the Emergent web preview. Project
creation and listing therefore use authenticated Supabase operations directly.
The web UI must show a real error if the remote operation fails; it must not
pretend that a local write succeeded.

## Project queue states

```text
pending -> in_progress -> removed after success
                    \-> pending with next_retry_at after transient failure
                    \-> failed after permanent failure or retry exhaustion
```

Project UI states are kept separately from the queue:

```text
local_only | pending | synchronizing | synchronized | failed
```

## Retry and backoff

`src/services/upload-queue/backoff.ts` provides the shared retry calculation:

- initial delay: 2 seconds;
- factor: 2;
- cap: 5 minutes;
- jitter: plus or minus 25 percent;
- maximum attempts: 8.

Network, rate-limit, authentication-expiry, and temporary server failures are
retryable. RLS denial, schema validation, and permanent conflicts are not
retried indefinitely.

## Idempotency

Project operations use a deterministic key:

```text
upsert:project:<project_uuid>
```

The SQLite queue has a unique constraint on `idempotency_key`. Enqueuing a newer
change for the same project reactivates the existing operation so retries always
read the latest canonical project row from `local_projects`. The same project
UUID is used in SQLite and `public.projects`, and the remote write uses UPSERT on
`id`.

## Cloud-to-local merge

On native platforms:

1. local projects are read first;
2. authorized cloud rows are retrieved when possible;
3. cloud rows are merged by stable UUID;
4. a newer pending local change is not overwritten by an older cloud row;
5. a cloud row matching a pending local row reconciles it to `synchronized`;
6. absence from one cloud response never deletes an unsynchronized local row;
7. cloud hydration preserves the cloud `updated_at` value to prevent sync loops.

## Workspace handling

The actual personal workspace UUID returned by Supabase is cached per user.
When Supabase is configured, the app never invents an alternate workspace UUID
while offline. A user must have resolved the real workspace at least once before
creating offline project data.

The string `anonymous` must never be sent to UUID columns or filters.

## Binary upload queue

`local_upload_queue` remains dedicated to files such as recordings, images,
videos, and documents. It is intentionally separate from
`local_metadata_sync_queue`; project metadata does not have a file URI, storage
path, or session id.

Binary file upload to the private `session-assets` bucket is not completed by
this project-sync pass.

## Background limitations

- Android force-stop prevents immediate background work. Pending SQLite records
  resume when the app is launched again.
- Native project synchronization requires Expo Go or an Android development
  build; web preview only validates the direct remote path.
- Project synchronization does not imply that recording/media upload is
  complete.
