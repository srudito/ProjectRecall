# Cloud-Aware Session Deletion v1 — Verification Checklist

Use a development Supabase project only.

## Automated gates

```bash
cd /app/frontend
npx tsc --noEmit
npx jest
npx expo-doctor
```

Targeted lint:

```bash
npx eslint \
  "./app/session/[id].tsx" \
  "./src/services/session/service.ts" \
  "./src/services/sqlite/repository.ts" \
  "./src/services/sqlite/migrations.ts" \
  "./src/services/supabase/session-assets.ts" \
  "./src/services/supabase/session-deletion-repository.ts" \
  "./src/services/sync/ProjectSyncCoordinator.tsx" \
  "./src/services/sync/session-deletion-worker.ts" \
  "./__tests__/sqlite-migrations.test.ts" \
  "./__tests__/session-deletion-worker.test.ts" \
  "./__tests__/session-deletion-repository.test.ts" \
  "./__tests__/session-assets-cleanup.test.ts"
```

Expected: zero errors and zero warnings for the targeted files.

## Online native deletion

Create a synchronized session containing:

- one recording;
- one note;
- one bookmark;
- one image;
- one video or document;
- synchronized timeline events.

Press **Delete Session**, confirm, then verify:

- the session disappears from Home, Library, and Project Detail;
- the session row is absent from `public.sessions`;
- recording, notes, bookmarks, timeline, and evidence rows are absent;
- all objects below the session Storage prefix are absent;
- the project remains;
- another session in the same project remains.

## Offline native deletion

1. Open the app once while online.
2. Turn off Wi-Fi and mobile data.
3. Delete a locally available synchronized session.
4. Confirm the session disappears immediately.
5. Force-close and reopen Expo Go while still offline.
6. Confirm the session remains hidden.
7. Reconnect and foreground the app.
8. Verify cloud rows and Storage objects are removed.

Expected notification after the offline request:

```text
Session removed
Cloud files will be removed automatically when the connection is available.
```

## Delete while upload is pending

1. Enable Wi-Fi-only upload.
2. Use mobile data only.
3. Record and add evidence so uploads remain Pending.
4. Delete the session.
5. Reconnect to Wi-Fi.

Expected:

- cancelled upload rows do not restart;
- no new Storage object is created after deletion;
- session cleanup completes;
- no orphan object remains.

## Delete during an in-flight upload

1. Start a large video/document upload.
2. Delete the session while the status is Uploading.
3. Wait for cleanup to finish.

Expected:

- the upload cannot recreate recording/evidence metadata;
- a just-uploaded object is removed;
- the upload queue operation is cancelled/removed;
- the session prefix contains no object afterward.

## Orphan Storage cleanup

In the development project, upload or retain one extra file under the selected
session prefix that has no `public.recordings` or `public.media_assets` row.
Delete the session through the app.

Expected: the orphan object is also removed by recursive prefix discovery.

## Web deletion

1. Open a synchronized session in standalone web preview.
2. Press Delete Session.
3. Confirm the browser prompt.

Expected:

- the page returns to Library;
- the session row and session-owned metadata are absent;
- private Storage objects are absent;
- browser refresh does not restore the session.

## Reinstall after deletion

After deletion has completed in cloud:

1. Uninstall Expo Go.
2. Reinstall and sign in.

Expected: the deleted session, timeline, recording, and evidence do not return.

## User isolation

User A creates and synchronizes a session. User B must not be able to:

- see or open the session;
- delete the session row;
- list its Storage objects;
- remove its Storage objects.

Use normal application sessions, not Supabase Table Editor.

## SQL checks

Replace `SESSION_UUID` as appropriate.

```sql
select * from public.sessions where id = 'SESSION_UUID';
select * from public.recordings where session_id = 'SESSION_UUID';
select * from public.media_assets where session_id = 'SESSION_UUID';
select * from public.user_notes where session_id = 'SESSION_UUID';
select * from public.bookmarks where session_id = 'SESSION_UUID';
select * from public.timeline_events where session_id = 'SESSION_UUID';
```

Expected: no rows.

Check Storage:

```sql
select bucket_id, name
from storage.objects
where bucket_id = 'session-assets'
  and name like 'WORKSPACE_UUID/SESSION_UUID/%';
```

Expected: no rows.

## Regression checks

- Delete Session asks for confirmation.
- Cancel keeps the session unchanged.
- Delete and Back buttons do not flicker.
- Repeated Delete taps do not create multiple jobs.
- Other sessions and projects remain intact.
- TypeScript, Jest, Expo Doctor, and targeted ESLint remain green.
