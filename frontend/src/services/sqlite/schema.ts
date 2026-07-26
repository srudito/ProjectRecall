// Local SQLite schema + open helper. We keep the schema definition here so
// we can generate migration SQL and unit-test the DDL if needed.
//
// Rules (from spec):
//   * Use expo-sqlite for DURABLE metadata only.
//   * Never store audio/image/video/document binaries here — only their local
//     URIs. Files live on disk in the app-controlled directory.
//   * Never store secrets or provider keys here.

import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";

const DB_NAME = "project_recall.db";

// Schema version — bump when altering tables and add a matching migration below.
export const LOCAL_SCHEMA_VERSION = 1;

export const LOCAL_DDL: readonly string[] = [
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

let dbPromise: Promise<SQLite.SQLiteDatabase | null> | null = null;

export const openLocalDb = async (): Promise<SQLite.SQLiteDatabase | null> => {
  if (Platform.OS === "web") {
    // expo-sqlite works on web via WASM but is unreliable in this preview
    // environment. We degrade to an in-memory shim by returning null; the
    // service layer will short-circuit to remote-only reads.
    return null;
  }
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync("PRAGMA journal_mode = WAL;");
    await db.withTransactionAsync(async () => {
      for (const stmt of LOCAL_DDL) {
        await db.execAsync(stmt);
      }
      await db.runAsync(
        "INSERT OR REPLACE INTO local_meta(key, value) VALUES (?, ?)",
        ["schema_version", String(LOCAL_SCHEMA_VERSION)],
      );
    });
    return db;
  })();
  return dbPromise;
};
