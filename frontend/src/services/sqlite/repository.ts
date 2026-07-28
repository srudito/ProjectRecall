// Thin repository over SQLite for the entities that need to survive restart.
// Web returns empty arrays / no-ops since we don't ship a WASM DB in the preview.

import * as SQLite from "expo-sqlite";

import { openLocalDb } from "./schema";

const nowIso = () => new Date().toISOString();

interface LocalSessionRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  created_by: string;
  title: string;
  status: string;
  spoken_language_mode: string;
  expected_spoken_languages: string; // JSON array
  started_at: string | null;
  stopped_at: string | null;
  total_recorded_duration_ms: number;
  local_sync_status: string;
  cloud_sync_status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SessionRecord {
  id: string;
  workspace_id: string;
  project_id: string | null;
  created_by: string;
  title: string;
  status: string;
  spoken_language_mode: string;
  expected_spoken_languages: string[];
  started_at: string | null;
  stopped_at: string | null;
  total_recorded_duration_ms: number;
  local_sync_status: string;
  cloud_sync_status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const parseSession = (row: LocalSessionRow): SessionRecord => ({
  ...row,
  expected_spoken_languages: (() => {
    try {
      return JSON.parse(row.expected_spoken_languages) as string[];
    } catch {
      return [];
    }
  })(),
});

export const upsertSession = async (record: SessionRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const now = nowIso();
  await db.runAsync(
    `INSERT INTO local_sessions
     (id, workspace_id, project_id, created_by, title, session_type, status,
      started_at, stopped_at, total_recorded_duration_ms, spoken_language_mode,
      expected_spoken_languages, detected_spoken_languages, primary_detected_language,
      language_detection_status, summary_output_language, translation_target_language,
      transcript_display_mode, language_metadata, local_sync_status, cloud_sync_status,
      created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 'standard', ?, ?, ?, ?, ?, ?, '[]', NULL, 'NOT_STARTED',
             NULL, NULL, 'ORIGINAL', NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title,
       status=excluded.status,
       started_at=excluded.started_at,
       stopped_at=excluded.stopped_at,
       total_recorded_duration_ms=excluded.total_recorded_duration_ms,
       spoken_language_mode=excluded.spoken_language_mode,
       expected_spoken_languages=excluded.expected_spoken_languages,
       local_sync_status=excluded.local_sync_status,
       cloud_sync_status=excluded.cloud_sync_status,
       project_id=excluded.project_id,
       updated_at=excluded.updated_at,
       deleted_at=excluded.deleted_at`,
    [
      record.id,
      record.workspace_id,
      record.project_id,
      record.created_by,
      record.title,
      record.status,
      record.started_at,
      record.stopped_at,
      record.total_recorded_duration_ms,
      record.spoken_language_mode,
      JSON.stringify(record.expected_spoken_languages ?? []),
      record.local_sync_status,
      record.cloud_sync_status,
      record.created_at,
      now,
      record.deleted_at,
    ],
  );
};

export const listSessions = async (workspaceId: string): Promise<SessionRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT id, workspace_id, project_id, created_by, title, status,
            spoken_language_mode, expected_spoken_languages, started_at,
            stopped_at, total_recorded_duration_ms, local_sync_status,
            cloud_sync_status, created_at, updated_at, deleted_at
     FROM local_sessions
     WHERE workspace_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [workspaceId],
  )) as LocalSessionRow[];
  return rows.map(parseSession);
};

export const getSession = async (id: string): Promise<SessionRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT id, workspace_id, project_id, created_by, title, status,
            spoken_language_mode, expected_spoken_languages, started_at,
            stopped_at, total_recorded_duration_ms, local_sync_status,
            cloud_sync_status, created_at, updated_at, deleted_at
     FROM local_sessions WHERE id = ?`,
    [id],
  )) as LocalSessionRow | null;
  return row ? parseSession(row) : null;
};

export const softDeleteSession = async (id: string): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_sessions SET deleted_at = ?, status = 'deleting', updated_at = ? WHERE id = ?`,
    [nowIso(), nowIso(), id],
  );
};

