# Note, Bookmark, and Timeline Sync v1 Verification

Use the development Supabase project and branch `milestone1sync`.

## Automated checks

Run from `/app/frontend`:

```bash
npx tsc --noEmit
npx jest
npx expo-doctor
```

Run targeted ESLint:

```bash
npx eslint \
  "./app/record/active.tsx" \
  "./app/session/[id].tsx" \
  "./src/services/session/service.ts" \
  "./src/services/sqlite/repository.ts" \
  "./src/services/sqlite/schema.ts" \
  "./src/services/sqlite/migrations.ts" \
  "./src/services/supabase/session-content-repository.ts" \
  "./src/services/sync/project-sync-worker.ts" \
  "./__tests__/sqlite-migrations.test.ts" \
  "./__tests__/project-sync-worker.test.ts" \
  "./__tests__/session-sync-worker.test.ts" \
  "./__tests__/session-content-repository.test.ts" \
  "./__tests__/session-content-sync-worker.test.ts"
```

Expected:

```text
TypeScript       0 errors
Jest             all suites passed
Expo Doctor      all checks passed
Targeted ESLint  0 errors
```

## Expo Go online test

1. Sign in.
2. Create or select a synchronized project.
3. Start a recording.
4. Add one note.
5. Add one bookmark.
6. Pause and resume once.
7. Stop the recording.
8. Open Session Detail -> Timeline.

Expected timeline:

```text
Recording started
Note added: <note text>
Bookmark added: <bookmark label>
Recording paused
Recording resumed
Recording stopped
```

Verify Supabase:

```sql
select * from public.user_notes order by created_at desc;
select * from public.bookmarks order by created_at desc;
select * from public.timeline_events
order by recording_offset_ms, created_at;
```

Expected:

- one note row;
- one bookmark row;
- matching timeline rows;
- correct `workspace_id`, `session_id`, and `created_by`;
- stable source UUIDs;
- no duplicate rows.

## Web restoration test

1. Open the same session in the web preview.
2. Select Timeline.
3. Select Evidence.
4. Refresh the browser.

Expected:

- timeline is populated from Supabase;
- note and bookmark labels are present;
- Evidence lists the note and bookmark;
- data remains after browser refresh.

Media evidence remains out of scope and may still be absent on web.

## Expo Go reinstall restoration test

Use newly created synchronized data only.

1. Confirm note/bookmark/timeline rows exist in Supabase.
2. Close and uninstall Expo Go.
3. Reinstall Expo Go and open the same project.
4. Sign in.
5. Open the same session.

Expected:

- notes, bookmarks, and timeline are restored from Supabase;
- SQLite is repopulated;
- no duplicate cloud rows are created.

Historical local-only rows deleted before this feature cannot be restored.

## Offline test

1. Start a session online and wait until the session is synchronized.
2. Disable network connectivity.
3. Add one note and one bookmark.
4. Confirm both appear locally.
5. Close and reopen the app without clearing data.
6. Restore connectivity and foreground the app.

Expected:

- content remains visible while offline;
- metadata queue rows remain pending;
- note/bookmark synchronize before their timeline events;
- all rows appear exactly once in Supabase after reconnect;
- completed queue operations are removed.

## Full parent dependency test

Create a project and session offline, then add a note and bookmark. Reconnect.

Expected cloud order:

```text
project -> session -> note/bookmark -> timeline event
```

All child rows must reference the correct parent UUIDs.

## User isolation test

With User A, create a session, note, bookmark, and timeline. Sign in as User B.

Expected:

- User B cannot see User A notes, bookmarks, or timeline through the app;
- User B cannot insert child rows into User A workspace/session;
- unauthenticated requests are denied.

## Duplicate queries

```sql
select id, count(*)
from public.user_notes
group by id
having count(*) > 1;

select id, count(*)
from public.bookmarks
group by id
having count(*) > 1;

select id, count(*)
from public.timeline_events
group by id
having count(*) > 1;
```

Expected: no rows.

## Scope reminder

The following remain for the next pass:

- recording/media metadata synchronization;
- audio, image, video, and document upload;
- private `session-assets` Storage;
- media timeline restoration on web;
- cloud-aware deletion.
