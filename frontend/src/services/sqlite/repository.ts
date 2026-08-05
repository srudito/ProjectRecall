// Thin repository over SQLite for the entities that need to survive restart.
// Web returns empty arrays / no-ops since we don't ship a WASM DB in the preview.

import * as SQLite from "expo-sqlite";

import { openLocalDb } from "./schema";
import { runSerializedLocalTransaction } from "./transaction";

const nowIso = () => new Date().toISOString();

interface LocalSessionRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  created_by: string;
  title: string;
  session_type: string;
  status: string;
  started_at: string | null;
  stopped_at: string | null;
  total_recorded_duration_ms: number;
  spoken_language_mode: string;
  expected_spoken_languages: string;
  detected_spoken_languages: string;
  primary_detected_language: string | null;
  language_detection_status: string;
  summary_output_language: string | null;
  translation_target_language: string | null;
  transcript_display_mode: string;
  language_metadata: string | null;
  local_sync_status: string;
  cloud_sync_status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_sync_error_code: string | null;
  last_sync_error_message: string | null;
  last_synced_at: string | null;
}

export interface SessionRecord {
  id: string;
  workspace_id: string;
  project_id: string | null;
  created_by: string;
  title: string;
  session_type: string;
  status: string;
  started_at: string | null;
  stopped_at: string | null;
  total_recorded_duration_ms: number;
  spoken_language_mode: string;
  expected_spoken_languages: string[];
  detected_spoken_languages: string[];
  primary_detected_language: string | null;
  language_detection_status: string;
  summary_output_language: string | null;
  translation_target_language: string | null;
  transcript_display_mode: string;
  language_metadata: Record<string, unknown> | null;
  local_sync_status: string;
  cloud_sync_status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_sync_error_code: string | null;
  last_sync_error_message: string | null;
  last_synced_at: string | null;
}

const parseStringArray = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const parseJsonObject = (
  value: string | null,
): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const parseSession = (row: LocalSessionRow): SessionRecord => ({
  id: row.id,
  workspace_id: row.workspace_id,
  project_id: row.project_id,
  created_by: row.created_by,
  title: row.title,
  session_type: row.session_type,
  status: row.status,
  started_at: row.started_at,
  stopped_at: row.stopped_at,
  total_recorded_duration_ms: row.total_recorded_duration_ms,
  spoken_language_mode: row.spoken_language_mode,
  expected_spoken_languages: parseStringArray(row.expected_spoken_languages),
  detected_spoken_languages: parseStringArray(row.detected_spoken_languages),
  primary_detected_language: row.primary_detected_language,
  language_detection_status: row.language_detection_status,
  summary_output_language: row.summary_output_language,
  translation_target_language: row.translation_target_language,
  transcript_display_mode: row.transcript_display_mode,
  language_metadata: parseJsonObject(row.language_metadata),
  local_sync_status: row.local_sync_status,
  cloud_sync_status: row.cloud_sync_status,
  created_at: row.created_at,
  updated_at: row.updated_at,
  deleted_at: row.deleted_at,
  last_sync_error_code: row.last_sync_error_code,
  last_sync_error_message: row.last_sync_error_message,
  last_synced_at: row.last_synced_at,
});

const sessionColumns = `
  id, workspace_id, project_id, created_by, title, session_type, status,
  started_at, stopped_at, total_recorded_duration_ms, spoken_language_mode,
  expected_spoken_languages, detected_spoken_languages,
  primary_detected_language, language_detection_status,
  summary_output_language, translation_target_language,
  transcript_display_mode, language_metadata, local_sync_status,
  cloud_sync_status, created_at, updated_at, deleted_at,
  last_sync_error_code, last_sync_error_message, last_synced_at
`;

const upsertSessionOnDb = async (
  db: SQLite.SQLiteDatabase,
  record: SessionRecord,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_sessions
      (id, workspace_id, project_id, created_by, title, session_type, status,
       started_at, stopped_at, total_recorded_duration_ms,
       spoken_language_mode, expected_spoken_languages,
       detected_spoken_languages, primary_detected_language,
       language_detection_status, summary_output_language,
       translation_target_language, transcript_display_mode,
       language_metadata, local_sync_status, cloud_sync_status,
       created_at, updated_at, deleted_at, last_sync_error_code,
       last_sync_error_message, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id=excluded.workspace_id,
       project_id=excluded.project_id,
       title=excluded.title,
       session_type=excluded.session_type,
       status=excluded.status,
       started_at=excluded.started_at,
       stopped_at=excluded.stopped_at,
       total_recorded_duration_ms=excluded.total_recorded_duration_ms,
       spoken_language_mode=excluded.spoken_language_mode,
       expected_spoken_languages=excluded.expected_spoken_languages,
       detected_spoken_languages=excluded.detected_spoken_languages,
       primary_detected_language=excluded.primary_detected_language,
       language_detection_status=excluded.language_detection_status,
       summary_output_language=excluded.summary_output_language,
       translation_target_language=excluded.translation_target_language,
       transcript_display_mode=excluded.transcript_display_mode,
       language_metadata=excluded.language_metadata,
       local_sync_status=excluded.local_sync_status,
       cloud_sync_status=excluded.cloud_sync_status,
       updated_at=excluded.updated_at,
       deleted_at=excluded.deleted_at,
       last_sync_error_code=excluded.last_sync_error_code,
       last_sync_error_message=excluded.last_sync_error_message,
       last_synced_at=excluded.last_synced_at`,
    [
      record.id,
      record.workspace_id,
      record.project_id,
      record.created_by,
      record.title,
      record.session_type,
      record.status,
      record.started_at,
      record.stopped_at,
      record.total_recorded_duration_ms,
      record.spoken_language_mode,
      JSON.stringify(record.expected_spoken_languages ?? []),
      JSON.stringify(record.detected_spoken_languages ?? []),
      record.primary_detected_language,
      record.language_detection_status,
      record.summary_output_language,
      record.translation_target_language,
      record.transcript_display_mode,
      record.language_metadata == null
        ? null
        : JSON.stringify(record.language_metadata),
      record.local_sync_status,
      record.cloud_sync_status,
      record.created_at,
      record.updated_at,
      record.deleted_at,
      record.last_sync_error_code,
      record.last_sync_error_message,
      record.last_synced_at,
    ],
  );
};

/**
 * Store a session without rewriting entity updated_at. Cloud hydration must
 * preserve the cloud timestamp or it can create a local/cloud sync loop.
 */
export const upsertSession = async (record: SessionRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await upsertSessionOnDb(db, record);
};

export const listSessions = async (
  workspaceId: string,
): Promise<SessionRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const rows = (await db.getAllAsync(
    `SELECT ${sessionColumns}
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
    `SELECT ${sessionColumns} FROM local_sessions WHERE id = ?`,
    [id],
  )) as LocalSessionRow | null;
  return row ? parseSession(row) : null;
};

export interface SessionSyncStatusUpdate {
  local_sync_status?: string;
  cloud_sync_status?: string;
  last_sync_error_code?: string | null;
  last_sync_error_message?: string | null;
  last_synced_at?: string | null;
}

export const updateSessionSyncStatus = async (
  id: string,
  patch: SessionSyncStatusUpdate,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const allowedKeys: (keyof SessionSyncStatusUpdate)[] = [
    "local_sync_status",
    "cloud_sync_status",
    "last_sync_error_code",
    "last_sync_error_message",
    "last_synced_at",
  ];
  const entries = allowedKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(patch, key))
    .map((key) => ({ key, value: patch[key] ?? null }));

  if (entries.length === 0) return;

  const setSql = entries.map(({ key }) => `${key} = ?`).join(", ");
  const values: (string | null)[] = entries.map(({ value }) => value);
  await db.runAsync(
    `UPDATE local_sessions SET ${setSql} WHERE id = ?`,
    [...values, id],
  );
};

export const softDeleteSession = async (id: string): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const now = nowIso();
  await db.runAsync(
    `UPDATE local_sessions
        SET deleted_at = ?, status = 'deleting', updated_at = ?,
            local_sync_status = 'local_only', cloud_sync_status = 'local_only'
      WHERE id = ?`,
    [now, now, id],
  );
};

// Per-user session organization preferences -------------------------------
export interface SessionUserPreferenceRecord {
  id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
  local_sync_status: string;
  cloud_sync_status: string;
  last_sync_error_code: string | null;
  last_sync_error_message: string | null;
  last_synced_at: string | null;
}

interface LocalSessionUserPreferenceRow
  extends Omit<SessionUserPreferenceRecord, "is_starred"> {
  is_starred: number;
}

const parseSessionUserPreference = (
  row: LocalSessionUserPreferenceRow,
): SessionUserPreferenceRecord => ({
  ...row,
  is_starred: row.is_starred === 1,
});