export interface ProjectRecord {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: string;
  default_spoken_language_mode: string | null;
  default_expected_spoken_languages: string[] | null;
  default_summary_output_language: string | null;
  default_translation_target_language: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  local_sync_status: string;
  cloud_sync_status: string;
  last_sync_error_code: string | null;
  last_sync_error_message: string | null;
  last_synced_at: string | null;
}

interface LocalProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: string;
  default_spoken_language_mode: string | null;
  default_expected_spoken_languages: string | null; // JSON
  default_summary_output_language: string | null;
  default_translation_target_language: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  local_sync_status: string;
  cloud_sync_status: string;
  last_sync_error_code: string | null;
  last_sync_error_message: string | null;
  last_synced_at: string | null;
}

const parseProjectRow = (row: LocalProjectRow): ProjectRecord => ({
  id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  description: row.description,
  status: row.status,
  default_spoken_language_mode: row.default_spoken_language_mode,
  default_expected_spoken_languages: (() => {
    if (row.default_expected_spoken_languages == null) return null;
    try {
      const v = JSON.parse(row.default_expected_spoken_languages);
      return Array.isArray(v) ? (v as string[]) : null;
    } catch {
      return null;
    }
  })(),
  default_summary_output_language: row.default_summary_output_language,
  default_translation_target_language: row.default_translation_target_language,
  created_by: row.created_by,
  created_at: row.created_at,
  updated_at: row.updated_at,
  deleted_at: row.deleted_at,
  local_sync_status: row.local_sync_status,
  cloud_sync_status: row.cloud_sync_status,
  last_sync_error_code: row.last_sync_error_code,
  last_sync_error_message: row.last_sync_error_message,
  last_synced_at: row.last_synced_at,
});

const serializeLangArray = (v: string[] | null | undefined): string | null => {
  if (v == null) return null;
  return JSON.stringify(v);
};

/**
 * Upsert a project into local_projects.
 *
 * IMPORTANT: this function does NOT rewrite `updated_at` to `now()`. Callers
 * (both the create-project path and the cloud→local merge) supply the
 * authoritative `updated_at` on the record and it is stored verbatim. This is
 * the correct behaviour for cloud hydration — otherwise a merge would touch
 * updated_at and produce a synchronisation loop.
 */
export const upsertProject = async (record: ProjectRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT INTO local_projects
      (id, workspace_id, name, description, status,
       default_spoken_language_mode, default_expected_spoken_languages,
       default_summary_output_language, default_translation_target_language,
       created_by, created_at, updated_at, deleted_at,
       local_sync_status, cloud_sync_status,
       last_sync_error_code, last_sync_error_message, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       description=excluded.description,
       status=excluded.status,
       default_spoken_language_mode=excluded.default_spoken_language_mode,
       default_expected_spoken_languages=excluded.default_expected_spoken_languages,
       default_summary_output_language=excluded.default_summary_output_language,
       default_translation_target_language=excluded.default_translation_target_language,
       updated_at=excluded.updated_at,
       deleted_at=excluded.deleted_at,
       local_sync_status=excluded.local_sync_status,
       cloud_sync_status=excluded.cloud_sync_status,
       last_sync_error_code=excluded.last_sync_error_code,
       last_sync_error_message=excluded.last_sync_error_message,
       last_synced_at=excluded.last_synced_at`,
    [
      record.id,
      record.workspace_id,
      record.name,
      record.description,
      record.status,
      record.default_spoken_language_mode,
      serializeLangArray(record.default_expected_spoken_languages),
      record.default_summary_output_language,
      record.default_translation_target_language,
      record.created_by,
      record.created_at,
      record.updated_at,
      record.deleted_at,
      record.local_sync_status,
      record.cloud_sync_status,
      record.last_sync_error_code,
      record.last_sync_error_message,
      record.last_synced_at,
    ],
  );
};

export const getProject = async (id: string): Promise<ProjectRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT * FROM local_projects WHERE id = ?`,
    [id],
  )) as LocalProjectRow | null;
  return row ? parseProjectRow(row) : null;
};

