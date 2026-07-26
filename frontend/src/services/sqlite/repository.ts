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
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export const upsertProject = async (record: ProjectRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT INTO local_projects
      (id, workspace_id, name, description, status, created_by, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       description=excluded.description,
       status=excluded.status,
       updated_at=excluded.updated_at,
       deleted_at=excluded.deleted_at`,
    [
      record.id,
      record.workspace_id,
      record.name,
      record.description,
      record.status,
      record.created_by,
      record.created_at,
      record.updated_at,
      record.deleted_at,
    ],
  );
};

export const listProjects = async (workspaceId: string): Promise<ProjectRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT * FROM local_projects WHERE workspace_id = ? AND deleted_at IS NULL AND status = 'active'
     ORDER BY updated_at DESC`,
    [workspaceId],
  )) as ProjectRecord[];
  return rows;
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