const upsertSessionUserPreferenceOnDb = async (
  db: SQLite.SQLiteDatabase,
  record: SessionUserPreferenceRecord,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_session_user_preferences
      (id, user_id, workspace_id, session_id, is_starred,
       created_at, updated_at, local_sync_status, cloud_sync_status,
       last_sync_error_code, last_sync_error_message, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, session_id) DO UPDATE SET
       id=excluded.id,
       workspace_id=excluded.workspace_id,
       is_starred=excluded.is_starred,
       updated_at=excluded.updated_at,
       local_sync_status=excluded.local_sync_status,
       cloud_sync_status=excluded.cloud_sync_status,
       last_sync_error_code=excluded.last_sync_error_code,
       last_sync_error_message=excluded.last_sync_error_message,
       last_synced_at=excluded.last_synced_at`,
    [
      record.id,
      record.user_id,
      record.workspace_id,
      record.session_id,
      record.is_starred ? 1 : 0,
      record.created_at,
      record.updated_at,
      record.local_sync_status,
      record.cloud_sync_status,
      record.last_sync_error_code,
      record.last_sync_error_message,
      record.last_synced_at,
    ],
  );
};

export const upsertSessionUserPreference = async (
  record: SessionUserPreferenceRecord,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await upsertSessionUserPreferenceOnDb(db, record);
};

export const getSessionUserPreference = async (
  userId: string,
  sessionId: string,
): Promise<SessionUserPreferenceRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_session_user_preferences
      WHERE user_id = ? AND session_id = ?
      LIMIT 1`,
    [userId, sessionId],
  )) as LocalSessionUserPreferenceRow | null;
  return row ? parseSessionUserPreference(row) : null;
};

export const getSessionUserPreferenceById = async (
  id: string,
): Promise<SessionUserPreferenceRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_session_user_preferences
      WHERE id = ?
      LIMIT 1`,
    [id],
  )) as LocalSessionUserPreferenceRow | null;
  return row ? parseSessionUserPreference(row) : null;
};

export const listSessionUserPreferences = async (
  userId: string,
  workspaceId?: string,
): Promise<SessionUserPreferenceRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  const workspaceClause = workspaceId ? " AND workspace_id = ?" : "";
  const params = workspaceId ? [userId, workspaceId] : [userId];
  const rows = (await db.getAllAsync(
    `SELECT *
       FROM local_session_user_preferences
      WHERE user_id = ?${workspaceClause}
      ORDER BY updated_at DESC`,
    params,
  )) as LocalSessionUserPreferenceRow[];
  return rows.map(parseSessionUserPreference);
};

export interface SessionUserPreferenceSyncStatusUpdate {
  local_sync_status?: string;
  cloud_sync_status?: string;
  last_sync_error_code?: string | null;
  last_sync_error_message?: string | null;
  last_synced_at?: string | null;
}

export const updateSessionUserPreferenceSyncStatus = async (
  id: string,
  patch: SessionUserPreferenceSyncStatusUpdate,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const allowedKeys: (keyof SessionUserPreferenceSyncStatusUpdate)[] = [
    "local_sync_status",
    "cloud_sync_status",
    "last_sync_error_code",
    "last_sync_error_message",
    "last_synced_at",
  ];
  const entries = allowedKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(patch, key))
    .map((key) => ({ key, value: patch[key] ?? null }));
  if (entries.length === 0) return;

  const assignments = entries.map(({ key }) => `${key} = ?`).join(", ");
  const values = entries.map(({ value }) => value);
  await db.runAsync(
    `UPDATE local_session_user_preferences
        SET ${assignments}
      WHERE id = ?`,
    [...values, id],
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

export interface LocalContentSyncFields {
  local_sync_status: string;
  cloud_sync_status: string;
  last_sync_error_code: string | null;
  last_sync_error_message: string | null;
  last_synced_at: string | null;
}

export interface NoteRecord extends LocalContentSyncFields {
  id: string;
  workspace_id: string;
  project_id: string | null;
  session_id: string;
  text: string;
  recording_offset_ms: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const upsertNoteOnDb = async (
  db: SQLite.SQLiteDatabase,
  note: NoteRecord,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_notes
      (id, workspace_id, project_id, session_id, text,
       recording_offset_ms, created_by, created_at, updated_at, deleted_at,
       local_sync_status, cloud_sync_status, last_sync_error_code,
       last_sync_error_message, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id=excluded.workspace_id,
       project_id=excluded.project_id,
       session_id=excluded.session_id,
       text=excluded.text,
       recording_offset_ms=excluded.recording_offset_ms,
       updated_at=excluded.updated_at,
       deleted_at=excluded.deleted_at,
       local_sync_status=excluded.local_sync_status,
       cloud_sync_status=excluded.cloud_sync_status,
       last_sync_error_code=excluded.last_sync_error_code,
       last_sync_error_message=excluded.last_sync_error_message,
       last_synced_at=excluded.last_synced_at`,
    [
      note.id,
      note.workspace_id,
      note.project_id,
      note.session_id,
      note.text,
      note.recording_offset_ms,
      note.created_by,
      note.created_at,
      note.updated_at,
      note.deleted_at,
      note.local_sync_status,
      note.cloud_sync_status,
      note.last_sync_error_code,
      note.last_sync_error_message,
      note.last_synced_at,
    ],
  );
};

export const upsertNote = async (note: NoteRecord): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await upsertNoteOnDb(db, note);
};

// Backward-compatible name retained for older call sites.
export const insertNote = upsertNote;

export const getNote = async (id: string): Promise<NoteRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT * FROM local_notes WHERE id = ?`,
    [id],
  )) as NoteRecord | null;
  return row ?? null;
};

export const listNotesForSession = async (
  sessionId: string,
): Promise<NoteRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT * FROM local_notes
      WHERE session_id = ? AND deleted_at IS NULL
      ORDER BY recording_offset_ms ASC, created_at ASC`,
    [sessionId],
  )) as NoteRecord[];
};

export interface BookmarkRecord extends LocalContentSyncFields {
  id: string;
  workspace_id: string;
  project_id: string | null;
  session_id: string;
  label: string;
  recording_offset_ms: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const upsertBookmarkOnDb = async (
  db: SQLite.SQLiteDatabase,
  bookmark: BookmarkRecord,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_bookmarks
      (id, workspace_id, project_id, session_id, label,
       recording_offset_ms, created_by, created_at, updated_at, deleted_at,
       local_sync_status, cloud_sync_status, last_sync_error_code,
       last_sync_error_message, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id=excluded.workspace_id,
       project_id=excluded.project_id,
       session_id=excluded.session_id,
       label=excluded.label,
       recording_offset_ms=excluded.recording_offset_ms,
       updated_at=excluded.updated_at,
       deleted_at=excluded.deleted_at,
       local_sync_status=excluded.local_sync_status,
       cloud_sync_status=excluded.cloud_sync_status,
       last_sync_error_code=excluded.last_sync_error_code,
       last_sync_error_message=excluded.last_sync_error_message,
       last_synced_at=excluded.last_synced_at`,
    [
      bookmark.id,
      bookmark.workspace_id,
      bookmark.project_id,
      bookmark.session_id,
      bookmark.label,
      bookmark.recording_offset_ms,
      bookmark.created_by,
      bookmark.created_at,
      bookmark.updated_at,
      bookmark.deleted_at,
      bookmark.local_sync_status,
      bookmark.cloud_sync_status,
      bookmark.last_sync_error_code,
      bookmark.last_sync_error_message,
      bookmark.last_synced_at,
    ],
  );
};

export const upsertBookmark = async (
  bookmark: BookmarkRecord,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await upsertBookmarkOnDb(db, bookmark);
};

// Backward-compatible name retained for older call sites.
export const insertBookmark = upsertBookmark;

export const getBookmark = async (
  id: string,
): Promise<BookmarkRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT * FROM local_bookmarks WHERE id = ?`,
    [id],
  )) as BookmarkRecord | null;
  return row ?? null;
};

export const listBookmarksForSession = async (
  sessionId: string,
): Promise<BookmarkRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT * FROM local_bookmarks
      WHERE session_id = ? AND deleted_at IS NULL
      ORDER BY recording_offset_ms ASC, created_at ASC`,
    [sessionId],
  )) as BookmarkRecord[];
};

export interface TimelineEventRecord extends LocalContentSyncFields {
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

const upsertTimelineEventOnDb = async (
  db: SQLite.SQLiteDatabase,
  event: TimelineEventRecord,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_timeline_events
      (id, workspace_id, project_id, session_id, event_type,
       source_entity_type, source_entity_id, recording_offset_ms,
       created_by, created_at, local_sync_status, cloud_sync_status,
       last_sync_error_code, last_sync_error_message, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id=excluded.workspace_id,
       project_id=excluded.project_id,
       session_id=excluded.session_id,
       event_type=excluded.event_type,
       source_entity_type=excluded.source_entity_type,
       source_entity_id=excluded.source_entity_id,
       recording_offset_ms=excluded.recording_offset_ms,
       local_sync_status=excluded.local_sync_status,
       cloud_sync_status=excluded.cloud_sync_status,
       last_sync_error_code=excluded.last_sync_error_code,
       last_sync_error_message=excluded.last_sync_error_message,
       last_synced_at=excluded.last_synced_at`,
    [
      event.id,
      event.workspace_id,
      event.project_id,
      event.session_id,
      event.event_type,
      event.source_entity_type,
      event.source_entity_id,
      event.recording_offset_ms,
      event.created_by,
      event.created_at,
      event.local_sync_status,
      event.cloud_sync_status,
      event.last_sync_error_code,
      event.last_sync_error_message,
      event.last_synced_at,
    ],
  );
};

export const upsertTimelineEvent = async (
  event: TimelineEventRecord,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await upsertTimelineEventOnDb(db, event);
};

// Backward-compatible name retained for older call sites.
export const insertTimelineEvent = upsertTimelineEvent;