export const listProjects = async (workspaceId: string): Promise<ProjectRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT * FROM local_projects
     WHERE workspace_id = ? AND deleted_at IS NULL AND status = 'active'
     ORDER BY updated_at DESC`,
    [workspaceId],
  )) as LocalProjectRow[];
  return rows.map(parseProjectRow);
};

export interface ProjectSyncStatusUpdate {
  local_sync_status?: string;
  cloud_sync_status?: string;
  last_sync_error_code?: string | null;
  last_sync_error_message?: string | null;
  last_synced_at?: string | null;
}

/**
 * Update sync-status columns on a project WITHOUT touching entity `updated_at`.
 * This is critical: rewriting updated_at from a sync path creates a sync loop
 * because the cloud row would then always look older than the local one.
 */
export const updateProjectSyncStatus = async (
  id: string,
  patch: ProjectSyncStatusUpdate,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const allowedKeys: (keyof ProjectSyncStatusUpdate)[] = [
    "local_sync_status",
    "cloud_sync_status",
    "last_sync_error_code",
    "last_sync_error_message",
    "last_synced_at",
  ];

  const entries = allowedKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(patch, key))
    .map((key) => ({
      key,
      value: patch[key] ?? null,
    }));

  if (entries.length === 0) return;

  const setSql = entries.map(({ key }) => `${key} = ?`).join(", ");

  const values: (string | null)[] = entries.map(({ value }) => value);

  await db.runAsync(
    `UPDATE local_projects
     SET ${setSql}
     WHERE id = ?`,
    [...values, id],
  );
};

export interface NoteRecord {
  id: string;
  workspace_id: string;
  project_id: string | null;
  session_id: string;
  text: string;
  recording_offset_ms: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const insertNote = async (r: NoteRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT INTO local_notes
      (id, workspace_id, project_id, session_id, text, recording_offset_ms, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.workspace_id,
      r.project_id,
      r.session_id,
      r.text,
      r.recording_offset_ms,
      r.created_by,
      r.created_at,
      r.updated_at,
    ],
  );
};

export const listNotesForSession = async (sessionId: string): Promise<NoteRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT * FROM local_notes WHERE session_id = ? AND deleted_at IS NULL ORDER BY recording_offset_ms ASC`,
    [sessionId],
  )) as NoteRecord[];
  return rows;
};

export interface BookmarkRecord {
  id: string;
  workspace_id: string;
  project_id: string | null;
  session_id: string;
  label: string;
  recording_offset_ms: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const insertBookmark = async (r: BookmarkRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT INTO local_bookmarks
      (id, workspace_id, project_id, session_id, label, recording_offset_ms, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.workspace_id,
      r.project_id,
      r.session_id,
      r.label,
      r.recording_offset_ms,
      r.created_by,
      r.created_at,
      r.updated_at,
    ],
  );
};

export const listBookmarksForSession = async (sessionId: string): Promise<BookmarkRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT * FROM local_bookmarks WHERE session_id = ? AND deleted_at IS NULL ORDER BY recording_offset_ms ASC`,
    [sessionId],
  )) as BookmarkRecord[];
  return rows;
};

export interface TimelineEventRecord {
  id: string;
  workspace_id: string;
  project_id: string | null;
  session_id: string;
  event_type: string;
  source_entity_type: string | null;
  source_entity_id: string | null;
  recording_offset_ms: number;
  created_by: string;
  created_at: string;
}

export const insertTimelineEvent = async (r: TimelineEventRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT INTO local_timeline_events
      (id, workspace_id, project_id, session_id, event_type, source_entity_type, source_entity_id,
       recording_offset_ms, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.workspace_id,
      r.project_id,
      r.session_id,
      r.event_type,
      r.source_entity_type,
      r.source_entity_id,
      r.recording_offset_ms,
      r.created_by,
      r.created_at,
    ],
  );
};

export const listTimelineEvents = async (sessionId: string): Promise<TimelineEventRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT * FROM local_timeline_events WHERE session_id = ? ORDER BY recording_offset_ms ASC, created_at ASC`,
    [sessionId],
  )) as TimelineEventRecord[];
  return rows;
};

