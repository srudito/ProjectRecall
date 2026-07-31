# Starred Sessions v1 Manual Test

## Prerequisites

1. Apply `0006_session_user_preferences.sql` to the development Supabase
   project.
2. Sign in with a normal application user.
3. Ensure at least three synchronized sessions are visible in Library.
4. Run the automated validation commands before manual testing.

## Basic star behavior

1. Open Library -> Sessions in Card view.
2. Tap an outline star on one session.
3. Verify it immediately becomes a filled star.
4. Tap it again.
5. Verify it immediately returns to an outline star.
6. Open the session and return to Library.
7. Verify the current state is unchanged.

Expected:

```text
No navigation occurs when the star itself is tapped.
The session card still opens when the rest of the card is tapped.
Only one preference row exists for the user/session pair.
```

## Compact view

1. Switch Sessions to Compact view.
2. Star and unstar a session.
3. Verify the icon remains accessible and does not overlap title or duration.
4. Return to Card view and verify the same state appears.

## Starred filter

1. Star two sessions.
2. Select the Starred filter.
3. Verify only those two sessions appear.
4. Unstar one while the filter is active.
5. Verify it leaves the filtered result without duplicating or moving the
   remaining session incorrectly.
6. Select All and verify all sessions return.

## Starred-first sort

1. Select All.
2. Star an older session.
3. Select Starred first.
4. Verify all starred sessions appear above unstarred sessions.
5. Verify starred sessions are newest first among themselves.
6. Verify unstarred sessions are newest first among themselves.
7. Verify no Today/Yesterday section headers are shown in this global sort.

## Offline persistence and retry

1. Open the app online once so auth and workspace data are cached.
2. Turn off Wi-Fi and mobile data.
3. Star one session and unstar another.
4. Close the app fully without uninstalling it.
5. Reopen while still offline.
6. Verify both star states remain correct.
7. Restore connectivity and bring the app to the foreground.
8. Wait for metadata synchronization.
9. Close and reopen the app.

Expected:

```text
Local star state survives restart.
Cloud synchronization completes after reconnect.
No duplicate preference row is created.
```

## Cross-device or reinstall restoration

1. Star a session and wait for synchronization.
2. Confirm the cloud row exists.
3. Sign in on another device, or reinstall the development app and sign in
   again.
4. Open Library -> Sessions.
5. Verify the same session is starred.

## User isolation

1. User A stars a session visible to User A.
2. Sign out and sign in as User B.
3. If User B cannot access the session, verify it does not appear at all.
4. If the session is intentionally shared with User B, verify User B sees an
   outline star until User B stars it independently.
5. Sign back in as User A and verify User A's original star remains.

## Session deletion

1. Star a test session.
2. Delete the session using the normal cloud-aware deletion flow.
3. Wait for cleanup to complete.
4. Verify the session is absent from Library.
5. Verify no preference row remains for that session.

## Web preview

1. Open the standalone web preview.
2. Star and unstar a session.
3. Refresh the browser.
4. Verify the state persists.
5. Verify the Starred filter and Starred-first sort match Android behavior.

## Supabase verification

Check the current user's preference rows:

```sql
select
    user_id,
    session_id,
    is_starred,
    created_at,
    updated_at
from public.session_user_preferences
order by updated_at desc;
```

Check for duplicates:

```sql
select
    user_id,
    session_id,
    count(*) as row_count
from public.session_user_preferences
group by user_id, session_id
having count(*) > 1;
```

Expected:

```text
No rows
```

## Regression

Verify:

- Projects and Sessions still scroll correctly;
- Card and Compact preferences remain independent;
- timestamp grouping and existing sort modes still work;
- search by session and project name still works;
- sync-status filters still work;
- opening a session does not toggle its star;
- tapping the star does not open the session;
- offline projects, sessions, timeline, audio, and evidence remain available;
- cloud-aware session deletion still removes the complete session graph.