export const getTimelineEvent = async (
  id: string,
): Promise<TimelineEventRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT * FROM local_timeline_events WHERE id = ?`,
    [id],
  )) as TimelineEventRecord | null;
  return row ?? null;
};

export const listTimelineEvents = async (
  sessionId: string,
): Promise<TimelineEventRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT * FROM local_timeline_events
      WHERE session_id = ?
      ORDER BY recording_offset_ms ASC, created_at ASC, id ASC`,
    [sessionId],
  )) as TimelineEventRecord[];
};

export interface ContentSyncStatusUpdate {
  local_sync_status?: string;
  cloud_sync_status?: string;
  last_sync_error_code?: string | null;
  last_sync_error_message?: string | null;
  last_synced_at?: string | null;
}

const updateContentSyncStatus = async (
  table: "local_notes" | "local_bookmarks" | "local_timeline_events",
  id: string,
  patch: ContentSyncStatusUpdate,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const allowedKeys: (keyof ContentSyncStatusUpdate)[] = [
    "local_sync_status",
    "cloud_sync_status",
    "last_sync_error_code",
    "last_sync_error_message",
    "last_synced_at",
  ];
  const entries = allowedKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(patch, key))
    .map((key) => ({ key, value: patch[key] ?? null }));

  if (entries.length === 0) return;

  const setSql = entries.map(({ key }) => `${key} = ?`).join(", ");
  const values: (string | null)[] = entries.map(({ value }) => value);
  await db.runAsync(`UPDATE ${table} SET ${setSql} WHERE id = ?`, [
    ...values,
    id,
  ]);
};

export const updateNoteSyncStatus = (
  id: string,
  patch: ContentSyncStatusUpdate,
): Promise<void> => updateContentSyncStatus("local_notes", id, patch);

export const updateBookmarkSyncStatus = (
  id: string,
  patch: ContentSyncStatusUpdate,
): Promise<void> => updateContentSyncStatus("local_bookmarks", id, patch);

export const updateTimelineEventSyncStatus = (
  id: string,
  patch: ContentSyncStatusUpdate,
): Promise<void> => updateContentSyncStatus("local_timeline_events", id, patch);


// ============================================================================
// Recording metadata and binary upload queue
// ============================================================================

export interface RecordingRecord {
  id: string;
  workspace_id: string;
  project_id: string | null;
  session_id: string;
  local_file_uri: string | null;
  private_storage_path: string | null;
  mime_type: string;
  original_file_name: string;
  file_size: number;
  duration_ms: number;
  recording_format: string;
  checksum_sha256: string | null;
  upload_status: string;
  upload_error_code: string | null;
  upload_error_message: string | null;
  created_at: string;
  updated_at: string;
}

const RECORDING_COLUMNS = `id, workspace_id, project_id, session_id,
  local_file_uri, private_storage_path, mime_type, original_file_name,
  file_size, duration_ms, recording_format, checksum_sha256, upload_status,
  upload_error_code, upload_error_message, created_at, updated_at`;

const upsertRecordingOnDb = async (
  db: SQLite.SQLiteDatabase,
  record: RecordingRecord,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_recordings
      (id, workspace_id, project_id, session_id, local_file_uri,
       private_storage_path, mime_type, original_file_name, file_size,
       duration_ms, recording_format, checksum_sha256, upload_status,
       upload_error_code, upload_error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       id = excluded.id,
       workspace_id = excluded.workspace_id,
       project_id = excluded.project_id,
       local_file_uri = COALESCE(excluded.local_file_uri, local_recordings.local_file_uri),
       private_storage_path = excluded.private_storage_path,
       mime_type = excluded.mime_type,
       original_file_name = excluded.original_file_name,
       file_size = excluded.file_size,
       duration_ms = excluded.duration_ms,
       recording_format = excluded.recording_format,
       checksum_sha256 = excluded.checksum_sha256,
       upload_status = excluded.upload_status,
       upload_error_code = excluded.upload_error_code,
       upload_error_message = excluded.upload_error_message,
       updated_at = excluded.updated_at`,
    [
      record.id,
      record.workspace_id,
      record.project_id,
      record.session_id,
      record.local_file_uri,
      record.private_storage_path,
      record.mime_type,
      record.original_file_name,
      record.file_size,
      record.duration_ms,
      record.recording_format,
      record.checksum_sha256,
      record.upload_status,
      record.upload_error_code,
      record.upload_error_message,
      record.created_at,
      record.updated_at,
    ],
  );
};

export const upsertRecording = async (
  record: RecordingRecord,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await upsertRecordingOnDb(db, record);
};

export const getRecording = async (
  id: string,
): Promise<RecordingRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  return (await db.getFirstAsync(
    `SELECT ${RECORDING_COLUMNS} FROM local_recordings WHERE id = ?`,
    [id],
  )) as RecordingRecord | null;
};

export const getRecordingForSession = async (
  sessionId: string,
): Promise<RecordingRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  return (await db.getFirstAsync(
    `SELECT ${RECORDING_COLUMNS}
       FROM local_recordings
      WHERE session_id = ?
      LIMIT 1`,
    [sessionId],
  )) as RecordingRecord | null;
};

export const listRecordingsForWorkspace = async (
  workspaceId: string,
): Promise<RecordingRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT ${RECORDING_COLUMNS}
       FROM local_recordings
      WHERE workspace_id = ?
      ORDER BY updated_at DESC`,
    [workspaceId],
  )) as RecordingRecord[];
};

export interface RecordingUploadStatusUpdate {
  local_file_uri?: string | null;
  private_storage_path?: string | null;
  file_size?: number;
  upload_status?: string;
  upload_error_code?: string | null;
  upload_error_message?: string | null;
}

export const updateRecordingUploadStatus = async (
  id: string,
  patch: RecordingUploadStatusUpdate,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const allowedKeys: (keyof RecordingUploadStatusUpdate)[] = [
    "local_file_uri",
    "private_storage_path",
    "file_size",
    "upload_status",
    "upload_error_code",
    "upload_error_message",
  ];
  const entries = allowedKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(patch, key))
    .map((key) => ({ key, value: patch[key] ?? null }));
  if (entries.length === 0) return;

  const setSql = entries.map(({ key }) => `${key} = ?`).join(", ");
  const values = entries.map(({ value }) => value as string | number | null);
  await db.runAsync(
    `UPDATE local_recordings SET ${setSql}, updated_at = ? WHERE id = ?`,
    [...values, nowIso(), id],
  );
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
  private_storage_path: string | null;
  file_size: number;
  duration_ms: number | null;
  image_width: number | null;
  image_height: number | null;
  page_count: number | null;
  captured_at: string | null;
  recording_offset_ms: number;
  user_caption: string | null;
  checksum_sha256: string | null;
  upload_status: string;
  upload_error_code: string | null;
  upload_error_message: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const MEDIA_ASSET_COLUMNS = `id, workspace_id, project_id, session_id,
  added_by, asset_type, mime_type, original_file_name, sanitized_file_name,
  local_file_uri, private_storage_path, file_size, duration_ms, image_width,
  image_height, page_count, captured_at, recording_offset_ms, user_caption,
  checksum_sha256, upload_status, upload_error_code, upload_error_message,
  created_at, updated_at, deleted_at`;

const upsertMediaAssetOnDb = async (
  db: SQLite.SQLiteDatabase,
  asset: MediaAssetRecord,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_media_assets
      (id, workspace_id, project_id, session_id, added_by, asset_type,
       mime_type, original_file_name, sanitized_file_name, local_file_uri,
       private_storage_path, file_size, duration_ms, image_width, image_height,
       page_count, captured_at, recording_offset_ms, user_caption,
       checksum_sha256, upload_status, upload_error_code, upload_error_message,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       project_id = excluded.project_id,
       session_id = excluded.session_id,
       added_by = excluded.added_by,
       asset_type = excluded.asset_type,
       mime_type = excluded.mime_type,
       original_file_name = excluded.original_file_name,
       sanitized_file_name = excluded.sanitized_file_name,
       local_file_uri = COALESCE(excluded.local_file_uri, local_media_assets.local_file_uri),
       private_storage_path = excluded.private_storage_path,
       file_size = excluded.file_size,
       duration_ms = excluded.duration_ms,
       image_width = excluded.image_width,
       image_height = excluded.image_height,
       page_count = excluded.page_count,
       captured_at = excluded.captured_at,
       recording_offset_ms = excluded.recording_offset_ms,
       user_caption = excluded.user_caption,
       checksum_sha256 = excluded.checksum_sha256,
       upload_status = excluded.upload_status,
       upload_error_code = excluded.upload_error_code,
       upload_error_message = excluded.upload_error_message,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`,
    [
      asset.id,
      asset.workspace_id,
      asset.project_id,
      asset.session_id,
      asset.added_by,
      asset.asset_type,
      asset.mime_type,
      asset.original_file_name,
      asset.sanitized_file_name,
      asset.local_file_uri,
      asset.private_storage_path,
      asset.file_size,
      asset.duration_ms,
      asset.image_width,
      asset.image_height,
      asset.page_count,
      asset.captured_at,
      asset.recording_offset_ms,
      asset.user_caption,
      asset.checksum_sha256,
      asset.upload_status,
      asset.upload_error_code,
      asset.upload_error_message,
      asset.created_at,
      asset.updated_at,
      asset.deleted_at,
    ],
  );
};

export const upsertMediaAsset = async (
  asset: MediaAssetRecord,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await upsertMediaAssetOnDb(db, asset);
};

// Backward-compatible name retained for existing callers.
export const insertMediaAsset = upsertMediaAsset;

export const getMediaAsset = async (
  id: string,
): Promise<MediaAssetRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  return (await db.getFirstAsync(
    `SELECT ${MEDIA_ASSET_COLUMNS}
       FROM local_media_assets
      WHERE id = ?`,
    [id],
  )) as MediaAssetRecord | null;
};

export const listMediaAssetsForSession = async (
  sessionId: string,
): Promise<MediaAssetRecord[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT ${MEDIA_ASSET_COLUMNS}
       FROM local_media_assets
      WHERE session_id = ? AND deleted_at IS NULL
      ORDER BY recording_offset_ms ASC, created_at ASC`,
    [sessionId],
  )) as MediaAssetRecord[];
};