export interface MediaAssetRecord {
  id: string;
  workspace_id: string;
  project_id: string | null;
  session_id: string;
  added_by: string;
  asset_type: string;
  mime_type: string;
  original_file_name: string;
  sanitized_file_name: string;
  local_file_uri: string | null;
  file_size: number;
  duration_ms: number | null;
  image_width: number | null;
  image_height: number | null;
  recording_offset_ms: number;
  user_caption: string | null;
  upload_status: string;
  created_at: string;
  updated_at: string;
}

export const insertMediaAsset = async (r: MediaAssetRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT INTO local_media_assets
      (id, workspace_id, project_id, session_id, added_by, asset_type, mime_type,
       original_file_name, sanitized_file_name, local_file_uri, file_size, duration_ms,
       image_width, image_height, recording_offset_ms, user_caption, upload_status,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.workspace_id,
      r.project_id,
      r.session_id,
      r.added_by,
      r.asset_type,
      r.mime_type,
      r.original_file_name,
      r.sanitized_file_name,
      r.local_file_uri,
      r.file_size,
      r.duration_ms,
      r.image_width,
      r.image_height,
      r.recording_offset_ms,
      r.user_caption,
      r.upload_status,
      r.created_at,
      r.updated_at,
    ],
  );
};

export const listMediaAssetsForSession = async (sessionId: string): Promise<MediaAssetRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT id, workspace_id, project_id, session_id, added_by, asset_type, mime_type,
            original_file_name, sanitized_file_name, local_file_uri, file_size, duration_ms,
            image_width, image_height, recording_offset_ms, user_caption, upload_status,
            created_at, updated_at
     FROM local_media_assets
     WHERE session_id = ? AND deleted_at IS NULL
     ORDER BY recording_offset_ms ASC`,
    [sessionId],
  )) as MediaAssetRecord[];
  return rows;
};

export interface UploadQueueRow {
  id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  source_entity_type: string;
  source_entity_id: string;
  local_file_uri: string;
  target_storage_path: string;
  queue_status: string;
  attempt_count: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_safe_error: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export const enqueueUpload = async (r: UploadQueueRow): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT OR IGNORE INTO local_upload_queue
      (id, user_id, workspace_id, session_id, source_entity_type, source_entity_id,
       local_file_uri, target_storage_path, queue_status, attempt_count, next_retry_at,
       last_error_code, last_safe_error, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.user_id,
      r.workspace_id,
      r.session_id,
      r.source_entity_type,
      r.source_entity_id,
      r.local_file_uri,
      r.target_storage_path,
      r.queue_status,
      r.attempt_count,
      r.next_retry_at,
      r.last_error_code,
      r.last_safe_error,
      r.idempotency_key,
      r.created_at,
      r.updated_at,
    ],
  );
};

export const listQueueByStatus = async (status: string): Promise<UploadQueueRow[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT * FROM local_upload_queue WHERE queue_status = ? ORDER BY created_at ASC`,
    [status],
  )) as UploadQueueRow[];
  return rows;
};

export const listAllQueue = async (): Promise<UploadQueueRow[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(`SELECT * FROM local_upload_queue ORDER BY created_at ASC`)) as UploadQueueRow[];
  return rows;
};

