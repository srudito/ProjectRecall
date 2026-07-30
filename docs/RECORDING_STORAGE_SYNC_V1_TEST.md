# Recording Metadata + Private Audio Storage Sync v1 Test Checklist

## Automated validation

Run from `frontend`:

```bash
npx tsc --noEmit
npx jest
npx expo-doctor
```

Targeted lint:

```bash
npx eslint \
  "./app/record/active.tsx" \
  "./app/session/[id].tsx" \
  "./src/components/SessionRecordingPanel.tsx" \
  "./src/services/recording/controller.ts" \
  "./src/services/recording/file-persistence.ts" \
  "./src/services/session/service.ts" \
  "./src/services/sqlite/repository.ts" \
  "./src/services/sqlite/migrations.ts" \
  "./src/services/supabase/recording-repository.ts" \
  "./src/services/supabase/session-assets.ts" \
  "./src/services/sync/ProjectSyncCoordinator.tsx" \
  "./src/services/sync/recording-upload-worker.ts" \
  "./__tests__/sqlite-migrations.test.ts" \
  "./__tests__/recording-file-persistence.test.ts" \
  "./__tests__/recording-repository.test.ts" \
  "./__tests__/recording-upload-worker.test.ts"
```

Expected:

```text
TypeScript       0 errors
Jest             all suites passed
Expo Doctor      all checks passed
Targeted ESLint  0 errors, 0 warnings
```

## Expo Go online test

1. Sign in over Wi-Fi.
2. Create/select a synchronized project.
3. Record 10-20 seconds, including Pause and Resume.
4. Stop.
5. Open Session Overview.

Expected:

- session becomes `recorded`;
- Recording card appears;
- local playback works immediately;
- recording status moves `pending -> uploading -> synchronized`;
- one row appears in `public.recordings`;
- one object appears in `session-assets`;
- Play/Pause works;
- no duplicate recording row or object.

## Supabase verification

```sql
select
  r.id,
  r.session_id,
  s.title,
  r.private_storage_path,
  r.mime_type,
  r.file_size,
  r.duration_ms,
  r.upload_status,
  r.upload_error_code,
  r.created_at,
  r.updated_at
from public.recordings r
join public.sessions s on s.id = r.session_id
order by r.created_at desc;
```

Expected:

```text
private_storage_path  populated
file_size              > 0 where the platform reports it
recording duration     > 0
upload_status          synchronized
upload_error_code      null
```

Check Storage in Dashboard:

```text
session-assets/{workspace_id}/{session_id}/{recording_id}/...
```

## Web test

1. Open the standalone HTTPS preview.
2. Allow microphone.
3. Record and stop.
4. Open Session Overview.
5. Play the cloud audio.
6. Refresh and play again.

Expected:

- `public.recordings` row is synchronized;
- private object exists;
- playback works via a newly generated signed URL;
- blob URL is not stored in cloud metadata.

## Offline native test

1. Open once online so authentication/workspace are cached.
2. Turn off Wi-Fi and mobile data.
3. Record and stop.
4. Open Session Overview.
5. Close and reopen Expo Go while still offline.

Expected while offline:

- session and Recording card remain visible;
- local audio plays;
- upload status remains pending;
- file survives app restart;
- no cloud row/object is required yet.

Reconnect:

1. Enable network.
2. Bring app to foreground.
3. Wait for project/session metadata, then recording upload.

Expected:

- session synchronizes before recording upload;
- recording becomes synchronized;
- one cloud row and one object exist;
- local playback still works.

## Wi-Fi-only test

1. Enable `Upload over Wi-Fi only` in Profile.
2. Record while using mobile data only.
3. Verify status remains pending.
4. Connect to Wi-Fi.

Expected: upload begins only after Wi-Fi is available.

Then disable Wi-Fi-only and repeat on mobile data; upload should become eligible.

## Reinstall recovery test

Use only a recording confirmed as synchronized:

1. Uninstall/reinstall Expo Go.
2. Reopen the same project and sign in.
3. Open the session.
4. Play the recording.

Expected:

- local SQLite and file may be gone;
- session and recording metadata restore from Supabase;
- playback works through a signed private URL.

## Duplicate checks

```sql
select session_id, count(*)
from public.recordings
group by session_id
having count(*) > 1;
```

Expected: no rows.

Storage should contain one primary recording object per tested session.

## User-isolation test

With User A, create and synchronize a recording. With User B:

- User B must not read User A's recording metadata.
- User B must not obtain a signed URL for User A's path.
- User B must not download, overwrite, or delete User A's object.
- User B must not upload under User A's workspace path.

Use the normal client session, not Table Editor's privileged role.

## Failure/retry test

1. Record online.
2. Disconnect network immediately after Stop.
3. Confirm status is pending or failed with a safe message.
4. Reconnect and use automatic/manual retry.

Expected:

- same recording UUID is reused;
- same Storage path is reused;
- no duplicate row/object;
- final status is synchronized.

## Expected limitations

- Recording upload v1 uses Standard Upload; test with short recordings first. Files above 6 MB should later move to resumable TUS upload for stronger reliability.
- No binary evidence upload yet.
- No cloud-aware recording deletion yet.
- No real numeric upload percentage.
- Background recording and foreground notification require development-build
  verification.