export interface MediaAssetUploadStatusUpdate {
  local_file_uri?: string | null;
  private_storage_path?: string | null;
  file_size?: number;
  upload_status?: string;
  upload_error_code?: string | null;
  upload_error_message?: string | null;
}

export const updateMediaAssetUploadStatus = async (
  id: string,
  patch: MediaAssetUploadStatusUpdate,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const allowedKeys: (keyof MediaAssetUploadStatusUpdate)[] = [
    "local_file_uri",
    "private_storage_path",
    "file_size",
    "upload_status",
    "upload_error_code",
    "upload_error_message",
  ];
  const entries = allowedKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(patch, key))
    .map((key) => ({ key, value: patch[key] ?? null }));
  if (entries.length === 0) return;

  const setSql = entries.map(({ key }) => `${key} = ?`).join(", ");
  const values = entries.map(({ value }) => value as string | number | null);
  await db.runAsync(
    `UPDATE local_media_assets SET ${setSql}, updated_at = ? WHERE id = ?`,
    [...values, nowIso(), id],
  );
};

export type UploadQueueStatus =
  | "pending"
  | "in_progress"
  | "failed"
  | "cancelled";

export interface UploadQueueRow {
  id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  source_entity_type: string;
  source_entity_id: string;
  local_file_uri: string;
  target_storage_path: string;
  queue_status: UploadQueueStatus;
  attempt_count: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_safe_error: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export const enqueueUpload = async (row: UploadQueueRow): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `INSERT INTO local_upload_queue
      (id, user_id, workspace_id, session_id, source_entity_type, source_entity_id,
       local_file_uri, target_storage_path, queue_status, attempt_count, next_retry_at,
       last_error_code, last_safe_error, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       user_id = excluded.user_id,
       workspace_id = excluded.workspace_id,
       session_id = excluded.session_id,
       source_entity_type = excluded.source_entity_type,
       source_entity_id = excluded.source_entity_id,
       local_file_uri = excluded.local_file_uri,
       target_storage_path = excluded.target_storage_path,
       queue_status = 'pending',
       attempt_count = 0,
       next_retry_at = NULL,
       last_error_code = NULL,
       last_safe_error = NULL,
       updated_at = excluded.updated_at`,
    [
      row.id,
      row.user_id,
      row.workspace_id,
      row.session_id,
      row.source_entity_type,
      row.source_entity_id,
      row.local_file_uri,
      row.target_storage_path,
      row.queue_status,
      row.attempt_count,
      row.next_retry_at,
      row.last_error_code,
      row.last_safe_error,
      row.idempotency_key,
      row.created_at,
      row.updated_at,
    ],
  );
};

export const listQueueByStatus = async (
  status: UploadQueueStatus,
): Promise<UploadQueueRow[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT * FROM local_upload_queue
      WHERE queue_status = ?
      ORDER BY created_at ASC`,
    [status],
  )) as UploadQueueRow[];
};

export const listAllQueue = async (): Promise<UploadQueueRow[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT * FROM local_upload_queue ORDER BY created_at ASC`,
  )) as UploadQueueRow[];
};

export const getNextEligibleUploadOperation = async (
  userId: string,
  now: string,
  sourceEntityType?: string,
): Promise<UploadQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;

  if (sourceEntityType) {
    return (await db.getFirstAsync(
      `SELECT *
         FROM local_upload_queue
        WHERE user_id = ?
          AND source_entity_type = ?
          AND queue_status = 'pending'
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [userId, sourceEntityType, now],
    )) as UploadQueueRow | null;
  }

  return (await db.getFirstAsync(
    `SELECT *
       FROM local_upload_queue
      WHERE user_id = ?
        AND queue_status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [userId, now],
  )) as UploadQueueRow | null;
};

export const claimUploadOperation = async (
  id: string,
): Promise<UploadQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const now = nowIso();
  const result = await db.runAsync(
    `UPDATE local_upload_queue
        SET queue_status = 'in_progress',
            attempt_count = attempt_count + 1,
            updated_at = ?
      WHERE id = ? AND queue_status = 'pending'`,
    [now, id],
  );
  if (result.changes !== 1) return null;
  return (await db.getFirstAsync(
    `SELECT * FROM local_upload_queue WHERE id = ?`,
    [id],
  )) as UploadQueueRow | null;
};

export const rescheduleUploadOperation = async (
  id: string,
  nextRetryAt: string,
  errorCode: string,
  safeError: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_upload_queue
        SET queue_status = 'pending',
            next_retry_at = ?,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ?`,
    [nextRetryAt, errorCode, safeError, nowIso(), id],
  );
};

export const markUploadOperationFailed = async (
  id: string,
  errorCode: string,
  safeError: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_upload_queue
        SET queue_status = 'failed',
            next_retry_at = NULL,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ?`,
    [errorCode, safeError, nowIso(), id],
  );
};

export const deleteCompletedUploadOperation = async (
  id: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(`DELETE FROM local_upload_queue WHERE id = ?`, [id]);
};

export const deleteUploadOperationsForEntity = async (
  sourceEntityType: string,
  sourceEntityId: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `DELETE FROM local_upload_queue
      WHERE source_entity_type = ? AND source_entity_id = ?`,
    [sourceEntityType, sourceEntityId],
  );
};

export const resetInProgressUploadOperations = async (
  userId: string,
  sourceEntityType?: string,
): Promise<number> => {
  const db = await openLocalDb();
  if (!db) return 0;

  if (sourceEntityType) {
    const result = await db.runAsync(
      `UPDATE local_upload_queue
          SET queue_status = 'pending',
              next_retry_at = NULL,
              updated_at = ?
        WHERE user_id = ?
          AND source_entity_type = ?
          AND queue_status = 'in_progress'`,
      [nowIso(), userId, sourceEntityType],
    );
    return result.changes;
  }

  const result = await db.runAsync(
    `UPDATE local_upload_queue
        SET queue_status = 'pending',
            next_retry_at = NULL,
            updated_at = ?
      WHERE user_id = ?
        AND queue_status = 'in_progress'`,
    [nowIso(), userId],
  );
  return result.changes;
};

export const requeueUploadOperationForEntity = async (
  sourceEntityType: string,
  sourceEntityId: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_upload_queue
        SET queue_status = 'pending',
            attempt_count = 0,
            next_retry_at = NULL,
            last_error_code = NULL,
            last_safe_error = NULL,
            updated_at = ?
      WHERE source_entity_type = ? AND source_entity_id = ?`,
    [nowIso(), sourceEntityType, sourceEntityId],
  );
};

export const countPendingUploads = async (): Promise<number> => {
  const db = await openLocalDb();
  if (!db) return 0;
  const row = (await db.getFirstAsync(
    `SELECT COUNT(*) AS n
       FROM local_upload_queue
      WHERE queue_status IN ('pending','in_progress')`,
  )) as { n: number } | null;
  return row?.n ?? 0;
};

export interface AtomicCreateRecordingWithUploadInput {
  recording: RecordingRecord;
  upload: UploadQueueRow;
}

export const atomicCreateRecordingWithUpload = async (
  input: AtomicCreateRecordingWithUploadInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await runSerializedLocalTransaction(db, async () => {
    await upsertRecordingOnDb(db, input.recording);
    const row = input.upload;
    await db.runAsync(
      `INSERT INTO local_upload_queue
        (id, user_id, workspace_id, session_id, source_entity_type,
         source_entity_id, local_file_uri, target_storage_path, queue_status,
         attempt_count, next_retry_at, last_error_code, last_safe_error,
         idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         user_id = excluded.user_id,
         workspace_id = excluded.workspace_id,
         session_id = excluded.session_id,
         source_entity_type = excluded.source_entity_type,
         source_entity_id = excluded.source_entity_id,
         local_file_uri = excluded.local_file_uri,
         target_storage_path = excluded.target_storage_path,
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        row.id,
        row.user_id,
        row.workspace_id,
        row.session_id,
        row.source_entity_type,
        row.source_entity_id,
        row.local_file_uri,
        row.target_storage_path,
        row.queue_status,
        row.attempt_count,
        row.next_retry_at,
        row.last_error_code,
        row.last_safe_error,
        row.idempotency_key,
        row.created_at,
        row.updated_at,
      ],
    );
  });
};