export const updateQueueRecord = async (
  id: string,
  updates: Partial<Pick<UploadQueueRow, "queue_status" | "attempt_count" | "next_retry_at" | "last_error_code" | "last_safe_error">>,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setSql = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (updates as any)[k]);
  await db.runAsync(
    `UPDATE local_upload_queue SET ${setSql}, updated_at = ? WHERE id = ?`,
    [...values, nowIso(), id],
  );
};

export const setPreference = async (key: string, value: unknown): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT INTO local_user_preferences(key, value, updated_at)
     VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), nowIso()],
  );
};

export const getPreference = async <T>(key: string, fallback: T): Promise<T> => {
  const db = await openLocalDb();
  if (!db) return fallback;
  const row = (await db.getFirstAsync(
    `SELECT value FROM local_user_preferences WHERE key = ?`,
    [key],
  )) as { value: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
};

export type { SQLite };

// ==========================================================================
// Project metadata sync queue (introduced in local schema version 2).
// ==========================================================================

export type MetadataQueueOperation = "UPSERT" | "DELETE";
export type MetadataQueueEntityType = "project"; // extensible later
export type MetadataQueueStatus =
  | "pending"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface MetadataQueueRow {
  id: string;
  user_id: string;
  workspace_id: string;
  entity_type: MetadataQueueEntityType;
  entity_id: string;
  operation: MetadataQueueOperation;
  parent_entity_type: string | null;
  parent_entity_id: string | null;
  priority: number;
  queue_status: MetadataQueueStatus;
  attempt_count: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_safe_error: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface EnqueueMetadataInput {
  id: string; // caller-supplied UUID for the queue row itself
  user_id: string;
  workspace_id: string;
  entity_type: MetadataQueueEntityType;
  entity_id: string;
  operation: MetadataQueueOperation;
  parent_entity_type?: string | null;
  parent_entity_id?: string | null;
  priority?: number;
  idempotency_key: string;
}

/**
 * Enqueue a metadata sync operation.
 *
 * Idempotency: `idempotency_key` is UNIQUE and callers should derive it
 * deterministically (e.g. `upsert:project:<project_id>`). On conflict we
 * COALESCE — the existing row is bumped back to `pending`, its
 * `attempt_count` reset, and `next_retry_at` cleared so the worker picks it
 * up again with the LATEST local entity state. This prevents:
 *   • duplicate rows for the same unchanged project (INSERT is ignored)
 *   • stale UPSERTs shadowing newer edits (INSERT OR IGNORE would do that)
 */
export const enqueueMetadataSync = async (input: EnqueueMetadataInput): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const now = nowIso();
  await db.runAsync(
    `INSERT INTO local_metadata_sync_queue
      (id, user_id, workspace_id, entity_type, entity_id, operation,
       parent_entity_type, parent_entity_id, priority,
       queue_status, attempt_count, next_retry_at,
       last_error_code, last_safe_error, idempotency_key,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       queue_status = 'pending',
       attempt_count = 0,
       next_retry_at = NULL,
       last_error_code = NULL,
       last_safe_error = NULL,
       updated_at = excluded.updated_at`,
    [
      input.id,
      input.user_id,
      input.workspace_id,
      input.entity_type,
      input.entity_id,
      input.operation,
      input.parent_entity_type ?? null,
      input.parent_entity_id ?? null,
      input.priority ?? 100,
      input.idempotency_key,
      now,
      now,
    ],
  );
};

/**
 * Return the next eligible pending operation whose next_retry_at is now or
 * earlier. Ordered by priority ASC, then created_at ASC (FIFO within priority).
 */
export const getNextEligibleMetadataOperation = async (
  now: string = nowIso(),
  userId?: string,
): Promise<MetadataQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;

  const userClause = userId ? " AND user_id = ?" : "";
  const params = userId ? [now, userId] : [now];
  const row = (await db.getFirstAsync(
    `SELECT * FROM local_metadata_sync_queue
     WHERE queue_status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ${userClause}
     ORDER BY priority ASC, created_at ASC
     LIMIT 1`,
    params,
  )) as MetadataQueueRow | null;
  return row ?? null;
};

