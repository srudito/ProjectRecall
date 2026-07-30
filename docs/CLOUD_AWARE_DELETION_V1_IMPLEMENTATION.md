# Cloud-Aware Session Deletion v1

## Scope

This pass makes **Delete Session** remove the complete session graph rather than
only hiding the local session row.

The deletion scope includes:

- the session row;
- primary recording metadata;
- note, bookmark, and timeline rows;
- evidence metadata;
- upload-audit rows and future session-owned rows covered by foreign-key
  cascades;
- private recording and evidence objects below the session Storage prefix;
- durable local recording/evidence files;
- SQLite rows and queued synchronization operations.

Project deletion is intentionally out of scope.

## Ordered deletion

Deletion follows this order:

```text
1. Hide session locally and cancel pending writes
2. Discover known and orphaned private Storage objects
3. Delete private Storage objects
4. Delete public.sessions row
5. PostgreSQL ON DELETE CASCADE removes session-owned metadata
6. Delete durable local files and session directory
7. Hard-delete the local SQLite graph
8. Remove the completed deletion job
```

Storage is deleted before the database session row. This preserves the user's
workspace membership and metadata context while Storage RLS is still able to
authorize cleanup.

## Native durable queue

Native Android/iOS uses:

```text
local_session_deletion_queue
```

The queue stores:

- authenticated user ID;
- workspace and session IDs;
- known Storage paths;
- known local file URIs;
- progress flags for Storage, cloud metadata, and local files;
- attempts, retry time, and safe errors.

The session is hidden immediately by setting `deleted_at`, while cleanup can
continue after app restart or network restoration.

Interrupted `in_progress` work is reset for the currently signed-in user.
Permanent failures are retained as `failed` and are not automatically retried
in a tight loop.

## Orphan discovery

Before deleting Storage, the worker recursively lists every object below:

```text
{workspace_id}/{session_id}
```

This discovers objects whose binary upload completed but whose database
metadata was not committed because the app or network was interrupted.

Local file URIs are also rediscovered from local recording, evidence, and
upload-queue rows. The complete app-controlled session directory is removed
when local cleanup finishes.

## Web behavior

The web preview has no durable SQLite queue. It performs the same ordered
cleanup synchronously:

```text
list session objects -> remove Storage objects -> delete session row
```

A failure is shown to the user and the Session Detail page remains available.

## In-flight upload race protection

Recording and evidence upload workers re-check the parent session immediately
after a binary upload. If deletion started while the upload was in progress,
the just-uploaded object is removed, the upload operation is cancelled, and no
new cloud metadata row is created. This prevents an upload from recreating an
orphan after the deletion worker has already scanned the session prefix.

## Idempotency and partial recovery

Each native session has at most one deletion job:

```text
session-delete:<session_uuid>
```

Progress flags make retries resume from the unfinished step. Removing a path
or deleting a database row that is already absent is treated as an idempotent
success.

## Security boundary

All remote work uses the authenticated user's normal Supabase session. No
service-role key is used by the mobile application.

The existing session-table RLS and private `session-assets` Storage policies
remain authoritative. A user cannot clean up another workspace unless the
existing membership policies authorize that operation.

## Known limitations

- Project deletion remains blocked/unsupported.
- A permanently failed background cleanup is retained locally for diagnostics;
  a dedicated cleanup-management screen is a later hardening step.
- Android force-stop prevents immediate work; cleanup resumes on next launch.
- Deletion cannot recover local files that were already removed outside the
  application.
