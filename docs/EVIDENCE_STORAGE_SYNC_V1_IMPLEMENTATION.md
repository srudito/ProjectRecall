# Evidence Metadata + Private Storage Sync v1

## Scope

This increment synchronizes image, video, and document evidence attached to a
session. It adds durable native file persistence, cloud `media_assets`
metadata, private Supabase Storage upload, evidence timeline restoration,
short-lived signed preview/download URLs, offline retry, and evidence rendering
in Session Detail.

It does **not** yet implement audio attachments, OCR, document extraction,
image understanding, video transcription, cloud-aware evidence deletion, or
resumable uploads.

## End-to-end flow

### Android/iOS

1. The user takes/selects a photo, selects a video, or selects a document while
   recording.
2. The selected file is validated against configured MIME and size limits.
3. The file is copied from picker/cache storage into the durable application
   document directory:
   `sessions/{session_id}/assets/{asset_id}_{sanitized_file_name}`.
4. In one SQLite transaction the app writes:
   - `local_media_assets` metadata;
   - one `local_upload_queue` operation;
   - one `local_timeline_events` row;
   - one timeline metadata-sync queue operation.
5. The metadata worker synchronizes the parent session first.
6. The evidence upload worker uploads the binary file to private
   `session-assets` Storage.
7. The same UUID is upserted into `public.media_assets`.
8. The timeline worker synchronizes `image_added`, `video_added`, or
   `document_added` only after the source media asset is synchronized.
9. Session Detail restores evidence and timeline data from Supabase after
   reinstall or on another client.

### Web

Browser picker URLs are temporary, so the web path uploads immediately:

1. Read the selected blob URL and validate its actual size.
2. Upsert an `uploading` row in `public.media_assets`.
3. Upload the blob to private Storage.
4. Upsert the same row as `synchronized`.
5. Upsert the associated timeline event.
6. Display images through a signed URL and open videos/documents through a
   short-lived secure URL.

## Storage path

```text
{workspace_id}/{session_id}/{asset_id}/{sanitized_file_name}
```

Example:

```text
8f.../4a.../7d.../pump_seal.jpg
```

The bucket remains private. Neither a permanent public URL nor a native
`file://`/browser `blob:` URI is stored in PostgreSQL.

## Supported evidence in this increment

Images:

- JPEG
- PNG
- WEBP

Videos:

- MP4
- QuickTime/MOV where the picker reports `video/quicktime`

Documents:

- PDF
- DOCX
- TXT
- Markdown

The limits remain centralized in `src/config/limits.ts`:

- image: 25 MB
- video: 500 MB
- document: 100 MB

## Local schema version 7

Version 7:

- adds evidence upload/query indexes;
- computes a stable private Storage path for existing local evidence;
- changes eligible local-only/failed evidence to pending;
- backfills `local_upload_queue` using
  `upload:media_asset:{media_asset_id}`;
- makes image/video/document timeline events pending;
- backfills timeline metadata operations with `media_asset` as the source
  dependency and priority 500.

No new Supabase SQL migration is required. The existing cloud schema already
contains:

- `public.media_assets`;
- `public.timeline_events` event types for image/video/document;
- workspace-scoped RLS policies;
- private `session-assets` Storage policies.

Do not rerun cloud migrations 0001-0004.

## Main files

- `src/services/media-file-persistence.ts`
- `src/services/supabase/media-asset-repository.ts`
- `src/services/sync/media-upload-worker.ts`
- `src/components/SessionEvidenceAsset.tsx`
- `src/services/session/service.ts`
- `src/services/sqlite/repository.ts`
- `src/services/sqlite/migrations.ts`
- `src/services/sync/project-sync-worker.ts`
- `src/services/sync/ProjectSyncCoordinator.tsx`
- `app/record/active.tsx`
- `app/session/[id].tsx`

## Worker ordering

```text
Project metadata      priority 100
Session metadata      priority 200
Note/Bookmark         priority 300
Lifecycle timeline    priority 400
Evidence timeline     priority 500
```

Binary upload uses the separate durable `local_upload_queue`. Evidence timeline
metadata waits until:

```text
parent session synchronized
AND source media asset upload_status = synchronized
```

This prevents a timeline row from referencing evidence that is not yet
available in cloud metadata.

## Queue and retry behavior

The native evidence worker:

- processes only `source_entity_type = media_asset`;
- is mutually exclusive;
- is scoped to the currently authenticated user;
- runs after authentication, app foreground, network reconnect, new upload
  work, Wi-Fi preference changes, and metadata-sync changes;
- honors the `upload.wifiOnly` preference;
- waits for the parent session;
- retries transient failures with exponential backoff;
- stops retrying permanent RLS, schema, validation, and missing-file failures;
- reuses the same asset UUID, idempotency key, and Storage path;
- does not fabricate byte-level upload percentage.

## Evidence display and restoration

Session Detail Evidence:

- renders image evidence inline;
- shows filename, file size, recording offset, caption, and upload status;
- opens videos and documents through local OS handlers or short-lived signed
  URLs;
- offers manual retry after a failed native upload when the local file still
  exists.

Native source priority:

```text
durable local file
→ short-lived signed cloud URL
```

Web source:

```text
short-lived signed cloud URL
```

After reinstall, local files may be gone, but synchronized metadata and private
files are restored from Supabase.

## Security properties

- Upload uses the signed-in user's access token and publishable/anon key.
- No service-role key is used by the mobile or web client.
- Storage RLS validates workspace membership using the first path segment.
- Cloud `media_assets.local_file_uri` is always `NULL`.
- Signed URLs are generated on demand and are not persisted.
- The worker refuses queue rows owned by another user.
- User B cannot create a signed URL, read metadata, upload, overwrite, or delete
  under User A's workspace when RLS policies are working.

## Known limitations

- `audio_attachment` is present in the schema but not exposed by the current
  Add Evidence UI.
- Evidence can currently be added from the active recording screen; a
  post-recording Add Evidence action is a later UI increment.
- Camera/media picker use may interrupt recording on some physical devices;
  this requires device-specific verification.
- Existing evidence lost before synchronization cannot be recovered after an
  Expo Go uninstall or application-data reset.
- Standard Upload is used. Large videos/documents should later move to
  resumable TUS upload for stronger recovery on unstable networks.
- Browser blob upload cannot resume after page reload.
- SHA-256 checksum, page-count extraction, thumbnails, OCR, and AI captions are
  not implemented yet.
- Cloud-aware evidence delete/cancel is deferred to the deletion milestone.
- Numeric upload progress is not available.