/**
 * Atomically claim a metadata operation for processing.
 * Only claims if it's still `pending`. Returns the claimed row or null.
 */
export const claimMetadataOperation = async (
  id: string,
): Promise<MetadataQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const now = nowIso();
  let claimed: MetadataQueueRow | null = null;
  await db.withTransactionAsync(async () => {
    const row = (await db.getFirstAsync(
      `SELECT * FROM local_metadata_sync_queue WHERE id = ? AND queue_status = 'pending'`,
      [id],
    )) as MetadataQueueRow | null;
    if (!row) return;
    await db.runAsync(
      `UPDATE local_metadata_sync_queue
         SET queue_status = 'in_progress',
             attempt_count = attempt_count + 1,
             updated_at = ?
       WHERE id = ?`,
      [now, id],
    );
    claimed = { ...row, queue_status: "in_progress", attempt_count: row.attempt_count + 1, updated_at: now };
  });
  return claimed;
};

export const markMetadataOperationSucceeded = async (id: string): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const now = nowIso();
  await db.runAsync(
    `UPDATE local_metadata_sync_queue
       SET queue_status = 'succeeded',
           last_error_code = NULL,
           last_safe_error = NULL,
           updated_at = ?
     WHERE id = ?`,
    [now, id],
  );
};

export const markMetadataOperationFailed = async (
  id: string,
  errorCode: string,
  safeErrorMessage: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const now = nowIso();
  await db.runAsync(
    `UPDATE local_metadata_sync_queue
       SET queue_status = 'failed',
           last_error_code = ?,
           last_safe_error = ?,
           updated_at = ?
     WHERE id = ?`,
    [errorCode, safeErrorMessage, now, id],
  );
};

export const rescheduleMetadataOperation = async (
  id: string,
  nextRetryAt: string,
  errorCode: string,
  safeErrorMessage: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const now = nowIso();
  await db.runAsync(
    `UPDATE local_metadata_sync_queue
       SET queue_status = 'pending',
           next_retry_at = ?,
           last_error_code = ?,
           last_safe_error = ?,
           updated_at = ?
     WHERE id = ?`,
    [nextRetryAt, errorCode, safeErrorMessage, now, id],
  );
};

export const deleteCompletedMetadataOperation = async (id: string): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(`DELETE FROM local_metadata_sync_queue WHERE id = ?`, [id]);
};

export const listMetadataQueue = async (): Promise<MetadataQueueRow[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT * FROM local_metadata_sync_queue ORDER BY priority ASC, created_at ASC`,
  )) as MetadataQueueRow[];
  return rows;
};

export const countPendingMetadataOperations = async (): Promise<number> => {
  const db = await openLocalDb();
  if (!db) return 0;
  const row = (await db.getFirstAsync(
    `SELECT COUNT(*) as n FROM local_metadata_sync_queue WHERE queue_status = 'pending'`,
  )) as { n: number } | null;
  return row?.n ?? 0;
};

/**
 * Recover operations that were claimed before the process was interrupted.
 * This is safe because the worker is protected by an in-process mutex and is
 * called once during startup before new work is claimed.
 */
export const resetInProgressMetadataOperations = async (): Promise<number> => {
  const db = await openLocalDb();
  if (!db) return 0;
  const result = await db.runAsync(
    `UPDATE local_metadata_sync_queue
       SET queue_status = 'pending',
           next_retry_at = NULL,
           updated_at = ?
     WHERE queue_status = 'in_progress'`,
    [nowIso()],
  );
  return result.changes;
};

export const deleteMetadataOperationsForEntity = async (
  entityType: MetadataQueueEntityType,
  entityId: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `DELETE FROM local_metadata_sync_queue
     WHERE entity_type = ? AND entity_id = ?`,
    [entityType, entityId],
  );
};

export const requeueMetadataOperationForEntity = async (
  entityType: MetadataQueueEntityType,
  entityId: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_metadata_sync_queue
       SET queue_status = 'pending',
           next_retry_at = NULL,
           last_error_code = NULL,
           last_safe_error = NULL,
           updated_at = ?
     WHERE entity_type = ? AND entity_id = ?`,
    [nowIso(), entityType, entityId],
  );
};

