# Project Sync v1 - Manual Verification


> **Historical checkpoint note:** This document describes the Project Sync v1
> boundary. Session metadata synchronization is added by Session Sync v1; see
> `SESSION_SYNC_V1_IMPLEMENTATION.md` and `SESSION_SYNC_V1_TEST.md`.

Use the `milestone1sync` branch and the existing Supabase development project.
Do not use a service-role key in the mobile application.

## Web preview

1. Sign in through the Emergent web preview.
2. Open Library -> Projects.
3. Create `Web Project Sync Test`.
4. Verify the form closes only after the cloud write succeeds.
5. In Supabase Logs Explorer, confirm a request to:

   ```text
   POST /rest/v1/projects
   ```

6. In Table Editor -> projects, verify:
   - the project row exists;
   - `workspace_id` is the signed-in user's personal workspace;
   - `created_by` is the signed-in user's auth UUID;
   - `status` is `active`.
7. Refresh the web preview and confirm the project is still listed.

## Existing local-project backfill

1. Keep at least one project created before Project Sync v1 in local SQLite.
2. Launch the updated app without clearing application data.
3. Confirm local schema version 3 upgrades successfully.
4. Confirm the earlier project changes from `Local only` to `Pending sync`, then
   becomes `Synchronized` while online.
5. Confirm the earlier project appears exactly once in `public.projects`.

## Expo Go / native local-first path

1. Sign in while online and open Library once so the real personal workspace id
   is cached.
2. Create `Native Project Sync Test`.
3. Confirm it appears immediately with `Pending sync` or `Synchronizing`.
4. Wait for it to become `Synchronized`, then verify the same UUID is present in
   Supabase `public.projects`.
5. Close and reopen Expo Go. Confirm the project remains available.

## Offline retry

1. While signed in, disable connectivity.
2. Create `Offline Project Sync Test`.
3. Confirm it remains visible locally as `Pending sync`.
4. Close and reopen the app while still offline; confirm it remains visible.
5. Restore connectivity and bring the app to the foreground.
6. Confirm the project becomes `Synchronized` and appears once in Supabase.
7. Reopen/refresh several times and confirm no duplicate cloud row is created.
8. To test explicit recovery, force a project operation into `failed`, tap
   **Retry synchronization**, and confirm it returns to `Pending sync` and then
   `Synchronized`.

## Authentication and UUID safety

1. Sign out and open Home, Library, and Record Setup.
2. Confirm no request contains:

   ```text
   owner_user_id=eq.anonymous
   ```

3. Confirm project/session creation is unavailable or reports an authentication
   requirement rather than writing the string `anonymous` into a UUID field.

## RLS isolation

1. Create a second test user.
2. Query projects using User B's authenticated client.
3. Confirm User B cannot read, update, or delete User A's project.
4. Confirm User B cannot upsert a project using User A's workspace id.

## Expected remaining limitations

This verification covers projects only. The following remain local-only or
incomplete after Project Sync v1:

- sessions;
- notes and bookmarks;
- timeline events;
- recording/media metadata;
- audio, image, video, and document upload to `session-assets`;
- cloud deletion/reconciliation for sessions and files.