export const atomicRequeueRecordingUpload = async (input: {
  recordingId: string;
  upload: UploadQueueRow;
}): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await runSerializedLocalTransaction(db, async () => {
    await db.runAsync(
      `UPDATE local_recordings
          SET upload_status = 'pending',
              upload_error_code = NULL,
              upload_error_message = NULL,
              updated_at = ?
        WHERE id = ?`,
      [nowIso(), input.recordingId],
    );
    const row = input.upload;
    await db.runAsync(
      `INSERT INTO local_upload_queue
        (id, user_id, workspace_id, session_id, source_entity_type,
         source_entity_id, local_file_uri, target_storage_path, queue_status,
         attempt_count, next_retry_at, last_error_code, last_safe_error,
         idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         local_file_uri = excluded.local_file_uri,
         target_storage_path = excluded.target_storage_path,
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        row.id,
        row.user_id,
        row.workspace_id,
        row.session_id,
        row.source_entity_type,
        row.source_entity_id,
        row.local_file_uri,
        row.target_storage_path,
        row.idempotency_key,
        row.created_at,
        row.updated_at,
      ],
    );
  });
};

export interface AtomicCreateMediaAssetWithUploadAndTimelineInput {
  asset: MediaAssetRecord;
  timelineEvent: TimelineEventRecord;
  upload: UploadQueueRow;
  timelineQueue: {
    queueRowId: string;
    idempotencyKey: string;
  };
}

export const atomicCreateMediaAssetWithUploadAndTimeline = async (
  input: AtomicCreateMediaAssetWithUploadAndTimelineInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  await runSerializedLocalTransaction(db, async () => {
    await upsertMediaAssetOnDb(db, input.asset);
    await upsertTimelineEventOnDb(db, input.timelineEvent);

    const upload = input.upload;
    await db.runAsync(
      `INSERT INTO local_upload_queue
        (id, user_id, workspace_id, session_id, source_entity_type,
         source_entity_id, local_file_uri, target_storage_path, queue_status,
         attempt_count, next_retry_at, last_error_code, last_safe_error,
         idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         user_id = excluded.user_id,
         workspace_id = excluded.workspace_id,
         session_id = excluded.session_id,
         source_entity_type = excluded.source_entity_type,
         source_entity_id = excluded.source_entity_id,
         local_file_uri = excluded.local_file_uri,
         target_storage_path = excluded.target_storage_path,
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        upload.id,
        upload.user_id,
        upload.workspace_id,
        upload.session_id,
        upload.source_entity_type,
        upload.source_entity_id,
        upload.local_file_uri,
        upload.target_storage_path,
        upload.queue_status,
        upload.attempt_count,
        upload.next_retry_at,
        upload.last_error_code,
        upload.last_safe_error,
        upload.idempotency_key,
        upload.created_at,
        upload.updated_at,
      ],
    );

    await enqueueMetadataOnDb(db, {
      queueRowId: input.timelineQueue.queueRowId,
      userId: input.timelineEvent.created_by,
      workspaceId: input.timelineEvent.workspace_id,
      entityType: "timeline_event",
      entityId: input.timelineEvent.id,
      parentEntityType: "media_asset",
      parentEntityId: input.asset.id,
      priority: 500,
      idempotencyKey: input.timelineQueue.idempotencyKey,
      createdAt: input.timelineEvent.created_at,
    });
  });
};

export const atomicRequeueMediaAssetUpload = async (input: {
  assetId: string;
  upload: UploadQueueRow;
}): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  await runSerializedLocalTransaction(db, async () => {
    await db.runAsync(
      `UPDATE local_media_assets
          SET upload_status = 'pending',
              upload_error_code = NULL,
              upload_error_message = NULL,
              updated_at = ?
        WHERE id = ?`,
      [nowIso(), input.assetId],
    );

    const upload = input.upload;
    await db.runAsync(
      `INSERT INTO local_upload_queue
        (id, user_id, workspace_id, session_id, source_entity_type,
         source_entity_id, local_file_uri, target_storage_path, queue_status,
         attempt_count, next_retry_at, last_error_code, last_safe_error,
         idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         local_file_uri = excluded.local_file_uri,
         target_storage_path = excluded.target_storage_path,
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        upload.id,
        upload.user_id,
        upload.workspace_id,
        upload.session_id,
        upload.source_entity_type,
        upload.source_entity_id,
        upload.local_file_uri,
        upload.target_storage_path,
        upload.idempotency_key,
        upload.created_at,
        upload.updated_at,
      ],
    );

    // A permanent media failure may already have marked its timeline metadata
    // operation as failed. Requeue those events with the binary retry so a
    // successful upload can restore the complete cross-device timeline.
    const timelineEvents = await db.getAllAsync<{
      id: string;
      workspace_id: string;
      created_by: string;
      created_at: string;
    }>(
      `SELECT id, workspace_id, created_by, created_at
         FROM local_timeline_events
        WHERE source_entity_type = 'media_asset'
          AND source_entity_id = ?
          AND event_type IN ('image_added','video_added','document_added')`,
      [input.assetId],
    );

    for (const event of timelineEvents) {
      await db.runAsync(
        `UPDATE local_timeline_events
            SET local_sync_status = 'pending',
                cloud_sync_status = 'pending',
                last_sync_error_code = NULL,
                last_sync_error_message = NULL,
                last_synced_at = NULL
          WHERE id = ?`,
        [event.id],
      );
      await enqueueMetadataOnDb(db, {
        queueRowId: `timeline-upsert:${event.id}`,
        userId: event.created_by,
        workspaceId: event.workspace_id,
        entityType: "timeline_event",
        entityId: event.id,
        parentEntityType: "media_asset",
        parentEntityId: input.assetId,
        priority: 500,
        idempotencyKey: `upsert:timeline_event:${event.id}`,
        createdAt: event.created_at,
      });
    }
  });
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
export type MetadataQueueEntityType =
  | "project"
  | "session"
  | "note"
  | "bookmark"
  | "timeline_event"
  | "session_preference";
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
  await runSerializedLocalTransaction(db, async () => {
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

/**
 * Put an operation back into the queue because a parent entity is not ready.
 * The claim attempt is reversed so repeated lifecycle triggers do not exhaust
 * the retry budget while the parent project is still synchronizing.
 */
export const deferMetadataOperationForDependency = async (
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
           attempt_count = CASE
             WHEN attempt_count > 0 THEN attempt_count - 1
             ELSE 0
           END,
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
  await runSerializedLocalTransaction(db, async () => {
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

  await runSerializedLocalTransaction(db, async () => {
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

// ============================================================================
// Atomic local session creation/update
// ============================================================================

export interface AtomicUpsertSessionWithSyncInput {
  session: SessionRecord;
  queueRowId: string;
  idempotencyKey: string;
}

/**
 * Save the latest session state and coalesce its cloud UPSERT operation inside
 * one SQLite transaction. The queue reads the canonical row at execution time,
 * so rapid draft -> recording -> recorded updates synchronize only the latest
 * state without losing the stable session UUID.
 */
export const atomicUpsertSessionWithSync = async (
  input: AtomicUpsertSessionWithSyncInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const session = input.session;

  await runSerializedLocalTransaction(db, async () => {
    await upsertSessionOnDb(db, session);
    const now = nowIso();
    await db.runAsync(
      `INSERT INTO local_metadata_sync_queue
        (id, user_id, workspace_id, entity_type, entity_id, operation,
         parent_entity_type, parent_entity_id, priority,
         queue_status, attempt_count, next_retry_at,
         last_error_code, last_safe_error, idempotency_key,
         created_at, updated_at)
       VALUES (?, ?, ?, 'session', ?, 'UPSERT', ?, ?, 200,
               'pending', 0, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         user_id = excluded.user_id,
         workspace_id = excluded.workspace_id,
         parent_entity_type = excluded.parent_entity_type,
         parent_entity_id = excluded.parent_entity_id,
         priority = excluded.priority,
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        input.queueRowId,
        session.created_by,
        session.workspace_id,
        session.id,
        session.project_id == null ? null : "project",
        session.project_id,
        input.idempotencyKey,
        now,
        now,
      ],
    );
  });
};

export interface AtomicRequeueSessionSyncInput {
  sessionId: string;
  userId: string;
  workspaceId: string;
  projectId: string | null;
  queueRowId: string;
  idempotencyKey: string;
}

