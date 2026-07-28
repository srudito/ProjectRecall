# Session Sync v1 - Manual Verification

Use the `milestone1sync` branch and the existing Supabase development project.
Do not put a secret or service-role key in the mobile app.

## Preparation

1. Confirm Project Sync v1 still passes.
2. Sign in with User A.
3. Ensure at least one User A project is `Synchronized`.
4. Keep one older local session if available so schema-version-4 backfill can be
   verified without clearing Expo Go data.

## Web preview

1. Open Record Setup.
2. Select a synchronized project or choose no project.
3. Create a session named `Web Session Sync Test`.
4. In Supabase Logs Explorer, confirm a successful request to:

   ```text
   POST /rest/v1/sessions
   ```

5. In Table Editor -> sessions, verify:
   - the session row exists;
   - `id` matches the app session id;
   - `workspace_id` is User A's personal workspace;
   - `created_by` is User A's Auth UUID;
   - `project_id` is correct or null;
   - spoken-language mode and expected-language values are correct.
6. Refresh the preview and confirm the session remains visible.

## Expo Go / native local-first creation

1. Open Record Setup while online.
2. Create `Native Session Sync Test` under a synchronized project.
3. Confirm the session is created locally immediately.
4. Confirm its sync state advances through `Pending` or `Synchronizing` to
   `Synchronized`.
5. Verify the same UUID appears once in `public.sessions`.
6. Close and reopen Expo Go; confirm the session remains available.

## Project dependency ordering

1. Disable connectivity.
2. Create `Pending Parent Project`.
3. Create `Dependent Session` under that project.
4. Restore connectivity.
5. Confirm the project synchronizes first.
6. Confirm the session then synchronizes successfully.
7. Verify there is no foreign-key error and no duplicate project or session.

## Projectless session

1. Create `Projectless Session Test` with no project selected.
2. Confirm it synchronizes directly to `public.sessions` with
   `project_id = null`.

## Recording lifecycle metadata

Create a short recording and verify the same session row is updated rather than
new rows being inserted:

1. Before recording starts, verify `status = draft` may appear briefly.
2. Start recording and verify `status = recording` and `started_at` is set.
3. Pause and verify `status = paused`.
4. Resume and verify `status = recording` again.
5. Stop and verify:
   - `status = recorded`;
   - `stopped_at` is set;
   - `total_recorded_duration_ms` is greater than zero;
   - paused wall-clock time is not added to the recorded duration.
6. Confirm all updates retain the same session UUID and produce only one cloud
   row.

Because synchronization is asynchronous, refresh Table Editor between steps or
inspect the latest request in Logs Explorer.

## Offline retry

1. While signed in, disable connectivity.
2. Create `Offline Session Sync Test`.
3. Confirm it remains visible locally as `Pending`.
4. Close and reopen the app while offline; confirm it remains visible.
5. Restore connectivity and bring the app to the foreground.
6. Confirm it becomes `Synchronized` and appears once in Supabase.
7. Repeat foreground/refresh actions and confirm no duplicate row is created.

## Existing-session backfill

1. Launch the updated app without clearing existing Expo Go data.
2. Confirm local schema version 4 upgrades without a duplicate-column error.
3. Confirm an eligible older local session becomes pending and then
   synchronized.
4. If the old session belongs to a project, verify that parent project is
   synchronized first.
5. Confirm the old session appears exactly once in `public.sessions`.

## Retry UI

1. Create a controlled session sync failure, such as temporarily revoking the
   session policy in the development environment or using an invalid parent.
2. Confirm Session Detail shows `Failed` and a safe error message.
3. Restore the correct configuration.
4. Tap **Retry**.
5. Confirm the session returns to pending and eventually becomes synchronized.
6. Restore any temporarily changed development policy immediately after the
   test.

## Cloud-to-local merge

1. From Supabase Table Editor, change the title of a synchronized test session.
2. Return to the native Library or Session Detail while online.
3. Confirm the newer cloud title is merged locally.
4. Create a newer pending local update and verify an older cloud row does not
   overwrite it.

## Local deletion boundary

1. Delete a session locally.
2. Confirm it disappears from the local Library.
3. Confirm a cloud refresh does not resurrect it locally.
4. Note that the cloud row may remain because cloud-aware deletion is not part
   of Session Sync v1.

## RLS isolation

1. Sign in as User B.
2. Confirm User B cannot list User A's sessions.
3. Confirm User B cannot read a known User A session UUID.
4. Confirm User B cannot insert or upsert a session into User A's workspace.
5. Confirm User B cannot associate a session with User A's project.

## Regression checks

- Project Sync v1 still passes web, native, offline, and no-duplicate tests.
- No new request uses `anonymous` in a UUID filter.
- Notes, bookmarks, timeline events, and files remain local-only as documented.
- No secret or service-role key is present in the mobile bundle.

## Result template

```text
WEB
POST /rest/v1/sessions:
HTTP status:
Row remains after refresh:

NATIVE
Local immediate create:
Final sync state:
Same local/cloud UUID:
Survives restart:

DEPENDENCY
Project synchronized first:
Session synchronized second:
Foreign-key error:

LIFECYCLE
Draft:
Recording:
Paused:
Resumed:
Recorded:
Duration correct:
Single row only:

OFFLINE
Created offline:
Pending survives restart:
Synced after reconnect:
Duplicate row:

SECURITY
User B sees User A session:
User B can write to User A workspace:
New anonymous UUID error:
```
