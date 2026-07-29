# Note, Bookmark, and Timeline Sync v1

## Scope

This pass extends the verified local-first metadata pipeline to synchronize:

- user notes;
- bookmarks;
- recording lifecycle timeline events;
- timeline events linked to a note or bookmark.

The synchronized timeline event types are:

- `recording_started`;
- `recording_paused`;
- `recording_resumed`;
- `recording_stopped`;
- `note_added`;
- `bookmark_added`.

Image, video, document, and evidence-removal events remain local-only until
media metadata and private Storage synchronization are implemented.

## No new Supabase migration

No new cloud SQL migration is required. This implementation reuses the tables
and RLS policies already created by Supabase migrations `0001` through `0004`:

- `public.user_notes`;
- `public.bookmarks`;
- `public.timeline_events`.

Do not rerun Supabase migrations `0001` through `0004` for this feature.

## Local SQLite schema version 5

Local migration version 5 adds synchronization state to:

- `local_notes`;
- `local_bookmarks`;
- `local_timeline_events`.

The added fields are:

- `local_sync_status`;
- `cloud_sync_status`;
- `last_sync_error_code`;
- `last_sync_error_message`;
- `last_synced_at`.

Existing eligible local rows are preserved and queued for synchronization.
Historical rows that were already deleted when Expo Go was uninstalled cannot
be recovered because they never reached Supabase.

## Native local-first writes

On Android and iOS, adding a note or bookmark is atomic in SQLite:

```text
write source entity
+ write related timeline event
+ enqueue source UPSERT
+ enqueue timeline-event UPSERT
= one local transaction
```

Stable UUIDs are used locally and remotely. Deterministic idempotency keys are:

```text
upsert:note:<note_uuid>
upsert:bookmark:<bookmark_uuid>
upsert:timeline_event:<timeline_uuid>
```

## Dependency ordering

The shared metadata worker processes entities by priority:

```text
project          100
session          200
note/bookmark    300
timeline event   400
```

A note or bookmark waits for its parent session. A note/bookmark timeline event
waits for both its session and its source entity. Recording lifecycle events
wait only for the session. Dependency deferral does not consume the normal
transient-error retry budget.

## Web behavior

The Emergent web preview does not use the native SQLite database. Web actions
therefore:

- upsert notes and bookmarks directly to Supabase;
- upsert the matching timeline event directly to Supabase;
- read notes, bookmarks, and timeline events directly from Supabase.

The web timeline no longer depends on the Expo Go database.

## Native restoration and reconciliation

On native platforms, Session Detail returns local content first. It then
refreshes authorized cloud content in the background, merges it into SQLite by
stable UUID, and signals the active screen to reload when data changed.

This supports restoration after reinstalling Expo Go or opening the same account
on another device, provided the content was synchronized before local data was
removed.

Pending newer local note/bookmark changes are not overwritten by older cloud
rows. A cloud row matching a pending local row reconciles it to
`synchronized` and removes its completed queue operation.

## Error handling

Transient network, rate-limit, and temporary server failures are rescheduled
using the existing exponential backoff. Permanent RLS, validation, missing
parent, and retry-exhaustion failures are marked failed rather than retried
indefinitely.

The recording screen catches note/bookmark creation errors and displays a safe
message rather than producing an unhandled promise rejection. Web bookmark
duplicate prevention reads existing cloud bookmarks because native SQLite is
not available in the browser.

## Security boundary

All remote operations use the authenticated Supabase user session and existing
RLS policies. The mobile app does not use a service-role key, Supabase secret
key, database password, or JWT signing secret.

## Files added

- `frontend/src/services/supabase/session-content-repository.ts`
- `frontend/__tests__/session-content-repository.test.ts`
- `frontend/__tests__/session-content-sync-worker.test.ts`

## Main files changed

- `frontend/app/record/active.tsx`
- `frontend/src/services/session/service.ts`
- `frontend/src/services/sqlite/migrations.ts`
- `frontend/src/services/sqlite/repository.ts`
- `frontend/src/services/sync/project-sync-worker.ts`
- existing project/session worker and migration tests
- `docs/SYNC.md`
- `docs/ROADMAP.md`

## Out of scope

This pass does not implement:

- note or bookmark editing/deletion synchronization;
- media metadata synchronization;
- image, video, document, or audio upload;
- private Storage synchronization;
- cloud-aware cascade deletion;
- transcription, OCR, or AI.

## Validation performed while preparing the patch

The patch-build environment completed:

- strict TypeScript validation of the synchronization core using local module
  declarations;
- TypeScript syntax transpilation of changed TS/TSX files;
- fresh SQLite schema creation through local version 5;
- SQLite version 4 to 5 preservation and queue-backfill checks;
- atomic note/bookmark/timeline creation against SQLite;
- metadata-worker runtime checks for source-before-timeline ordering;
- authenticated remote-repository mapping and stable-ID checks;
- patch application and whitespace verification;
- archive integrity and secret-file scans.

The uploaded repository does not contain `node_modules`, so the real project
commands (`npx tsc`, Jest, Expo ESLint, and Expo Doctor) must still be run in the
configured Emergent Code Editor before commit.