export const atomicRequeueSessionSync = async (
  input: AtomicRequeueSessionSyncInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const now = nowIso();

  await runSerializedLocalTransaction(db, async () => {
    await db.runAsync(
      `UPDATE local_sessions
          SET local_sync_status = 'pending',
              cloud_sync_status = 'pending',
              last_sync_error_code = NULL,
              last_sync_error_message = NULL
        WHERE id = ? AND deleted_at IS NULL`,
      [input.sessionId],
    );

    await db.runAsync(
      `INSERT INTO local_metadata_sync_queue
        (id, user_id, workspace_id, entity_type, entity_id, operation,
         parent_entity_type, parent_entity_id, priority,
         queue_status, attempt_count, next_retry_at,
         last_error_code, last_safe_error, idempotency_key,
         created_at, updated_at)
       VALUES (?, ?, ?, 'session', ?, 'UPSERT', ?, ?, 200,
               'pending', 0, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         user_id = excluded.user_id,
         workspace_id = excluded.workspace_id,
         parent_entity_type = excluded.parent_entity_type,
         parent_entity_id = excluded.parent_entity_id,
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
        input.sessionId,
        input.projectId == null ? null : "project",
        input.projectId,
        input.idempotencyKey,
        now,
        now,
      ],
    );
  });
};

// ============================================================================
// Atomic per-user session preference update
// ============================================================================

export interface AtomicUpsertSessionUserPreferenceWithSyncInput {
  preference: SessionUserPreferenceRecord;
  queueRowId: string;
  idempotencyKey: string;
}

export const atomicUpsertSessionUserPreferenceWithSync = async (
  input: AtomicUpsertSessionUserPreferenceWithSyncInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  const preference = input.preference;

  await runSerializedLocalTransaction(db, async () => {
    await upsertSessionUserPreferenceOnDb(db, preference);
    const now = nowIso();
    await db.runAsync(
      `INSERT INTO local_metadata_sync_queue
        (id, user_id, workspace_id, entity_type, entity_id, operation,
         parent_entity_type, parent_entity_id, priority,
         queue_status, attempt_count, next_retry_at,
         last_error_code, last_safe_error, idempotency_key,
         created_at, updated_at)
       VALUES (?, ?, ?, 'session_preference', ?, 'UPSERT', 'session', ?, 250,
               'pending', 0, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         user_id = excluded.user_id,
         workspace_id = excluded.workspace_id,
         parent_entity_type = excluded.parent_entity_type,
         parent_entity_id = excluded.parent_entity_id,
         priority = excluded.priority,
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        input.queueRowId,
        preference.user_id,
        preference.workspace_id,
        preference.id,
        preference.session_id,
        input.idempotencyKey,
        preference.created_at,
        now,
      ],
    );
  });
};

// ============================================================================
// Atomic local note/bookmark/timeline creation
// ============================================================================

interface AtomicSessionContentQueueInput {
  queueRowId: string;
  idempotencyKey: string;
}

const enqueueMetadataOnDb = async (
  db: SQLite.SQLiteDatabase,
  input: {
    queueRowId: string;
    userId: string;
    workspaceId: string;
    entityType: MetadataQueueEntityType;
    entityId: string;
    parentEntityType: string | null;
    parentEntityId: string | null;
    priority: number;
    idempotencyKey: string;
    createdAt: string;
  },
): Promise<void> => {
  const now = nowIso();
  await db.runAsync(
    `INSERT INTO local_metadata_sync_queue
      (id, user_id, workspace_id, entity_type, entity_id, operation,
       parent_entity_type, parent_entity_id, priority,
       queue_status, attempt_count, next_retry_at,
       last_error_code, last_safe_error, idempotency_key,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'UPSERT', ?, ?, ?,
             'pending', 0, NULL, NULL, NULL, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       user_id = excluded.user_id,
       workspace_id = excluded.workspace_id,
       parent_entity_type = excluded.parent_entity_type,
       parent_entity_id = excluded.parent_entity_id,
       priority = excluded.priority,
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
      input.entityType,
      input.entityId,
      input.parentEntityType,
      input.parentEntityId,
      input.priority,
      input.idempotencyKey,
      input.createdAt,
      now,
    ],
  );
};

export interface AtomicCreateNoteWithTimelineSyncInput {
  note: NoteRecord;
  timelineEvent: TimelineEventRecord;
  noteQueue: AtomicSessionContentQueueInput;
  timelineQueue: AtomicSessionContentQueueInput;
}

export const atomicCreateNoteWithTimelineSync = async (
  input: AtomicCreateNoteWithTimelineSyncInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  await runSerializedLocalTransaction(db, async () => {
    await upsertNoteOnDb(db, input.note);
    await upsertTimelineEventOnDb(db, input.timelineEvent);

    await enqueueMetadataOnDb(db, {
      queueRowId: input.noteQueue.queueRowId,
      userId: input.note.created_by,
      workspaceId: input.note.workspace_id,
      entityType: "note",
      entityId: input.note.id,
      parentEntityType: "session",
      parentEntityId: input.note.session_id,
      priority: 300,
      idempotencyKey: input.noteQueue.idempotencyKey,
      createdAt: input.note.created_at,
    });

    await enqueueMetadataOnDb(db, {
      queueRowId: input.timelineQueue.queueRowId,
      userId: input.timelineEvent.created_by,
      workspaceId: input.timelineEvent.workspace_id,
      entityType: "timeline_event",
      entityId: input.timelineEvent.id,
      parentEntityType: "note",
      parentEntityId: input.note.id,
      priority: 400,
      idempotencyKey: input.timelineQueue.idempotencyKey,
      createdAt: input.timelineEvent.created_at,
    });
  });
};

export interface AtomicCreateBookmarkWithTimelineSyncInput {
  bookmark: BookmarkRecord;
  timelineEvent: TimelineEventRecord;
  bookmarkQueue: AtomicSessionContentQueueInput;
  timelineQueue: AtomicSessionContentQueueInput;
}

export const atomicCreateBookmarkWithTimelineSync = async (
  input: AtomicCreateBookmarkWithTimelineSyncInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  await runSerializedLocalTransaction(db, async () => {
    await upsertBookmarkOnDb(db, input.bookmark);
    await upsertTimelineEventOnDb(db, input.timelineEvent);

    await enqueueMetadataOnDb(db, {
      queueRowId: input.bookmarkQueue.queueRowId,
      userId: input.bookmark.created_by,
      workspaceId: input.bookmark.workspace_id,
      entityType: "bookmark",
      entityId: input.bookmark.id,
      parentEntityType: "session",
      parentEntityId: input.bookmark.session_id,
      priority: 300,
      idempotencyKey: input.bookmarkQueue.idempotencyKey,
      createdAt: input.bookmark.created_at,
    });

    await enqueueMetadataOnDb(db, {
      queueRowId: input.timelineQueue.queueRowId,
      userId: input.timelineEvent.created_by,
      workspaceId: input.timelineEvent.workspace_id,
      entityType: "timeline_event",
      entityId: input.timelineEvent.id,
      parentEntityType: "bookmark",
      parentEntityId: input.bookmark.id,
      priority: 400,
      idempotencyKey: input.timelineQueue.idempotencyKey,
      createdAt: input.timelineEvent.created_at,
    });
  });
};

export interface AtomicCreateTimelineEventWithSyncInput {
  timelineEvent: TimelineEventRecord;
  timelineQueue: AtomicSessionContentQueueInput;
}

export const atomicCreateTimelineEventWithSync = async (
  input: AtomicCreateTimelineEventWithSyncInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  await runSerializedLocalTransaction(db, async () => {
    await upsertTimelineEventOnDb(db, input.timelineEvent);
    await enqueueMetadataOnDb(db, {
      queueRowId: input.timelineQueue.queueRowId,
      userId: input.timelineEvent.created_by,
      workspaceId: input.timelineEvent.workspace_id,
      entityType: "timeline_event",
      entityId: input.timelineEvent.id,
      parentEntityType: "session",
      parentEntityId: input.timelineEvent.session_id,
      priority: 400,
      idempotencyKey: input.timelineQueue.idempotencyKey,
      createdAt: input.timelineEvent.created_at,
    });
  });
};

// ============================================================================
// Durable cloud-aware session deletion
// ============================================================================

export type SessionDeletionQueueStatus =
  | "pending"
  | "in_progress"
  | "failed";

export interface SessionDeletionQueueRow {
  id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  queue_status: SessionDeletionQueueStatus;
  attempt_count: number;
  next_retry_at: string | null;
  storage_paths: string[];
  local_file_uris: string[];
  storage_deleted: boolean;
  cloud_metadata_deleted: boolean;
  local_files_deleted: boolean;
  last_error_code: string | null;
  last_safe_error: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalSessionDeletionQueueRow
  extends Omit<
    SessionDeletionQueueRow,
    | "storage_paths"
    | "local_file_uris"
    | "storage_deleted"
    | "cloud_metadata_deleted"
    | "local_files_deleted"
  > {
  storage_paths: string;
  local_file_uris: string;
  storage_deleted: number;
  cloud_metadata_deleted: number;
  local_files_deleted: number;
}

const parseSessionDeletionQueueRow = (
  row: LocalSessionDeletionQueueRow,
): SessionDeletionQueueRow => ({
  ...row,
  storage_paths: parseStringArray(row.storage_paths),
  local_file_uris: parseStringArray(row.local_file_uris),
  storage_deleted: row.storage_deleted === 1,
  cloud_metadata_deleted: row.cloud_metadata_deleted === 1,
  local_files_deleted: row.local_files_deleted === 1,
});

const uniqueNonEmptyStrings = (values: readonly string[]): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))];

export interface PrepareSessionDeletionInput {
  id: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  storagePaths: readonly string[];
  localFileUris: readonly string[];
  createdAt?: string;
}

/**
 * Hide the session locally and persist everything needed to finish cloud and
 * local cleanup after a restart. Existing metadata/upload operations for the
 * session are cancelled in the same transaction so they cannot race the
 * deletion worker.
 */
export const atomicPrepareSessionDeletion = async (
  input: PrepareSessionDeletionInput,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const now = nowIso();
  const storagePaths = uniqueNonEmptyStrings(input.storagePaths);
  const localFileUris = uniqueNonEmptyStrings(input.localFileUris);

  await runSerializedLocalTransaction(db, async () => {
    await db.runAsync(
      `UPDATE local_sessions
          SET deleted_at = COALESCE(deleted_at, ?),
              status = 'deleting',
              updated_at = ?,
              local_sync_status = 'local_only',
              cloud_sync_status = 'local_only',
              last_sync_error_code = NULL,
              last_sync_error_message = NULL
        WHERE id = ?`,
      [now, now, input.sessionId],
    );

    await db.runAsync(
      `UPDATE local_upload_queue
          SET queue_status = 'cancelled',
              next_retry_at = NULL,
              last_error_code = 'SESSION_DELETION_PENDING',
              last_safe_error = 'Upload cancelled because the session is being deleted.',
              updated_at = ?
        WHERE session_id = ?
          AND queue_status IN ('pending','in_progress','failed')`,
      [now, input.sessionId],
    );

    await db.runAsync(
      `DELETE FROM local_metadata_sync_queue
        WHERE (entity_type = 'session' AND entity_id = ?)
           OR (entity_type = 'note' AND entity_id IN (
                SELECT id FROM local_notes WHERE session_id = ?
              ))
           OR (entity_type = 'bookmark' AND entity_id IN (
                SELECT id FROM local_bookmarks WHERE session_id = ?
              ))
           OR (entity_type = 'timeline_event' AND entity_id IN (
                SELECT id FROM local_timeline_events WHERE session_id = ?
              ))
           OR (entity_type = 'session_preference' AND entity_id IN (
                SELECT id FROM local_session_user_preferences WHERE session_id = ?
              ))`,
      [
        input.sessionId,
        input.sessionId,
        input.sessionId,
        input.sessionId,
        input.sessionId,
      ],
    );

    await db.runAsync(
      `INSERT INTO local_session_deletion_queue
        (id, user_id, workspace_id, session_id, queue_status, attempt_count,
         next_retry_at, storage_paths, local_file_uris, storage_deleted,
         cloud_metadata_deleted, local_files_deleted, last_error_code,
         last_safe_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, 0, 0, 0, NULL, NULL, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id = excluded.user_id,
         workspace_id = excluded.workspace_id,
         queue_status = 'pending',
         attempt_count = 0,
         next_retry_at = NULL,
         storage_paths = excluded.storage_paths,
         local_file_uris = excluded.local_file_uris,
         last_error_code = NULL,
         last_safe_error = NULL,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.userId,
        input.workspaceId,
        input.sessionId,
        JSON.stringify(storagePaths),
        JSON.stringify(localFileUris),
        input.createdAt ?? now,
        now,
      ],
    );
  });
};