// ==========================================================================
// Atomic local project creation
// ==========================================================================

export interface AtomicCreateProjectInput {
  project: ProjectRecord;
  queueRowId: string;
  idempotencyKey: string;
}

/**
 * Insert the project into local_projects and enqueue an UPSERT metadata sync
 * operation INSIDE ONE TRANSACTION. If any step fails the whole transaction
 * is rolled back — the caller never sees a partial commit.
 */
export const atomicCreateProjectWithSync = async (
  input: AtomicCreateProjectInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return; // caller (web path) uses remote directly and never hits this.
  const p = input.project;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO local_projects
        (id, workspace_id, name, description, status,
         default_spoken_language_mode, default_expected_spoken_languages,
         default_summary_output_language, default_translation_target_language,
         created_by, created_at, updated_at, deleted_at,
         local_sync_status, cloud_sync_status,
         last_sync_error_code, last_sync_error_message, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.id,
        p.workspace_id,
        p.name,
        p.description,
        p.status,
        p.default_spoken_language_mode,
        p.default_expected_spoken_languages == null
          ? null
          : JSON.stringify(p.default_expected_spoken_languages),
        p.default_summary_output_language,
        p.default_translation_target_language,
        p.created_by,
        p.created_at,
        p.updated_at,
        p.deleted_at,
        p.local_sync_status,
        p.cloud_sync_status,
        p.last_sync_error_code,
        p.last_sync_error_message,
        p.last_synced_at,
      ],
    );
    const now = nowIso();
    await db.runAsync(
      `INSERT INTO local_metadata_sync_queue
        (id, user_id, workspace_id, entity_type, entity_id, operation,
         parent_entity_type, parent_entity_id, priority,
         queue_status, attempt_count, next_retry_at,
         last_error_code, last_safe_error, idempotency_key,
         created_at, updated_at)
       VALUES (?, ?, ?, 'project', ?, 'UPSERT', NULL, NULL, 100,
               'pending', 0, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        input.queueRowId,
        p.created_by,
        p.workspace_id,
        p.id,
        input.idempotencyKey,
        now,
        now,
      ],
    );
  });
};

export interface AtomicRequeueProjectSyncInput {
  projectId: string;
  userId: string;
  workspaceId: string;
  queueRowId: string;
  idempotencyKey: string;
}

/**
 * Requeue a failed/pending project and update its visible sync state in one
 * local transaction. This prevents a `pending` project from being left without
 * a corresponding queue operation if SQLite fails midway through a manual
 * retry.
 */
export const atomicRequeueProjectSync = async (
  input: AtomicRequeueProjectSyncInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const now = nowIso();

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE local_projects
          SET local_sync_status = 'pending',
              cloud_sync_status = 'pending',
              last_sync_error_code = NULL,
              last_sync_error_message = NULL
        WHERE id = ?`,
      [input.projectId],
    );

    await db.runAsync(
      `INSERT INTO local_metadata_sync_queue
        (id, user_id, workspace_id, entity_type, entity_id, operation,
         parent_entity_type, parent_entity_id, priority,
         queue_status, attempt_count, next_retry_at,
         last_error_code, last_safe_error, idempotency_key,
         created_at, updated_at)
       VALUES (?, ?, ?, 'project', ?, 'UPSERT', NULL, NULL, 100,
               'pending', 0, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        input.queueRowId,
        input.userId,
        input.workspaceId,
        input.projectId,
        input.idempotencyKey,
        now,
        now,
      ],
    );
  });
};
