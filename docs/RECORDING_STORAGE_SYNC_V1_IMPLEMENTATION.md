# Recording Metadata + Private Audio Storage Sync v1

## Scope

This increment synchronizes the primary audio recording for each session. It
adds durable local file persistence, a native upload queue worker, cloud
recording metadata, private Supabase Storage upload, short-lived signed playback
URLs, and playback in Session Overview.

It does **not** yet upload photos, videos, documents, or audio attachments.
Cloud-aware delete/cancel is also deferred to the deletion milestone.

## End-to-end flow

### Android/iOS

1. `expo-audio` stops and returns a cache file URI.
2. The file is copied into the application document directory:
   `sessions/{session_id}/recordings/{recording_file}`.
3. One stable `RecordingRecord` is written to `local_recordings`.
4. One idempotent operation is written to `local_upload_queue`.
5. The session metadata worker synchronizes the parent session first.
6. The recording upload worker uploads the file to the private
   `session-assets` bucket.
7. The worker upserts `public.recordings` using the same recording UUID.
8. Local metadata becomes `synchronized` and the queue operation is removed.

### Web

Browser blob URLs do not survive a reload. Web therefore uploads immediately:

1. Read the blob URL.
2. Upsert an `uploading` row in `public.recordings`.
3. Upload the blob to private Storage.
4. Upsert the row as `synchronized`.
5. Session Overview requests a short-lived signed playback URL.

## Storage path

```text
{workspace_id}/{session_id}/{recording_id}/{generated_file_name}
```

Example:

```text
8f.../4a.../7d.../recording-7d....m4a
```

The bucket remains private. No permanent public URL is stored in PostgreSQL.

## Local schema version 6

Version 6 adds indexes needed by recording upload and backfills eligible
existing `local_recordings` rows into `local_upload_queue`.

No new Supabase SQL migration is required because the existing cloud schema
already contains:

- `public.recordings`
- RLS policy `recordings_member_all`
- private bucket `session-assets`
- Storage select/insert/update/delete policies

Do not rerun cloud migrations 0001-0004.

## Main files

- `src/services/recording/file-persistence.ts`
- `src/services/supabase/recording-repository.ts`
- `src/services/supabase/session-assets.ts`
- `src/services/sync/recording-upload-worker.ts`
- `src/components/SessionRecordingPanel.tsx`
- `src/services/session/service.ts`
- `src/services/sqlite/repository.ts`
- `src/services/sqlite/migrations.ts`
- `app/record/active.tsx`
- `app/session/[id].tsx`

## Queue behavior

The native worker:

- is mutually exclusive;
- runs after authentication, foreground activation, network reconnect, new
  queue work, and metadata-sync changes;
- honors the `upload.wifiOnly` preference;
- waits for the parent session to become synchronized;
- retries transient failures with exponential backoff;
- stops retrying permanent RLS, schema, missing-file, and validation failures;
- never stores API keys in SQLite;
- never fabricates upload percentage.

## Playback source priority

Native Session Overview uses:

1. durable local document file when it still exists;
2. otherwise a short-lived signed Storage URL.

Web uses a signed URL.

## Security properties

- Mobile upload uses the authenticated user's access token and public
  publishable/anon key.
- No service-role key is used by the app.
- Storage RLS checks the workspace UUID in the first path segment.
- Device-specific `file://` and browser `blob:` URIs are never persisted in
  cloud recording rows.
- Signed URLs are generated on demand and are not stored permanently.

## Known limitations

- Existing audio created before this feature is recoverable only when a local
  `local_recordings` row and file still exist.
- A failed browser upload cannot be resumed after reload because the blob URL
  is ephemeral.
- Upload progress is indeterminate.
- The v1 worker uses Supabase Standard Upload. It can accept larger files, but Supabase recommends resumable TUS uploads for files above 6 MB or unstable networks; that upgrade is deferred to a later hardening increment.
- SHA-256 checksums remain optional/null.
- Audio delete from Storage is not yet wired into session deletion.
- Photo/video/document storage is a later increment.
- Background recording configuration requires a development/release build to
  verify fully; Expo Go does not exercise all config-plugin behavior.