export const getSessionDeletionForSession = async (
  sessionId: string,
): Promise<SessionDeletionQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_session_deletion_queue
      WHERE session_id = ?
      LIMIT 1`,
    [sessionId],
  )) as LocalSessionDeletionQueueRow | null;
  return row ? parseSessionDeletionQueueRow(row) : null;
};

export const resetInProgressSessionDeletions = async (
  userId: string,
): Promise<number> => {
  const db = await openLocalDb();
  if (!db) return 0;
  const result = await db.runAsync(
    `UPDATE local_session_deletion_queue
        SET queue_status = 'pending',
            next_retry_at = NULL,
            last_error_code = 'DELETE_INTERRUPTED',
            last_safe_error = 'Cleanup was interrupted and will resume.',
            updated_at = ?
      WHERE user_id = ? AND queue_status = 'in_progress'`,
    [nowIso(), userId],
  );
  return result.changes;
};

export const getNextEligibleSessionDeletion = async (
  userId: string,
  now: string,
): Promise<SessionDeletionQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_session_deletion_queue
      WHERE user_id = ?
        AND queue_status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
      LIMIT 1`,
    [userId, now],
  )) as LocalSessionDeletionQueueRow | null;
  return row ? parseSessionDeletionQueueRow(row) : null;
};

export const claimSessionDeletion = async (
  id: string,
): Promise<SessionDeletionQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;

  let claimed: LocalSessionDeletionQueueRow | null = null;
  await runSerializedLocalTransaction(db, async () => {
    const current = (await db.getFirstAsync(
      `SELECT * FROM local_session_deletion_queue WHERE id = ?`,
      [id],
    )) as LocalSessionDeletionQueueRow | null;
    if (!current || !["pending", "failed"].includes(current.queue_status)) {
      return;
    }

    await db.runAsync(
      `UPDATE local_session_deletion_queue
          SET queue_status = 'in_progress',
              attempt_count = attempt_count + 1,
              next_retry_at = NULL,
              updated_at = ?
        WHERE id = ?`,
      [nowIso(), id],
    );
    claimed = (await db.getFirstAsync(
      `SELECT * FROM local_session_deletion_queue WHERE id = ?`,
      [id],
    )) as LocalSessionDeletionQueueRow | null;
  });

  return claimed ? parseSessionDeletionQueueRow(claimed) : null;
};

export interface SessionDeletionProgressUpdate {
  storage_paths?: string[];
  local_file_uris?: string[];
  storage_deleted?: boolean;
  cloud_metadata_deleted?: boolean;
  local_files_deleted?: boolean;
  queue_status?: SessionDeletionQueueStatus;
  next_retry_at?: string | null;
  last_error_code?: string | null;
  last_safe_error?: string | null;
}

export const updateSessionDeletionProgress = async (
  id: string,
  patch: SessionDeletionProgressUpdate,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const values: (string | number | null)[] = [];
  const assignments: string[] = [];
  const add = (column: string, value: string | number | null) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  if (Object.prototype.hasOwnProperty.call(patch, "storage_paths")) {
    add(
      "storage_paths",
      JSON.stringify(uniqueNonEmptyStrings(patch.storage_paths ?? [])),
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "local_file_uris")) {
    add(
      "local_file_uris",
      JSON.stringify(uniqueNonEmptyStrings(patch.local_file_uris ?? [])),
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "storage_deleted")) {
    add("storage_deleted", patch.storage_deleted ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "cloud_metadata_deleted")) {
    add("cloud_metadata_deleted", patch.cloud_metadata_deleted ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "local_files_deleted")) {
    add("local_files_deleted", patch.local_files_deleted ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "queue_status")) {
    add("queue_status", patch.queue_status ?? "pending");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "next_retry_at")) {
    add("next_retry_at", patch.next_retry_at ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "last_error_code")) {
    add("last_error_code", patch.last_error_code ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "last_safe_error")) {
    add("last_safe_error", patch.last_safe_error ?? null);
  }
  if (assignments.length === 0) return;

  await db.runAsync(
    `UPDATE local_session_deletion_queue
        SET ${assignments.join(", ")}, updated_at = ?
      WHERE id = ?`,
    [...values, nowIso(), id],
  );
};

export const rescheduleSessionDeletion = async (
  id: string,
  nextRetryAt: string,
  errorCode: string,
  safeError: string,
): Promise<void> =>
  updateSessionDeletionProgress(id, {
    queue_status: "pending",
    next_retry_at: nextRetryAt,
    last_error_code: errorCode,
    last_safe_error: safeError,
  });

export const markSessionDeletionFailed = async (
  id: string,
  errorCode: string,
  safeError: string,
): Promise<void> =>
  updateSessionDeletionProgress(id, {
    queue_status: "failed",
    next_retry_at: null,
    last_error_code: errorCode,
    last_safe_error: safeError,
  });

export const deleteCompletedSessionDeletion = async (
  id: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `DELETE FROM local_session_deletion_queue WHERE id = ?`,
    [id],
  );
};


export const listLocalFileUrisForSession = async (
  sessionId: string,
): Promise<string[]> => {
  const db = await openLocalDb();
  if (!db) return [];

  const rows = (await db.getAllAsync(
    `SELECT local_file_uri AS uri
       FROM local_recordings
      WHERE session_id = ? AND local_file_uri IS NOT NULL
     UNION ALL
     SELECT local_file_uri AS uri
       FROM local_media_assets
      WHERE session_id = ? AND local_file_uri IS NOT NULL
     UNION ALL
     SELECT local_file_uri AS uri
       FROM local_upload_queue
      WHERE session_id = ? AND local_file_uri IS NOT NULL`,
    [sessionId, sessionId, sessionId],
  )) as { uri: string | null }[];

  return uniqueNonEmptyStrings(
    rows.map((row) => row.uri ?? ""),
  );
};

