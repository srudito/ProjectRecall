// Local SQLite migration engine.
//
// Uses SQLite's built-in PRAGMA user_version as the authoritative schema
// version marker. Each migration knows its target version and its `up` runs
// inside a transaction. `PRAGMA user_version` is updated within that same
// transaction, so it advances only when the transaction commits and an
// interrupted upgrade replays cleanly on the next launch.
//
// The local_meta table's "schema_version" row is retained for diagnostics but
// is NEVER used to gate migrations — user_version is the source of truth.

import type { SQLiteDatabase } from "expo-sqlite";

export interface MigrationContext {
  db: MinimalDb;
}

export interface Migration {
  version: number;
  description: string;
  up: (ctx: MigrationContext) => Promise<void>;
}

// A narrow interface so we can unit-test the runner with a hand-built fake.
export type MinimalDb = Pick<
  SQLiteDatabase,
  "execAsync" | "runAsync" | "getFirstAsync" | "withTransactionAsync"
>;

// -------------------------------------------------------------------------
// Migration definitions
// -------------------------------------------------------------------------

const v1BaselineDdl: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS local_profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    app_language TEXT NOT NULL DEFAULT 'en',
    default_spoken_language_mode TEXT NOT NULL DEFAULT 'AUTO_DETECT',
    default_expected_spoken_languages TEXT NOT NULL DEFAULT '[]',
    default_summary_output_language TEXT NOT NULL DEFAULT 'en',
    default_translation_target_language TEXT,
    preserve_original_language INTEGER NOT NULL DEFAULT 1,
    prefer_bilingual_view INTEGER NOT NULL DEFAULT 0,
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
    workspace_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    default_spoken_language_mode TEXT,
    default_expected_spoken_languages TEXT,
    default_summary_output_language TEXT,
    default_translation_target_language TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS local_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    created_by TEXT NOT NULL,
    title TEXT NOT NULL,
    session_type TEXT NOT NULL DEFAULT 'standard',
    status TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT,
    total_recorded_duration_ms INTEGER NOT NULL DEFAULT 0,
    spoken_language_mode TEXT NOT NULL DEFAULT 'AUTO_DETECT',
    expected_spoken_languages TEXT NOT NULL DEFAULT '[]',
    detected_spoken_languages TEXT NOT NULL DEFAULT '[]',
    primary_detected_language TEXT,
    language_detection_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
    summary_output_language TEXT,
    translation_target_language TEXT,
    transcript_display_mode TEXT NOT NULL DEFAULT 'ORIGINAL',
    language_metadata TEXT,
    local_sync_status TEXT NOT NULL DEFAULT 'local_only',
    cloud_sync_status TEXT NOT NULL DEFAULT 'local_only',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS local_recordings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL,
    local_file_uri TEXT,
    private_storage_path TEXT,
    mime_type TEXT NOT NULL,
    original_file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    recording_format TEXT NOT NULL,
    checksum_sha256 TEXT,
    upload_status TEXT NOT NULL DEFAULT 'local_only',
    upload_error_code TEXT,
    upload_error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_media_assets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL,
    added_by TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    original_file_name TEXT NOT NULL,
    sanitized_file_name TEXT NOT NULL,
    local_file_uri TEXT,
    private_storage_path TEXT,
    file_size INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    image_width INTEGER,
    image_height INTEGER,
    page_count INTEGER,
    captured_at TEXT,
    recording_offset_ms INTEGER NOT NULL DEFAULT 0,
    user_caption TEXT,
    checksum_sha256 TEXT,
    upload_status TEXT NOT NULL DEFAULT 'local_only',
    upload_error_code TEXT,
    upload_error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS local_notes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    recording_offset_ms INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS local_bookmarks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL,
    label TEXT NOT NULL,
    recording_offset_ms INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS local_timeline_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    source_entity_type TEXT,
    source_entity_id TEXT,
    recording_offset_ms INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_upload_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_entity_type TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    local_file_uri TEXT NOT NULL,
    target_storage_path TEXT NOT NULL,
    queue_status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    last_error_code TEXT,
    last_safe_error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_user_preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project ON local_sessions(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_status ON local_sessions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_session ON local_notes(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_session ON local_bookmarks(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_session ON local_media_assets(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON local_timeline_events(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_queue_status ON local_upload_queue(queue_status)`,
];

// Version 2: add project sync columns and metadata sync queue.
// Uses ALTER TABLE ADD COLUMN — safe on SQLite and preserves existing rows.
const v2Ddl: readonly string[] = [
  `ALTER TABLE local_projects ADD COLUMN local_sync_status TEXT NOT NULL DEFAULT 'local_only'`,
  `ALTER TABLE local_projects ADD COLUMN cloud_sync_status TEXT NOT NULL DEFAULT 'not_started'`,
  `ALTER TABLE local_projects ADD COLUMN last_sync_error_code TEXT`,
  `ALTER TABLE local_projects ADD COLUMN last_sync_error_message TEXT`,
  `ALTER TABLE local_projects ADD COLUMN last_synced_at TEXT`,
  `CREATE TABLE IF NOT EXISTS local_metadata_sync_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    parent_entity_type TEXT,
    parent_entity_id TEXT,
    priority INTEGER NOT NULL DEFAULT 100,
    queue_status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    last_error_code TEXT,
    last_safe_error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_meta_queue_status_next ON local_metadata_sync_queue(queue_status, next_retry_at, priority, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_meta_queue_entity ON local_metadata_sync_queue(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_meta_queue_workspace ON local_metadata_sync_queue(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_workspace_status ON local_projects(workspace_id, status, deleted_at)`,
];

// Version 3: backfill project sync work for projects created before the
// project metadata worker existed. Version 2 added the columns/queue but did
// not enqueue pre-existing rows, so those projects would otherwise remain
// local forever.
const v3Ddl: readonly string[] = [
  `UPDATE local_projects
      SET local_sync_status = 'pending',
          cloud_sync_status = 'pending',
          last_sync_error_code = NULL,
          last_sync_error_message = NULL
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND (local_sync_status <> 'synchronized'
           OR cloud_sync_status <> 'synchronized')`,
  `INSERT INTO local_metadata_sync_queue
      (id, user_id, workspace_id, entity_type, entity_id, operation,
       parent_entity_type, parent_entity_id, priority, queue_status,
       attempt_count, next_retry_at, last_error_code, last_safe_error,
       idempotency_key, created_at, updated_at)
    SELECT 'project-upsert:' || id,
           created_by,
           workspace_id,
           'project',
           id,
           'UPSERT',
           NULL,
           NULL,
           100,
           'pending',
           0,
           NULL,
           NULL,
           NULL,
           'upsert:project:' || id,
           created_at,
           updated_at
      FROM local_projects
     WHERE deleted_at IS NULL
       AND status = 'active'
       AND (local_sync_status <> 'synchronized'
            OR cloud_sync_status <> 'synchronized')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      queue_status = 'pending',
      attempt_count = 0,
      next_retry_at = NULL,
      last_error_code = NULL,
      last_safe_error = NULL,
      updated_at = excluded.updated_at`,
];


// Version 4: add durable session synchronization diagnostics and enqueue
// existing local sessions behind their parent projects.
const v4Ddl: readonly string[] = [
  `ALTER TABLE local_sessions ADD COLUMN last_sync_error_code TEXT`,
  `ALTER TABLE local_sessions ADD COLUMN last_sync_error_message TEXT`,
  `ALTER TABLE local_sessions ADD COLUMN last_synced_at TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_workspace_sync ON local_sessions(workspace_id, local_sync_status, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_meta_queue_parent ON local_metadata_sync_queue(parent_entity_type, parent_entity_id, queue_status)`,
  `UPDATE local_sessions
      SET local_sync_status = 'pending',
          cloud_sync_status = 'pending',
          last_sync_error_code = NULL,
          last_sync_error_message = NULL
    WHERE deleted_at IS NULL
      AND status <> 'deleting'
      AND (local_sync_status <> 'synchronized'
           OR cloud_sync_status <> 'synchronized')`,
  `INSERT INTO local_metadata_sync_queue
      (id, user_id, workspace_id, entity_type, entity_id, operation,
       parent_entity_type, parent_entity_id, priority, queue_status,
       attempt_count, next_retry_at, last_error_code, last_safe_error,
       idempotency_key, created_at, updated_at)
    SELECT 'session-upsert:' || id,
           created_by,
           workspace_id,
           'session',
           id,
           'UPSERT',
           CASE WHEN project_id IS NULL THEN NULL ELSE 'project' END,
           project_id,
           200,
           'pending',
           0,
           NULL,
           NULL,
           NULL,
           'upsert:session:' || id,
           created_at,
           updated_at
      FROM local_sessions
     WHERE deleted_at IS NULL
       AND status <> 'deleting'
       AND (local_sync_status <> 'synchronized'
            OR cloud_sync_status <> 'synchronized')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      parent_entity_type = excluded.parent_entity_type,
      parent_entity_id = excluded.parent_entity_id,
      priority = excluded.priority,
      queue_status = 'pending',
      attempt_count = 0,
      next_retry_at = NULL,
      last_error_code = NULL,
      last_safe_error = NULL,
      updated_at = excluded.updated_at`,
];


// Version 5: synchronize notes, bookmarks, and supported timeline events.
// Media-related timeline events remain local-only until media metadata and
// binary Storage synchronization are implemented.
const v5Ddl: readonly string[] = [
  `ALTER TABLE local_notes ADD COLUMN local_sync_status TEXT NOT NULL DEFAULT 'local_only'`,
  `ALTER TABLE local_notes ADD COLUMN cloud_sync_status TEXT NOT NULL DEFAULT 'not_started'`,
  `ALTER TABLE local_notes ADD COLUMN last_sync_error_code TEXT`,
  `ALTER TABLE local_notes ADD COLUMN last_sync_error_message TEXT`,
  `ALTER TABLE local_notes ADD COLUMN last_synced_at TEXT`,
  `ALTER TABLE local_bookmarks ADD COLUMN local_sync_status TEXT NOT NULL DEFAULT 'local_only'`,
  `ALTER TABLE local_bookmarks ADD COLUMN cloud_sync_status TEXT NOT NULL DEFAULT 'not_started'`,
  `ALTER TABLE local_bookmarks ADD COLUMN last_sync_error_code TEXT`,
  `ALTER TABLE local_bookmarks ADD COLUMN last_sync_error_message TEXT`,
  `ALTER TABLE local_bookmarks ADD COLUMN last_synced_at TEXT`,
  `ALTER TABLE local_timeline_events ADD COLUMN local_sync_status TEXT NOT NULL DEFAULT 'local_only'`,
  `ALTER TABLE local_timeline_events ADD COLUMN cloud_sync_status TEXT NOT NULL DEFAULT 'not_started'`,
  `ALTER TABLE local_timeline_events ADD COLUMN last_sync_error_code TEXT`,
  `ALTER TABLE local_timeline_events ADD COLUMN last_sync_error_message TEXT`,
  `ALTER TABLE local_timeline_events ADD COLUMN last_synced_at TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_notes_workspace_sync ON local_notes(workspace_id, local_sync_status, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_workspace_sync ON local_bookmarks(workspace_id, local_sync_status, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_timeline_workspace_sync ON local_timeline_events(workspace_id, local_sync_status, event_type)`,
  `UPDATE local_notes
      SET local_sync_status = 'pending',
          cloud_sync_status = 'pending',
          last_sync_error_code = NULL,
          last_sync_error_message = NULL
    WHERE deleted_at IS NULL
      AND (local_sync_status <> 'synchronized'
           OR cloud_sync_status <> 'synchronized')`,
  `UPDATE local_bookmarks
      SET local_sync_status = 'pending',
          cloud_sync_status = 'pending',
          last_sync_error_code = NULL,
          last_sync_error_message = NULL
    WHERE deleted_at IS NULL
      AND (local_sync_status <> 'synchronized'
           OR cloud_sync_status <> 'synchronized')`,
  `UPDATE local_timeline_events
      SET local_sync_status = 'pending',
          cloud_sync_status = 'pending',
          last_sync_error_code = NULL,
          last_sync_error_message = NULL
    WHERE event_type IN (
      'recording_started','recording_paused','recording_resumed',
      'recording_stopped','bookmark_added','note_added'
    )
      AND (local_sync_status <> 'synchronized'
           OR cloud_sync_status <> 'synchronized')`,
  `INSERT INTO local_metadata_sync_queue
      (id, user_id, workspace_id, entity_type, entity_id, operation,
       parent_entity_type, parent_entity_id, priority, queue_status,
       attempt_count, next_retry_at, last_error_code, last_safe_error,
       idempotency_key, created_at, updated_at)
    SELECT 'note-upsert:' || id,
           created_by,
           workspace_id,
           'note',
           id,
           'UPSERT',
           'session',
           session_id,
           300,
           'pending',
           0,
           NULL,
           NULL,
           NULL,
           'upsert:note:' || id,
           created_at,
           updated_at
      FROM local_notes
     WHERE deleted_at IS NULL
       AND (local_sync_status <> 'synchronized'
            OR cloud_sync_status <> 'synchronized')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      parent_entity_type = excluded.parent_entity_type,
      parent_entity_id = excluded.parent_entity_id,
      priority = excluded.priority,
      queue_status = 'pending',
      attempt_count = 0,
      next_retry_at = NULL,
      last_error_code = NULL,
      last_safe_error = NULL,
      updated_at = excluded.updated_at`,
  `INSERT INTO local_metadata_sync_queue
      (id, user_id, workspace_id, entity_type, entity_id, operation,
       parent_entity_type, parent_entity_id, priority, queue_status,
       attempt_count, next_retry_at, last_error_code, last_safe_error,
       idempotency_key, created_at, updated_at)
    SELECT 'bookmark-upsert:' || id,
           created_by,
           workspace_id,
           'bookmark',
           id,
           'UPSERT',
           'session',
           session_id,
           300,
           'pending',
           0,
           NULL,
           NULL,
           NULL,
           'upsert:bookmark:' || id,
           created_at,
           updated_at
      FROM local_bookmarks
     WHERE deleted_at IS NULL
       AND (local_sync_status <> 'synchronized'
            OR cloud_sync_status <> 'synchronized')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      parent_entity_type = excluded.parent_entity_type,
      parent_entity_id = excluded.parent_entity_id,
      priority = excluded.priority,
      queue_status = 'pending',
      attempt_count = 0,
      next_retry_at = NULL,
      last_error_code = NULL,
      last_safe_error = NULL,
      updated_at = excluded.updated_at`,
  `INSERT INTO local_metadata_sync_queue
      (id, user_id, workspace_id, entity_type, entity_id, operation,
       parent_entity_type, parent_entity_id, priority, queue_status,
       attempt_count, next_retry_at, last_error_code, last_safe_error,
       idempotency_key, created_at, updated_at)
    SELECT 'timeline-upsert:' || id,
           created_by,
           workspace_id,
           'timeline_event',
           id,
           'UPSERT',
           CASE
             WHEN source_entity_type = 'note' THEN 'note'
             WHEN source_entity_type = 'bookmark' THEN 'bookmark'
             ELSE 'session'
           END,
           CASE
             WHEN source_entity_type IN ('note','bookmark') THEN source_entity_id
             ELSE session_id
           END,
           400,
           'pending',
           0,
           NULL,
           NULL,
           NULL,
           'upsert:timeline_event:' || id,
           created_at,
           created_at
      FROM local_timeline_events
     WHERE event_type IN (
       'recording_started','recording_paused','recording_resumed',
       'recording_stopped','bookmark_added','note_added'
     )
       AND (local_sync_status <> 'synchronized'
            OR cloud_sync_status <> 'synchronized')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      parent_entity_type = excluded.parent_entity_type,
      parent_entity_id = excluded.parent_entity_id,
      priority = excluded.priority,
      queue_status = 'pending',
      attempt_count = 0,
      next_retry_at = NULL,
      last_error_code = NULL,
      last_safe_error = NULL,
      updated_at = excluded.updated_at`,
];


// Version 6: durable recording metadata and private Storage upload queue.
const v6Ddl: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_session_unique ON local_recordings(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recordings_workspace_upload ON local_recordings(workspace_id, upload_status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_upload_queue_next ON local_upload_queue(queue_status, next_retry_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_upload_queue_entity ON local_upload_queue(source_entity_type, source_entity_id)`,
  `UPDATE local_recordings
      SET upload_status = 'pending',
          upload_error_code = NULL,
          upload_error_message = NULL
    WHERE local_file_uri IS NOT NULL
      AND upload_status IN ('local_only','failed')`,
  `INSERT INTO local_upload_queue
      (id, user_id, workspace_id, session_id, source_entity_type,
       source_entity_id, local_file_uri, target_storage_path, queue_status,
       attempt_count, next_retry_at, last_error_code, last_safe_error,
       idempotency_key, created_at, updated_at)
    SELECT 'recording-upload:' || r.id,
           s.created_by,
           r.workspace_id,
           r.session_id,
           'recording',
           r.id,
           r.local_file_uri,
           r.workspace_id || '/' || r.session_id || '/' || r.id || '/' || r.original_file_name,
           'pending',
           0,
           NULL,
           NULL,
           NULL,
           'upload:recording:' || r.id,
           r.created_at,
           r.updated_at
      FROM local_recordings r
      JOIN local_sessions s ON s.id = r.session_id
     WHERE r.local_file_uri IS NOT NULL
       AND r.upload_status IN ('pending','local_only','failed')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      local_file_uri = excluded.local_file_uri,
      target_storage_path = excluded.target_storage_path,
      queue_status = 'pending',
      attempt_count = 0,
      next_retry_at = NULL,
      last_error_code = NULL,
      last_safe_error = NULL,
      updated_at = excluded.updated_at`,
];

// Version 7: media evidence metadata, private Storage queue, and timeline sync.
const v7Ddl: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_media_workspace_upload ON local_media_assets(workspace_id, upload_status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_media_session_offset ON local_media_assets(session_id, recording_offset_ms, created_at)`,
  `UPDATE local_media_assets
      SET private_storage_path = COALESCE(
            private_storage_path,
            workspace_id || '/' || session_id || '/' || id || '/' || sanitized_file_name
          ),
          upload_status = CASE
            WHEN local_file_uri IS NOT NULL AND upload_status IN ('local_only','failed') THEN 'pending'
            ELSE upload_status
          END,
          upload_error_code = CASE
            WHEN local_file_uri IS NOT NULL AND upload_status IN ('local_only','failed') THEN NULL
            ELSE upload_error_code
          END,
          upload_error_message = CASE
            WHEN local_file_uri IS NOT NULL AND upload_status IN ('local_only','failed') THEN NULL
            ELSE upload_error_message
          END
    WHERE deleted_at IS NULL`,
  `INSERT INTO local_upload_queue
      (id, user_id, workspace_id, session_id, source_entity_type,
       source_entity_id, local_file_uri, target_storage_path, queue_status,
       attempt_count, next_retry_at, last_error_code, last_safe_error,
       idempotency_key, created_at, updated_at)
    SELECT 'media-upload:' || id,
           added_by,
           workspace_id,
           session_id,
           'media_asset',
           id,
           local_file_uri,
           COALESCE(
             private_storage_path,
             workspace_id || '/' || session_id || '/' || id || '/' || sanitized_file_name
           ),
           'pending',
           0,
           NULL,
           NULL,
           NULL,
           'upload:media_asset:' || id,
           created_at,
           updated_at
      FROM local_media_assets
     WHERE deleted_at IS NULL
       AND local_file_uri IS NOT NULL
       AND upload_status IN ('pending','local_only','failed')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      local_file_uri = excluded.local_file_uri,
      target_storage_path = excluded.target_storage_path,
      queue_status = 'pending',
      attempt_count = 0,
      next_retry_at = NULL,
      last_error_code = NULL,
      last_safe_error = NULL,
      updated_at = excluded.updated_at`,
  `UPDATE local_timeline_events
      SET local_sync_status = 'pending',
          cloud_sync_status = 'pending',
          last_sync_error_code = NULL,
          last_sync_error_message = NULL
    WHERE event_type IN ('image_added','video_added','document_added')
      AND source_entity_type = 'media_asset'
      AND source_entity_id IS NOT NULL
      AND (local_sync_status <> 'synchronized'
           OR cloud_sync_status <> 'synchronized')`,
  `INSERT INTO local_metadata_sync_queue
      (id, user_id, workspace_id, entity_type, entity_id, operation,
       parent_entity_type, parent_entity_id, priority, queue_status,
       attempt_count, next_retry_at, last_error_code, last_safe_error,
       idempotency_key, created_at, updated_at)
    SELECT 'timeline-upsert:' || id,
           created_by,
           workspace_id,
           'timeline_event',
           id,
           'UPSERT',
           'media_asset',
           source_entity_id,
           500,
           'pending',
           0,
           NULL,
           NULL,
           NULL,
           'upsert:timeline_event:' || id,
           created_at,
           created_at
      FROM local_timeline_events
     WHERE event_type IN ('image_added','video_added','document_added')
       AND source_entity_type = 'media_asset'
       AND source_entity_id IS NOT NULL
       AND (local_sync_status <> 'synchronized'
            OR cloud_sync_status <> 'synchronized')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      parent_entity_type = excluded.parent_entity_type,
      parent_entity_id = excluded.parent_entity_id,
      priority = excluded.priority,
      queue_status = 'pending',
      attempt_count = 0,
      next_retry_at = NULL,
      last_error_code = NULL,
      last_safe_error = NULL,
      updated_at = excluded.updated_at`,
];

// Version 8: durable cloud-aware session deletion and orphan cleanup queue.
const v8Ddl: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS local_session_deletion_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    queue_status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    storage_paths TEXT NOT NULL DEFAULT '[]',
    local_file_uris TEXT NOT NULL DEFAULT '[]',
    storage_deleted INTEGER NOT NULL DEFAULT 0,
    cloud_metadata_deleted INTEGER NOT NULL DEFAULT 0,
    local_files_deleted INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    last_safe_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_delete_next
     ON local_session_deletion_queue(queue_status, next_retry_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_session_delete_user
     ON local_session_deletion_queue(user_id, queue_status)`,
  `UPDATE local_upload_queue
      SET queue_status = 'cancelled',
          updated_at = CURRENT_TIMESTAMP
    WHERE session_id IN (
      SELECT id FROM local_sessions WHERE deleted_at IS NOT NULL
    )
      AND queue_status IN ('pending','in_progress','failed')`,
  `INSERT INTO local_session_deletion_queue
      (id, user_id, workspace_id, session_id, queue_status, attempt_count,
       next_retry_at, storage_paths, local_file_uris, storage_deleted,
       cloud_metadata_deleted, local_files_deleted, last_error_code,
       last_safe_error, created_at, updated_at)
    SELECT 'session-delete:' || s.id,
           s.created_by,
           s.workspace_id,
           s.id,
           'pending',
           0,
           NULL,
           '[]',
           '[]',
           0,
           0,
           0,
           NULL,
           NULL,
           COALESCE(s.deleted_at, s.updated_at),
           s.updated_at
      FROM local_sessions s
     WHERE s.deleted_at IS NOT NULL
    ON CONFLICT(session_id) DO NOTHING`,
];

// Version 9: per-user starred-session preferences and durable sync queue.
const v9Ddl: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS local_session_user_preferences (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    is_starred INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    local_sync_status TEXT NOT NULL DEFAULT 'local_only',
    cloud_sync_status TEXT NOT NULL DEFAULT 'not_started',
    last_sync_error_code TEXT,
    last_sync_error_message TEXT,
    last_synced_at TEXT,
    UNIQUE(user_id, session_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_preferences_user_starred
     ON local_session_user_preferences(user_id, is_starred, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_preferences_session
     ON local_session_user_preferences(session_id)`,
];

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "Initial baseline schema.",
    up: async ({ db }) => {
      for (const stmt of v1BaselineDdl) {
        await db.execAsync(stmt);
      }
    },
  },
  {
    version: 2,
    description: "Project sync columns + local_metadata_sync_queue.",
    up: async ({ db }) => {
      for (const stmt of v2Ddl) {
        await db.execAsync(stmt);
      }
    },
  },
  {
    version: 3,
    description: "Backfill pending project sync operations.",
    up: async ({ db }) => {
      for (const stmt of v3Ddl) {
        await db.execAsync(stmt);
      }
    },
  },
  {
    version: 4,
    description: "Session sync diagnostics + pending session backfill.",
    up: async ({ db }) => {
      for (const stmt of v4Ddl) {
        await db.execAsync(stmt);
      }
    },
  },
  {
    version: 5,
    description: "Note, bookmark, and timeline synchronization.",
    up: async ({ db }) => {
      for (const stmt of v5Ddl) {
        await db.execAsync(stmt);
      }
    },
  },
  {
    version: 6,
    description: "Recording metadata and private Storage upload queue.",
    up: async ({ db }) => {
      for (const stmt of v6Ddl) {
        await db.execAsync(stmt);
      }
    },
  },
  {
    version: 7,
    description: "Media evidence metadata, private Storage upload, and timeline sync.",
    up: async ({ db }) => {
      for (const stmt of v7Ddl) {
        await db.execAsync(stmt);
      }
    },
  },
  {
    version: 8,
    description: "Cloud-aware session deletion and orphan cleanup queue.",
    up: async ({ db }) => {
      for (const stmt of v8Ddl) {
        await db.execAsync(stmt);
      }
    },
  },
  {
    version: 9,
    description: "Per-user starred-session preferences and synchronization.",
    up: async ({ db }) => {
      for (const stmt of v9Ddl) {
        await db.execAsync(stmt);
      }
    },
  },
];

export const LATEST_LOCAL_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// -------------------------------------------------------------------------
// Runner
// -------------------------------------------------------------------------

const readUserVersion = async (db: MinimalDb): Promise<number> => {
  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  if (!row || typeof row.user_version !== "number") return 0;
  return row.user_version;
};

// setUserVersion cannot use bound parameters — PRAGMA takes an integer literal.
const setUserVersion = async (db: MinimalDb, version: number): Promise<void> => {
  const n = Math.trunc(version);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid schema version: ${version}`);
  }
  await db.execAsync(`PRAGMA user_version = ${n}`);
};

/**
 * Apply all migrations whose version > current user_version.
 * Each migration runs in its own transaction; user_version is changed inside
 * that transaction and therefore advances only if the transaction commits. If
 * a transaction fails, the next launch sees the same user_version and replays
 * cleanly.
 */
export const runMigrations = async (
  db: MinimalDb,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ appliedVersions: number[]; finalVersion: number }> => {
  let currentVersion = await readUserVersion(db);
  const appliedVersions: number[] = [];

  const ordered = [...migrations].sort(
    (left, right) => left.version - right.version,
  );

  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].version === ordered[index - 1].version) {
      throw new Error(
        `Duplicate migration version: ${ordered[index].version}`,
      );
    }
  }

  for (const migration of ordered) {
    if (migration.version <= currentVersion) {
      continue;
    }

    await db.withTransactionAsync(async () => {
      await migration.up({ db });

      await db.runAsync(
        `INSERT INTO local_meta(key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ["schema_version", String(migration.version)],
      );

      await setUserVersion(db, migration.version);
    });

    currentVersion = migration.version;
    appliedVersions.push(migration.version);
  }

  return {
    appliedVersions,
    finalVersion: currentVersion,
  };
};
