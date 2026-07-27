// Local SQLite migration engine.
//
// Uses SQLite's built-in PRAGMA user_version as the authoritative schema
// version marker. Each migration knows its target version and its `up` runs
// inside a transaction. `PRAGMA user_version` is only updated after the
// migration transaction commits, so an interrupted upgrade replays cleanly
// on the next launch.
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
 * Each migration runs in its own transaction; user_version is bumped ONLY
 * after that transaction commits. If a transaction fails the next launch
 * sees the same user_version and replays cleanly.
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