export const listUploadQueueForSession = async (
  sessionId: string,
): Promise<UploadQueueRow[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT *
       FROM local_upload_queue
      WHERE session_id = ?
      ORDER BY created_at ASC`,
    [sessionId],
  )) as UploadQueueRow[];
};

/** Remove the complete local graph after cloud cleanup has succeeded. */
export const hardDeleteLocalSessionData = async (
  sessionId: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  await runSerializedLocalTransaction(db, async () => {
    await db.runAsync(
      `DELETE FROM local_metadata_sync_queue
        WHERE (entity_type = 'session' AND entity_id = ?)
           OR (entity_type = 'note' AND entity_id IN (
                SELECT id FROM local_notes WHERE session_id = ?
              ))
           OR (entity_type = 'bookmark' AND entity_id IN (
                SELECT id FROM local_bookmarks WHERE session_id = ?
              ))
           OR (entity_type = 'timeline_event' AND entity_id IN (
                SELECT id FROM local_timeline_events WHERE session_id = ?
              ))
           OR (entity_type = 'session_preference' AND entity_id IN (
                SELECT id FROM local_session_user_preferences WHERE session_id = ?
              ))`,
      [sessionId, sessionId, sessionId, sessionId, sessionId],
    );
    await db.runAsync(`DELETE FROM local_upload_queue WHERE session_id = ?`, [sessionId]);
    await db.runAsync(`DELETE FROM local_timeline_events WHERE session_id = ?`, [sessionId]);
    await db.runAsync(`DELETE FROM local_notes WHERE session_id = ?`, [sessionId]);
    await db.runAsync(`DELETE FROM local_bookmarks WHERE session_id = ?`, [sessionId]);
    await db.runAsync(
      `DELETE FROM local_session_user_preferences WHERE session_id = ?`,
      [sessionId],
    );
    await db.runAsync(`DELETE FROM local_media_assets WHERE session_id = ?`, [sessionId]);
    await db.runAsync(`DELETE FROM local_recordings WHERE session_id = ?`, [sessionId]);
    await db.runAsync(`DELETE FROM local_sessions WHERE id = ?`, [sessionId]);
  });
};

// ============================================================================
// Account deletion local cleanup.
// ============================================================================

export interface LocalAccountCleanupScope {
  workspaceIds: string[];
  sessionIds: string[];
  mediaAssetIds: string[];
  localFileUris: string[];
}

const uniqueStrings = (values: readonly string[]): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

const parseStringArrayJson = (value: string | null): string[] => {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const sqlInClause = (values: readonly string[]): {
  sql: string;
  params: string[];
} => ({
  sql:
    values.length > 0
      ? `(${values.map(() => "?").join(", ")})`
      : "(SELECT NULL WHERE 0)",
  params: [...values],
});

export const collectLocalAccountCleanupScope = async (
  userId: string,
  additionalWorkspaceIds: readonly string[] = [],
): Promise<LocalAccountCleanupScope> => {
  const db = await openLocalDb();
  const initialWorkspaceIds = uniqueStrings(additionalWorkspaceIds);
  if (!db) {
    return {
      workspaceIds: initialWorkspaceIds,
      sessionIds: [],
      mediaAssetIds: [],
      localFileUris: [],
    };
  }

  // Only workspace ids that are known to be owned by this account may be
  // used as whole-workspace cleanup scopes. User-authored rows can exist in a
  // shared workspace, and treating those workspace ids as owned would erase
  // other users' cached rows on a shared device.
  const workspaceRows = (await db.getAllAsync(
    `SELECT workspace_id AS value
       FROM local_profiles
      WHERE id = ? AND workspace_id IS NOT NULL`,
    [userId],
  )) as { value: string | null }[];

  const workspaceIds = uniqueStrings([
    ...initialWorkspaceIds,
    ...workspaceRows.map((row) => row.value ?? ""),
  ]);
  const workspaceClause = sqlInClause(workspaceIds);

  // Only sessions inside workspaces known to be owned by the deleted account
  // become whole-session cleanup scopes. A session authored by the user in a
  // non-owned/shared workspace can contain cached child rows authored by other
  // users; expanding through that session id would erase unrelated device data.
  const sessionRows = (await db.getAllAsync(
    `SELECT id AS value
       FROM local_sessions
      WHERE workspace_id IN ${workspaceClause.sql}
     UNION
     SELECT session_id AS value
       FROM local_session_deletion_queue
      WHERE workspace_id IN ${workspaceClause.sql}`,
    [
      ...workspaceClause.params,
      ...workspaceClause.params,
    ],
  )) as { value: string | null }[];

  const sessionIds = uniqueStrings(
    sessionRows.map((row) => row.value ?? ""),
  );
  const sessionClause = sqlInClause(sessionIds);

  const mediaRows = (await db.getAllAsync(
    `SELECT id AS value
       FROM local_media_assets
      WHERE added_by = ?
         OR workspace_id IN ${workspaceClause.sql}
         OR session_id IN ${sessionClause.sql}`,
    [
      userId,
      ...workspaceClause.params,
      ...sessionClause.params,
    ],
  )) as { value: string | null }[];

  const fileRows = (await db.getAllAsync(
    `SELECT local_file_uri AS value
       FROM local_recordings
      WHERE local_file_uri IS NOT NULL
        AND (
          workspace_id IN ${workspaceClause.sql}
          OR session_id IN ${sessionClause.sql}
        )
     UNION ALL
     SELECT local_file_uri AS value
       FROM local_media_assets
      WHERE local_file_uri IS NOT NULL
        AND (
          added_by = ?
          OR workspace_id IN ${workspaceClause.sql}
          OR session_id IN ${sessionClause.sql}
        )
     UNION ALL
     SELECT local_file_uri AS value
       FROM local_upload_queue
      WHERE local_file_uri IS NOT NULL
        AND (
          user_id = ?
          OR workspace_id IN ${workspaceClause.sql}
          OR session_id IN ${sessionClause.sql}
        )`,
    [
      ...workspaceClause.params,
      ...sessionClause.params,
      userId,
      ...workspaceClause.params,
      ...sessionClause.params,
      userId,
      ...workspaceClause.params,
      ...sessionClause.params,
    ],
  )) as { value: string | null }[];

  const deletionFileRows = (await db.getAllAsync(
    `SELECT local_file_uris AS value
       FROM local_session_deletion_queue
      WHERE user_id = ?
         OR workspace_id IN ${workspaceClause.sql}
         OR session_id IN ${sessionClause.sql}`,
    [
      userId,
      ...workspaceClause.params,
      ...sessionClause.params,
    ],
  )) as { value: string | null }[];

  return {
    workspaceIds,
    sessionIds,
    mediaAssetIds: uniqueStrings(
      mediaRows.map((row) => row.value ?? ""),
    ),
    localFileUris: uniqueStrings([
      ...fileRows.map((row) => row.value ?? ""),
      ...deletionFileRows.flatMap((row) =>
        parseStringArrayJson(row.value),
      ),
    ]),
  };
};

export const deleteLocalAccountData = async (input: {
  userId: string;
  workspaceIds: readonly string[];
  sessionIds: readonly string[];
}): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;

  const workspaceIds = uniqueStrings(input.workspaceIds);
  const sessionIds = uniqueStrings(input.sessionIds);
  const workspaceClause = sqlInClause(workspaceIds);
  const sessionClause = sqlInClause(sessionIds);

  await runSerializedLocalTransaction(db, async () => {
    await db.runAsync(
      `DELETE FROM local_metadata_sync_queue
        WHERE user_id = ?
           OR workspace_id IN ${workspaceClause.sql}`,
      [input.userId, ...workspaceClause.params],
    );
    await db.runAsync(
      `DELETE FROM local_upload_queue
        WHERE user_id = ?
           OR workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}`,
      [
        input.userId,
        ...workspaceClause.params,
        ...sessionClause.params,
      ],
    );
    await db.runAsync(
      `DELETE FROM local_session_deletion_queue
        WHERE user_id = ?
           OR workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}`,
      [
        input.userId,
        ...workspaceClause.params,
        ...sessionClause.params,
      ],
    );
    await db.runAsync(
      `DELETE FROM local_session_user_preferences
        WHERE user_id = ?
           OR workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}`,
      [
        input.userId,
        ...workspaceClause.params,
        ...sessionClause.params,
      ],
    );
    await db.runAsync(
      `DELETE FROM local_timeline_events
        WHERE created_by = ?
           OR workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}`,
      [
        input.userId,
        ...workspaceClause.params,
        ...sessionClause.params,
      ],
    );
    await db.runAsync(
      `DELETE FROM local_notes
        WHERE created_by = ?
           OR workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}`,
      [
        input.userId,
        ...workspaceClause.params,
        ...sessionClause.params,
      ],
    );
    await db.runAsync(
      `DELETE FROM local_bookmarks
        WHERE created_by = ?
           OR workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}`,
      [
        input.userId,
        ...workspaceClause.params,
        ...sessionClause.params,
      ],
    );
    await db.runAsync(
      `DELETE FROM local_media_assets
        WHERE added_by = ?
           OR workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}`,
      [
        input.userId,
        ...workspaceClause.params,
        ...sessionClause.params,
      ],
    );
    await db.runAsync(
      `DELETE FROM local_recordings
        WHERE workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}`,
      [...workspaceClause.params, ...sessionClause.params],
    );
    await db.runAsync(
      `DELETE FROM local_sessions
        WHERE workspace_id IN ${workspaceClause.sql}
           OR id IN ${sessionClause.sql}`,
      [...workspaceClause.params, ...sessionClause.params],
    );
    await db.runAsync(
      `DELETE FROM local_projects
        WHERE workspace_id IN ${workspaceClause.sql}`,
      [...workspaceClause.params],
    );
    await db.runAsync(
      `DELETE FROM local_profiles WHERE id = ?`,
      [input.userId],
    );
  });

  // The database runs in WAL mode. Truncate the journal only after the scoped
  // transaction commits so deleted private metadata is not retained in WAL.
  // A busy checkpoint is treated as a retryable local-cleanup failure; the
  // persistent deletion marker keeps private routes hidden until retry.
  const checkpoint = await db.getFirstAsync<{
    busy: number;
    log: number;
    checkpointed: number;
  }>("PRAGMA wal_checkpoint(TRUNCATE)");

  if (!checkpoint || Number(checkpoint.busy) !== 0) {
    throw new Error("The local account cleanup WAL checkpoint did not finish.");
  }
};
