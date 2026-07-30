# Evidence Metadata + Private Storage Sync v1 Test Checklist

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
  "./app/(tabs)/profile.tsx" \
  "./src/components/SessionEvidenceAsset.tsx" \
  "./src/services/media-file-persistence.ts" \
  "./src/services/session/service.ts" \
  "./src/services/sqlite/repository.ts" \
  "./src/services/sqlite/migrations.ts" \
  "./src/services/supabase/media-asset-repository.ts" \
  "./src/services/supabase/session-assets.ts" \
  "./src/services/sync/ProjectSyncCoordinator.tsx" \
  "./src/services/sync/media-upload-worker.ts" \
  "./src/services/sync/project-sync-worker.ts" \
  "./__tests__/sqlite-migrations.test.ts" \
  "./__tests__/media-file-persistence.test.ts" \
  "./__tests__/media-asset-repository.test.ts" \
  "./__tests__/media-upload-worker.test.ts" \
  "./__tests__/media-upload-retry.test.ts" \
  "./__tests__/session-content-sync-worker.test.ts"
```

Expected:

```text
TypeScript       0 errors
Jest             all suites passed
Expo Doctor      all checks passed
Targeted ESLint  0 errors, 0 warnings
```

## Online Expo Go test

Use a synchronized project and session.

During recording:

1. Take or select one photo.
2. Select one existing video.
3. Select one PDF or DOCX document.
4. Add a note/bookmark around the same period.
5. Stop recording.
6. Open Session Detail → Evidence and Timeline.

Expected immediately:

- evidence appears locally;
- filename, size, and timeline offset are correct;
- image preview appears;
- video/document has an Open action;
- upload status moves `pending → uploading → synchronized`;
- image/video/document timeline events appear once;
- recording and note/bookmark behavior remain unchanged.

## Supabase metadata verification

```sql
select
  m.id,
  m.session_id,
  s.title,
  m.asset_type,
  m.mime_type,
  m.original_file_name,
  m.sanitized_file_name,
  m.private_storage_path,
  m.file_size,
  m.duration_ms,
  m.image_width,
  m.image_height,
  m.page_count,
  m.recording_offset_ms,
  m.upload_status,
  m.local_file_uri,
  m.upload_error_code,
  m.created_at
from public.media_assets m
join public.sessions s on s.id = m.session_id
order by m.created_at desc;
```

Expected for synchronized evidence:

```text
private_storage_path  populated
file_size              > 0
upload_status          synchronized
local_file_uri          NULL
upload_error_code       NULL
```

## Timeline verification

```sql
select
  t.id,
  t.session_id,
  t.event_type,
  t.source_entity_type,
  t.source_entity_id,
  t.recording_offset_ms,
  m.asset_type,
  m.original_file_name,
  m.upload_status
from public.timeline_events t
left join public.media_assets m on m.id = t.source_entity_id
where t.event_type in ('image_added','video_added','document_added')
order by t.created_at desc;
```

Expected:

```text
source_entity_type  media_asset
source_entity_id    matches media_assets.id
media upload        synchronized before timeline is finalized
one event per added item
```

## Storage verification

Open Dashboard:

```text
Storage → session-assets
```

Expected path:

```text
{workspace_id}/{session_id}/{asset_id}/{sanitized_file_name}
```

The bucket must remain private.

## Web restoration test

1. Open the same session in the standalone HTTPS web preview.
2. Open Evidence.
3. Verify the image preview.
4. Open the video and document securely.
5. Open Timeline.
6. Refresh the browser and repeat.

Expected:

- evidence metadata remains visible;
- image/video/document timeline rows remain visible;
- signed URLs are renewed after reload;
- no local or blob URI appears in cloud metadata.

## Offline native test

1. Open the app online once so auth/workspace are cached.
2. Disable Wi-Fi and mobile data.
3. Start a session and add a photo, video, and document.
4. Stop and open Session Detail.
5. Close and reopen Expo Go while still offline.

Expected while offline:

- session and evidence remain visible;
- image local preview works;
- video/document opens from the durable local file when supported;
- upload status remains pending;
- timeline evidence remains local and visible.

Reconnect:

```text
project/session metadata
→ evidence binary upload
→ media metadata synchronized
→ evidence timeline synchronized
```

Verify one row/object/event per item.

## Wi-Fi-only test

1. Enable `Upload over Wi-Fi only`.
2. Add evidence using mobile data only.
3. Verify status remains waiting/pending.
4. Connect Wi-Fi.

Expected: all eligible evidence uploads begin after Wi-Fi is available.

Disable Wi-Fi-only and repeat; mobile-data upload should become eligible.

## Reinstall recovery test

Use evidence confirmed as synchronized:

1. Record session title and evidence filenames.
2. Uninstall/reinstall Expo Go.
3. Sign in with the same account.
4. Open the session Evidence and Timeline tabs.

Expected:

- project/session restores;
- media metadata restores;
- image preview works through signed URL;
- video/document opens through signed URL;
- timeline events restore;
- no duplicate cloud rows or objects.

## Duplicate checks

```sql
select id, count(*)
from public.media_assets
group by id
having count(*) > 1;
```

```sql
select private_storage_path, count(*)
from public.media_assets
where private_storage_path is not null
group by private_storage_path
having count(*) > 1;
```

```sql
select source_entity_id, event_type, count(*)
from public.timeline_events
where source_entity_type = 'media_asset'
group by source_entity_id, event_type
having count(*) > 1;
```

Expected for all queries: no rows.

## User-isolation test

With User A, synchronize photo/video/document evidence. Sign in as User B.

User B must not:

- see User A's project, session, evidence, or timeline;
- read `public.media_assets` rows for User A;
- create a signed URL for User A's object path;
- download, upload, overwrite, or delete User A's evidence;
- insert media metadata into User A's workspace/session.

Use normal application sessions, not Table Editor's privileged role.

## Failure and retry

1. Add evidence online.
2. Disconnect immediately after selecting the file.
3. Verify pending/failed status with a safe message.
4. Reconnect or use Retry evidence upload.

Expected:

- same media UUID is reused;
- same Storage path is reused;
- same timeline source ID is reused;
- no duplicate row/object/event;
- final status becomes synchronized.

## Physical-device interruption check

While actively recording, open camera/picker and return.

Verify:

- recorder state is still correct;
- timer/offset remains correct;
- interruption is reported honestly if Android stopped recording;
- evidence receives the correct audio-relative offset.

This check is device-specific and should not be marked passed from web preview.

## Expected limitations

- Audio attachment picker is not exposed yet.
- Post-recording Add Evidence is not exposed yet.
- OCR, extraction, captions, page count, checksums, and thumbnails are pending.
- Large evidence uses Standard Upload rather than resumable TUS.
- Cloud-aware evidence deletion is pending.
