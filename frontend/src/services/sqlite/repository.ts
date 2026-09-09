// Thin repository over SQLite for the entities that need to survive restart.
// Web returns empty arrays / no-ops since we don't ship a WASM DB in the preview.

import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";

import { openLocalDb } from "./schema";
import { runSerializedLocalTransaction } from "./transaction";
import {
  LocalReadSnapshotError, pauseSessionReadSnapshots, withLocalReadSnapshot,
  type LocalSnapshotQueries,
} from "./read-snapshot";

import {
  normalizeTranscriptHistoryError,
  normalizeTranscriptHistoryPageRequest,
  normalizeTranscriptHistoryScope,
  normalizeTranscriptHistoryVersionRequest,
  parseLocalTranscriptHistorySummary,
  TranscriptHistoryError,
  type LocalTranscriptHistoryPage,
  type LocalTranscriptHistoryVersion,
  type TranscriptHistoryPageRequest,
  type TranscriptHistoryReadContext,
  type TranscriptHistoryScope,
  type TranscriptHistoryVersionRequest,
} from "@/src/services/transcription/history-types";

import {
  normalizeTranscriptEditorScope,
  transcriptEditorUuid,
  validateTranscriptEditorText,
  TranscriptEditorError,
  type TranscriptEditorContinuityCommand,
  type TranscriptEditorContext,
  type TranscriptEditorDraftCommand,
  type TranscriptEditorLocalState,
  type TranscriptEditorSaveCommand,
  type TranscriptEditorSaveResult,
  type TranscriptEditorScope,
} from "@/src/services/transcription/editor-types";

import {
  isTranscriptLineageParent,
  MAX_TRANSCRIPT_LINEAGE_DEPTH,
  type CurrentTranscriptVersionSnapshot,
  type SyncedProcessingJob,
  type SyncedTranscriptSegment,
  type SyncedTranscriptVersion,
  type SyncedTranscriptVersionRecord,
  type SyncedTranscriptionRun,
} from "@/src/services/transcription/result-types";

// 3E.1 read-only history: bounded metadata pages and exact Full Text details.
// No current switching, draft/outbox admission, segments, or network work here.
const historySummaryColumns = `id, workspace_id, session_id, version, version_origin,
  version_status, parent_version_id, created_by, transcription_run_id,
  content_checksum_sha256, created_at, is_current`;

const withTranscriptHistoryDb = async <T>(
  input: TranscriptHistoryReadContext,
  operation: (db: LocalSnapshotQueries, scope: TranscriptHistoryScope) => Promise<T>,
): Promise<T> => {
  const scope = normalizeTranscriptHistoryScope(input.scope);
  const assertActive = input.assertActive;
  if (typeof assertActive !== "function") throw new TranscriptHistoryError("HISTORY_INPUT_INVALID");
  try {
    assertActive();
    const result = await withLocalReadSnapshot({ ...scope, assertActive }, async (db) => {
      assertActive();
      const session = await db.getFirstAsync<{
        id: string; workspace_id: string; status: string; deleted_at: string | null;
      }>(`SELECT id, workspace_id, status, deleted_at FROM local_sessions
          WHERE id = ? AND workspace_id = ? LIMIT 1`, [scope.sessionId, scope.workspaceId]);
      const deleting = await db.getFirstAsync<{ id: string }>(
        "SELECT id FROM local_session_deletion_queue WHERE session_id = ? LIMIT 1", [scope.sessionId]);
      if (!session || session.id !== scope.sessionId || session.workspace_id !== scope.workspaceId ||
          typeof session.status !== "string" || session.deleted_at !== null ||
          session.status === "deleting" || session.status === "deleted" || deleting) {
        throw new TranscriptHistoryError("HISTORY_SESSION_UNAVAILABLE");
      }
      assertActive();
      const value = await operation(db, scope);
      assertActive();
      return value;
    });
    assertActive();
    return result;
  } catch (failure) {
    // Preserve the caller's precise supersession/auth error when available.
    try { assertActive(); } catch (contextError) { throw normalizeTranscriptHistoryError(contextError); }
    if (failure instanceof LocalReadSnapshotError) {
      switch (failure.code) {
        case "LOCAL_READ_STORAGE_UNAVAILABLE": throw new TranscriptHistoryError("HISTORY_LOCAL_STORAGE_UNAVAILABLE");
        case "LOCAL_READ_AUTH_REQUIRED": throw new TranscriptHistoryError("HISTORY_AUTH_REQUIRED");
        case "LOCAL_READ_CONTEXT_INACTIVE":
        case "LOCAL_READ_CANCELLED": throw new TranscriptHistoryError("HISTORY_CONTEXT_INACTIVE");
        case "LOCAL_READ_DELETION_PENDING": throw new TranscriptHistoryError("HISTORY_DELETION_PENDING");
      }
    }
    throw normalizeTranscriptHistoryError(failure);
  }
};

export const listLocalTranscriptHistoryPage = async (
  input: TranscriptHistoryReadContext & TranscriptHistoryPageRequest,
): Promise<LocalTranscriptHistoryPage> => {
  const scope = normalizeTranscriptHistoryScope(input.scope);
  const { pageSize, cursor } = normalizeTranscriptHistoryPageRequest(scope, input);
  return withTranscriptHistoryDb({ scope, assertActive: input.assertActive }, async (db) => {
    const rows = await db.getAllAsync<unknown>(
      `SELECT ${historySummaryColumns} FROM local_transcript_versions
        WHERE workspace_id = ? AND session_id = ? AND version_status = 'final'
          ${cursor ? "AND version <= ? AND version < ?" : ""}
        ORDER BY version DESC LIMIT ?`,
      cursor ? [scope.workspaceId, scope.sessionId, cursor.upperVersion, cursor.beforeVersion, pageSize + 1]
        : [scope.workspaceId, scope.sessionId, pageSize + 1],
    );
    if (!Array.isArray(rows) || rows.length > pageSize + 1) throw new TranscriptHistoryError("HISTORY_CACHE_INVALID");
    const versions = rows.map((row) => parseLocalTranscriptHistorySummary(row, scope));
    const ids = new Set<string>();
    let previous = Number.POSITIVE_INFINITY;
    let currentCount = 0;
    for (const version of versions) {
      if (ids.has(version.id) || version.version >= previous ||
          (cursor && (version.version > cursor.upperVersion || version.version >= cursor.beforeVersion))) {
        throw new TranscriptHistoryError("HISTORY_CACHE_INVALID");
      }
      ids.add(version.id);
      previous = version.version;
      if (version.is_current) currentCount += 1;
    }
    if (currentCount > 1) throw new TranscriptHistoryError("HISTORY_CACHE_INVALID");
    const visible = versions.slice(0, pageSize);
    const upperVersion = cursor?.upperVersion ?? versions[0]?.version ?? null;
    const last = visible.at(-1);
    return {
      scope: { ...scope }, availability: "local_cache_only", versions: visible,
      windowUpperVersion: upperVersion,
      nextCursor: versions.length > pageSize && last && upperVersion !== null
        ? { scope: { ...scope }, upperVersion, beforeVersion: last.version } : null,
    };
  });
};

export const loadLocalTranscriptHistoryVersion = async (
  input: TranscriptHistoryReadContext & TranscriptHistoryVersionRequest,
): Promise<LocalTranscriptHistoryVersion> => {
  const scope = normalizeTranscriptHistoryScope(input.scope);
  const { versionId, expectedVersion } = normalizeTranscriptHistoryVersionRequest(input);
  return withTranscriptHistoryDb({ scope, assertActive: input.assertActive }, async (db) => {
    const row = await db.getFirstAsync<Record<string, unknown>>(
      `SELECT ${historySummaryColumns}, plain_text FROM local_transcript_versions
        WHERE id = ? AND workspace_id = ? AND session_id = ? AND version_status = 'final' LIMIT 1`,
      [versionId, scope.workspaceId, scope.sessionId],
    );
    if (!row) return { kind: "not_cached", availability: "local_cache_only", scope: { ...scope }, versionId };
    const version = parseLocalTranscriptHistorySummary(row, scope);
    if (version.id !== versionId || (expectedVersion !== undefined && version.version !== expectedVersion) ||
        typeof row.plain_text !== "string" || (version.version_origin === "user_edit" && row.plain_text.trim().length === 0)) {
      throw new TranscriptHistoryError("HISTORY_CACHE_INVALID");
    }
    return { kind: "ready", availability: "local_cache_only", scope: { ...scope },
      version, rawPlainText: row.plain_text };
  });
};

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


export type TranscriptionRequestQueueStatus =
  | "pending"
  | "submitting"
  | "submitted"
  | "failed"
  | "cancelled";

interface LocalTranscriptionRequestQueueRow {
  id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  recording_id: string;
  spoken_language_mode: string;
  expected_spoken_languages: string;
  queue_status: TranscriptionRequestQueueStatus;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  server_job_id: string | null;
  last_error_code: string | null;
  last_safe_error: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface TranscriptionRequestQueueRow {
  id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  recording_id: string;
  spoken_language_mode: string;
  expected_spoken_languages: string[];
  queue_status: TranscriptionRequestQueueStatus;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  server_job_id: string | null;
  last_error_code: string | null;
  last_safe_error: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

const parseTranscriptionRequestQueueRow = (
  row: LocalTranscriptionRequestQueueRow,
): TranscriptionRequestQueueRow => ({
  ...row,
  expected_spoken_languages: parseStringArray(row.expected_spoken_languages),
});

export interface TranscriptEditDraftRow {
  user_id: string;
  workspace_id: string;
  session_id: string;
  base_version_id: string;
  plain_text: string;
  created_at: string;
  updated_at: string;
}

export type TranscriptEditQueueStatus =
  | "pending"
  | "submitting"
  | "failed"
  | "conflict"
  | "succeeded"
  | "cancelled";

export interface TranscriptEditQueueRow {
  id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  expected_current_version_id: string;
  plain_text: string;
  queue_status: TranscriptEditQueueStatus;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_safe_error: string | null;
  created_at: string;
  updated_at: string;
}

export const saveTranscriptEditDraft = async (input: {
  userId: string;
  workspaceId: string;
  sessionId: string;
  baseVersionId: string;
  plainText: string;
}): Promise<TranscriptEditDraftRow> => {
  const timestamp = nowIso();
  const row: TranscriptEditDraftRow = {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    session_id: input.sessionId,
    base_version_id: input.baseVersionId,
    plain_text: input.plainText,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const db = await openLocalDb();
  if (!db) return row;

  await db.runAsync(
    `INSERT INTO local_transcript_edit_drafts
      (user_id, workspace_id, session_id, base_version_id, plain_text,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, session_id) DO UPDATE SET
       plain_text = excluded.plain_text,
       updated_at = excluded.updated_at`,
    [
      row.user_id,
      row.workspace_id,
      row.session_id,
      row.base_version_id,
      row.plain_text,
      row.created_at,
      row.updated_at,
    ],
  );

  const saved = (await db.getFirstAsync(
    `SELECT *
       FROM local_transcript_edit_drafts
      WHERE user_id = ? AND session_id = ?
      LIMIT 1`,
    [row.user_id, row.session_id],
  )) as TranscriptEditDraftRow | null;
  return saved ?? row;
};

export const getTranscriptEditDraft = async (
  userId: string,
  sessionId: string,
): Promise<TranscriptEditDraftRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  return (await db.getFirstAsync(
    `SELECT *
       FROM local_transcript_edit_drafts
      WHERE user_id = ? AND session_id = ?
      LIMIT 1`,
    [userId, sessionId],
  )) as TranscriptEditDraftRow | null;
};

export const deleteTranscriptEditDraft = async (
  userId: string,
  sessionId: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `DELETE FROM local_transcript_edit_drafts
      WHERE user_id = ? AND session_id = ?`,
    [userId, sessionId],
  );
};

const transcriptEditQueueReplayMatches = (
  existing: TranscriptEditQueueRow,
  input: {
    userId: string;
    workspaceId: string;
    sessionId: string;
    expectedCurrentVersionId: string;
    plainText: string;
  },
): boolean =>
  existing.user_id === input.userId &&
  existing.workspace_id === input.workspaceId &&
  existing.session_id === input.sessionId &&
  existing.expected_current_version_id === input.expectedCurrentVersionId &&
  existing.plain_text === input.plainText;

export const enqueueTranscriptEditSnapshot = async (input: {
  clientVersionId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  expectedCurrentVersionId: string;
  plainText: string;
  maxAttempts?: number;
}): Promise<TranscriptEditQueueRow> => {
  if (input.plainText.trim().length === 0) {
    throw new Error("Transcript edit text must not be blank.");
  }
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("Transcript edit max attempts must be a positive integer.");
  }

  const timestamp = nowIso();
  const row: TranscriptEditQueueRow = {
    id: input.clientVersionId,
    user_id: input.userId,
    workspace_id: input.workspaceId,
    session_id: input.sessionId,
    expected_current_version_id: input.expectedCurrentVersionId,
    plain_text: input.plainText,
    queue_status: "pending",
    attempt_count: 0,
    max_attempts: maxAttempts,
    next_retry_at: null,
    last_error_code: null,
    last_safe_error: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const db = await openLocalDb();
  if (!db) return row;

  return runSerializedLocalTransaction(db, async () => {
    const existing = (await db.getFirstAsync(
      `SELECT * FROM local_transcript_edit_queue WHERE id = ? LIMIT 1`,
      [row.id],
    )) as TranscriptEditQueueRow | null;
    if (existing) {
      if (!transcriptEditQueueReplayMatches(existing, input)) {
        throw new Error("Transcript edit client version id was reused with different content.");
      }
      return existing;
    }

    await db.runAsync(
      `INSERT INTO local_transcript_edit_queue
        (id, user_id, workspace_id, session_id, expected_current_version_id,
         plain_text, queue_status, attempt_count, max_attempts, next_retry_at,
         last_error_code, last_safe_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.user_id,
        row.workspace_id,
        row.session_id,
        row.expected_current_version_id,
        row.plain_text,
        row.queue_status,
        row.attempt_count,
        row.max_attempts,
        row.next_retry_at,
        row.last_error_code,
        row.last_safe_error,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  });
};

/** A run-owned guard. Paused or superseded runs may not mutate queue state. */
export interface TranscriptEditQueueGuard {
  userId: string;
  assertActive: () => void;
}

// Use the outer table name in both SELECT and UPDATE queries. A cached edit
// must not be submitted after local session deletion, even while offline.
const transcriptEditLiveSessionSql = `
  EXISTS (
    SELECT 1 FROM local_sessions edit_session
     WHERE edit_session.id = local_transcript_edit_queue.session_id
       AND edit_session.workspace_id = local_transcript_edit_queue.workspace_id
       AND edit_session.deleted_at IS NULL
       AND edit_session.status NOT IN ('deleting','deleted')
  )
  AND NOT EXISTS (
    SELECT 1 FROM local_session_deletion_queue edit_deletion
     WHERE edit_deletion.session_id = local_transcript_edit_queue.session_id
  )
`;

const withTranscriptEditQueueDb = async <T>(
  fallback: T,
  guard: TranscriptEditQueueGuard | undefined,
  operation: (db: SQLite.SQLiteDatabase) => Promise<T>,
): Promise<T> => {
  guard?.assertActive();
  const db = await openLocalDb();
  if (!db) {
    if (guard) throw new Error("Transcript edit queue storage is unavailable.");
    return fallback;
  }
  // Share the editor transaction lane. In particular, claim must COMMIT before
  // its caller starts an RPC; no network operation belongs in this callback.
  return runSerializedLocalTransaction(db, async () => {
    guard?.assertActive();
    const result = await operation(db);
    guard?.assertActive();
    return result;
  });
};

const requireTranscriptEditQueueUser = (
  userId: string,
  guard?: TranscriptEditQueueGuard,
): void => {
  if (guard && guard.userId !== userId) {
    throw new Error("The transcript edit queue user changed.");
  }
};

const transcriptEditAttemptLimit = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("The transcript edit attempt limit is invalid.");
  }
  return value;
};

const requireTranscriptEditQueueTransition = (
  changes: number,
  guard?: TranscriptEditQueueGuard,
): void => {
  if (guard && changes !== 1) {
    throw new Error("The claimed transcript edit is no longer available.");
  }
};

export const getNextEligibleTranscriptEditQueue = async (
  userId: string,
  now: string,
  maxAttempts = 5,
  guard?: TranscriptEditQueueGuard,
): Promise<TranscriptEditQueueRow | null> => {
  requireTranscriptEditQueueUser(userId, guard);
  const limit = transcriptEditAttemptLimit(maxAttempts);
  return withTranscriptEditQueueDb<TranscriptEditQueueRow | null>(null, guard, (db) =>
    db.getFirstAsync<TranscriptEditQueueRow>(
      `SELECT * FROM local_transcript_edit_queue
        WHERE user_id = ?
          AND queue_status IN ('pending','failed')
          AND attempt_count < max_attempts AND attempt_count < ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
          AND ${transcriptEditLiveSessionSql}
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [userId, limit, now],
    ),
  );
};

/** Durable retry schedule; eligibility and claim use the same budget/scope. */
export const getNextTranscriptEditWakeAt = async (
  userId: string,
  now: string,
  maxAttempts = 5,
  guard?: TranscriptEditQueueGuard,
): Promise<string | null> => {
  requireTranscriptEditQueueUser(userId, guard);
  const limit = transcriptEditAttemptLimit(maxAttempts);
  return withTranscriptEditQueueDb<string | null>(null, guard, async (db) => {
    const row = await db.getFirstAsync<{ wake_at: string | null }>(
      `SELECT MIN(COALESCE(next_retry_at, ?)) AS wake_at
         FROM local_transcript_edit_queue
        WHERE user_id = ?
          AND queue_status IN ('pending','failed')
          AND attempt_count < max_attempts AND attempt_count < ?
          AND ${transcriptEditLiveSessionSql}`,
      [now, userId, limit],
    );
    return row?.wake_at ?? null;
  });
};

export const listTranscriptEditQueueForSession = async (
  userId: string,
  sessionId: string,
): Promise<TranscriptEditQueueRow[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT *
       FROM local_transcript_edit_queue
      WHERE user_id = ? AND session_id = ?
      ORDER BY created_at ASC`,
    [userId, sessionId],
  )) as TranscriptEditQueueRow[];
};

export const claimTranscriptEditQueue = async (
  id: string,
  guard?: TranscriptEditQueueGuard,
  maxAttempts = 5,
): Promise<TranscriptEditQueueRow | null> => {
  const limit = transcriptEditAttemptLimit(maxAttempts);
  return withTranscriptEditQueueDb<TranscriptEditQueueRow | null>(null, guard, async (db) => {
    const timestamp = nowIso();
    const result = await db.runAsync(
      `UPDATE local_transcript_edit_queue
          SET queue_status = 'submitting',
              attempt_count = attempt_count + 1,
              next_retry_at = NULL,
              last_error_code = NULL,
              last_safe_error = NULL,
              updated_at = ?
        WHERE id = ?
          AND queue_status IN ('pending','failed')
          AND attempt_count < max_attempts AND attempt_count < ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
          AND (? IS NULL OR user_id = ?)
          AND ${transcriptEditLiveSessionSql}`,
      [timestamp, id, limit, timestamp, guard?.userId ?? null, guard?.userId ?? null],
    );
    if (result.changes !== 1) return null;
    const claimed = await db.getFirstAsync<TranscriptEditQueueRow>(
      "SELECT * FROM local_transcript_edit_queue WHERE id = ? LIMIT 1", [id],
    );
    if (!claimed || claimed.id !== id || claimed.queue_status !== "submitting" ||
        (guard && claimed.user_id !== guard.userId)) {
      throw new Error("The transcript edit claim no longer matches its operation.");
    }
    return claimed;
  });
};

/** Recheck the exact durable claim and live session immediately before RPC. */
export const canSubmitTranscriptEditQueue = async (
  claimed: TranscriptEditQueueRow,
  guard?: TranscriptEditQueueGuard,
): Promise<boolean> => {
  requireTranscriptEditQueueUser(claimed.user_id, guard);
  return withTranscriptEditQueueDb(false, guard, async (db) => {
    const row = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM local_transcript_edit_queue
        WHERE id = ? AND queue_status = 'submitting'
          AND user_id = ? AND workspace_id = ? AND session_id = ?
          AND expected_current_version_id = ? AND plain_text = ?
          AND ${transcriptEditLiveSessionSql}
        LIMIT 1`,
      [claimed.id, claimed.user_id, claimed.workspace_id, claimed.session_id,
        claimed.expected_current_version_id, claimed.plain_text],
    );
    return row?.id === claimed.id;
  });
};

export const deferTranscriptEditQueue = async (
  id: string,
  nextRetryAt: string,
  errorCode: string,
  safeError: string,
  guard?: TranscriptEditQueueGuard,
): Promise<void> => withTranscriptEditQueueDb<void>(undefined, guard, async (db) => {
  const result = await db.runAsync(
    `UPDATE local_transcript_edit_queue
        SET queue_status = 'pending',
            attempt_count = CASE
              WHEN attempt_count > 0 THEN attempt_count - 1
              ELSE 0
            END,
            next_retry_at = ?,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ? AND queue_status = 'submitting'
        AND (? IS NULL OR user_id = ?)`,
    [nextRetryAt, errorCode, safeError, nowIso(), id, guard?.userId ?? null, guard?.userId ?? null],
  );
  requireTranscriptEditQueueTransition(result.changes, guard);
});

export const rescheduleTranscriptEditQueue = async (
  id: string,
  nextRetryAt: string,
  errorCode: string,
  safeError: string,
  guard?: TranscriptEditQueueGuard,
): Promise<void> => withTranscriptEditQueueDb<void>(undefined, guard, async (db) => {
  const result = await db.runAsync(
    `UPDATE local_transcript_edit_queue
        SET queue_status = 'failed',
            next_retry_at = ?,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ? AND queue_status = 'submitting'
        AND (? IS NULL OR user_id = ?)`,
    [nextRetryAt, errorCode, safeError, nowIso(), id, guard?.userId ?? null, guard?.userId ?? null],
  );
  requireTranscriptEditQueueTransition(result.changes, guard);
});

export const completeTranscriptEditQueueSuccess = async (input: {
  queueId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  expectedCurrentVersionId: string;
  plainText: string;
}, guard?: TranscriptEditQueueGuard): Promise<void> => {
  requireTranscriptEditQueueUser(input.userId, guard);
  await withTranscriptEditQueueDb<void>(undefined, guard, async (db) => {
    const completion = await db.runAsync(
      `UPDATE local_transcript_edit_queue
          SET queue_status = 'succeeded',
              next_retry_at = NULL,
              last_error_code = NULL,
              last_safe_error = NULL,
              updated_at = ?
        WHERE id = ?
          AND queue_status = 'submitting'
          AND user_id = ?
          AND workspace_id = ?
          AND session_id = ?
          AND expected_current_version_id = ?
          AND plain_text = ?
          AND ${transcriptEditLiveSessionSql}`,
      [
        nowIso(),
        input.queueId,
        input.userId,
        input.workspaceId,
        input.sessionId,
        input.expectedCurrentVersionId,
        input.plainText,
      ],
    );
    if (completion.changes !== 1) {
      throw new Error(
        "Transcript edit queue completion no longer matches the claimed snapshot.",
      );
    }

    // Remove only the exact draft snapshot that produced this queue row. A user
    // may continue editing while a prior save is in flight; that newer draft
    // must survive completion of the older immutable server version.
    await db.runAsync(
      `DELETE FROM local_transcript_edit_drafts
        WHERE user_id = ?
          AND workspace_id = ?
          AND session_id = ?
          AND base_version_id = ?
          AND plain_text = ?`,
      [
        input.userId,
        input.workspaceId,
        input.sessionId,
        input.expectedCurrentVersionId,
        input.plainText,
      ],
    );
  });
};

const updateTranscriptEditQueueTerminal = async (
  id: string,
  queueStatus: "failed" | "conflict" | "cancelled",
  errorCode: string,
  safeError: string,
  guard?: TranscriptEditQueueGuard,
): Promise<void> => withTranscriptEditQueueDb<void>(undefined, guard, async (db) => {
  const result = await db.runAsync(
    `UPDATE local_transcript_edit_queue
        SET queue_status = ?,
            attempt_count = CASE
              WHEN ? = 'failed' THEN max_attempts
              ELSE attempt_count
            END,
            next_retry_at = NULL,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ? AND queue_status = 'submitting'
        ${guard ? "AND user_id = ?" : ""}`,
    [queueStatus, queueStatus, errorCode, safeError, nowIso(), id,
      ...(guard ? [guard.userId] : [])],
  );
  requireTranscriptEditQueueTransition(result.changes, guard);
});

export const markTranscriptEditQueueConflict = async (
  id: string,
  errorCode: string,
  safeError: string,
  guard?: TranscriptEditQueueGuard,
): Promise<void> =>
  updateTranscriptEditQueueTerminal(id, "conflict", errorCode, safeError, guard);

export const markTranscriptEditQueueFailed = async (
  id: string,
  errorCode: string,
  safeError: string,
  guard?: TranscriptEditQueueGuard,
): Promise<void> =>
  updateTranscriptEditQueueTerminal(id, "failed", errorCode, safeError, guard);

export const markTranscriptEditQueueCancelled = async (
  id: string,
  errorCode: string,
  safeError: string,
  guard?: TranscriptEditQueueGuard,
): Promise<void> =>
  updateTranscriptEditQueueTerminal(id, "cancelled", errorCode, safeError, guard);

export const resetSubmittingTranscriptEditQueue = async (
  userId: string,
  guard?: TranscriptEditQueueGuard,
): Promise<number> => {
  requireTranscriptEditQueueUser(userId, guard);
  return withTranscriptEditQueueDb(0, guard, async (db) => {
    const result = await db.runAsync(
      `UPDATE local_transcript_edit_queue
          SET queue_status = 'pending',
              attempt_count = CASE
                WHEN attempt_count > 0 THEN attempt_count - 1
                ELSE 0
              END,
              next_retry_at = NULL,
              updated_at = ?
        WHERE user_id = ? AND queue_status = 'submitting'
          AND ${transcriptEditLiveSessionSql}`,
      [nowIso(), userId],
    );
    return result.changes;
  });
};

// Guarded editor entry points (3D.2 patch 1). Legacy worker APIs above retain
// their contracts. The future editor must use these operations, not raw upserts.
const editorDraftFields = [
  "user_id", "workspace_id", "session_id", "base_version_id", "plain_text",
  "created_at", "updated_at",
] as const;

const editorDraftMatches = (
  actual: Readonly<TranscriptEditDraftRow> | null,
  expected: Readonly<TranscriptEditDraftRow> | null,
): boolean => actual === null || expected === null
  ? actual === expected
  : editorDraftFields.every((field) => actual[field] === expected[field]);

const requireEditorDraftExpectation = (
  scope: Readonly<TranscriptEditorScope>,
  expected: Readonly<TranscriptEditDraftRow> | null,
): TranscriptEditDraftRow | null => {
  if (expected === null) return null;
  if (!expected || expected.user_id !== scope.userId ||
      expected.workspace_id !== scope.workspaceId || expected.session_id !== scope.sessionId ||
      editorDraftFields.some((field) => typeof expected[field] !== "string") ||
      !Number.isFinite(Date.parse(expected.created_at)) ||
      !Number.isFinite(Date.parse(expected.updated_at))) {
    throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
  }
  transcriptEditorUuid(expected.base_version_id);
  return { ...expected };
};

let lastEditorWriteMs = 0;
const nextEditorTimestamp = (previous: TranscriptEditDraftRow | null): string => {
  lastEditorWriteMs = Math.max(Date.now(), lastEditorWriteMs + 1,
    previous ? Date.parse(previous.updated_at) + 1 : 0);
  return new Date(lastEditorWriteMs).toISOString();
};

const withTranscriptEditorDb = async <T>(
  context: TranscriptEditorContext,
  operation: (db: SQLite.SQLiteDatabase, scope: TranscriptEditorScope) => Promise<T>,
): Promise<T> => {
  const scope = normalizeTranscriptEditorScope(context.scope);
  context.assertActive();
  const db = await openLocalDb();
  if (!db) throw new TranscriptEditorError("EDITOR_LOCAL_STORAGE_UNAVAILABLE");
  return runSerializedLocalTransaction(db, async () => {
    context.assertActive();
    const session = await db.getFirstAsync<{ id: string; workspace_id: string;
      status: string; deleted_at: string | null }>(
      `SELECT id, workspace_id, status, deleted_at FROM local_sessions
        WHERE id = ? AND workspace_id = ? LIMIT 1`, [scope.sessionId, scope.workspaceId]);
    const deleting = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM local_session_deletion_queue WHERE session_id = ? LIMIT 1", [scope.sessionId]);
    if (!session || session.id !== scope.sessionId || session.workspace_id !== scope.workspaceId ||
        typeof session.status !== "string" || session.deleted_at !== null || session.status === "deleting" || session.status === "deleted" || deleting) {
      throw new TranscriptEditorError("EDITOR_SESSION_UNAVAILABLE");
    }
    context.assertActive();
    const value = await operation(db, scope);
    // If identity/deletion/generation changed while SQL was awaiting, roll back
    // this operation. Never emit a successful result before COMMIT has finished.
    context.assertActive();
    return value;
  });
};

const readEditorVersionOnDb = async (
  db: SQLite.SQLiteDatabase, scope: TranscriptEditorScope, versionId?: string,
): Promise<SyncedTranscriptVersionRecord | null> => {
  const row = await db.getFirstAsync<LocalTranscriptVersionRow>(
    `SELECT * FROM local_transcript_versions WHERE workspace_id = ? AND session_id = ?
      AND ${versionId ? "id = ?" : "is_current = 1"} LIMIT 1`,
    versionId ? [scope.workspaceId, scope.sessionId, versionId] : [scope.workspaceId, scope.sessionId]);
  if (!row) return null;
  if (row.workspace_id !== scope.workspaceId || row.session_id !== scope.sessionId ||
      (versionId ? row.id !== versionId : row.is_current !== 1) ||
      ![0, 1].includes(row.is_current) || row.version_status !== "final" ||
      !Number.isSafeInteger(row.version) || row.version < 1 ||
      !["provider", "user_edit", "import"].includes(row.version_origin) ||
      typeof row.plain_text !== "string") {
    throw new TranscriptEditorError("EDITOR_CACHE_INVALID");
  }
  try { transcriptEditorUuid(row.id); } catch { throw new TranscriptEditorError("EDITOR_CACHE_INVALID"); }
  return { ...row, language_summary: parseJsonObject(row.language_summary) ?? {}, is_current: row.is_current === 1 };
};

const readTranscriptEditorStateOnDb = async (
  db: SQLite.SQLiteDatabase, scope: TranscriptEditorScope,
): Promise<TranscriptEditorLocalState> => {
  const currentVersion = await readEditorVersionOnDb(db, scope);
  const draft = await db.getFirstAsync<TranscriptEditDraftRow>(
    "SELECT * FROM local_transcript_edit_drafts WHERE user_id = ? AND session_id = ? LIMIT 1",
    [scope.userId, scope.sessionId]);
  try { requireEditorDraftExpectation(scope, draft); } catch { throw new TranscriptEditorError("EDITOR_CACHE_INVALID"); }
  const queue = await db.getAllAsync<TranscriptEditQueueRow>(
    `SELECT * FROM local_transcript_edit_queue WHERE user_id = ? AND session_id = ?
      ORDER BY created_at ASC, id ASC`, [scope.userId, scope.sessionId]);
  for (const row of queue) {
    if (row.user_id !== scope.userId || row.workspace_id !== scope.workspaceId || row.session_id !== scope.sessionId ||
        !["pending", "submitting", "failed", "conflict", "succeeded", "cancelled"].includes(row.queue_status) ||
        !Number.isSafeInteger(row.max_attempts) || row.max_attempts < 1 ||
        !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 || row.attempt_count > row.max_attempts ||
        typeof row.plain_text !== "string") {
      throw new TranscriptEditorError("EDITOR_CACHE_INVALID");
    }
    try {
      transcriptEditorUuid(row.id);
      transcriptEditorUuid(row.expected_current_version_id);
    } catch { throw new TranscriptEditorError("EDITOR_CACHE_INVALID"); }
  }
  const baseVersion = draft ? (draft.base_version_id === currentVersion?.id
    ? currentVersion : await readEditorVersionOnDb(db, scope, draft.base_version_id)) : null;
  return { currentVersion, draft, baseVersion, queue };
};

export const loadTranscriptEditorState = async (
  context: TranscriptEditorContext,
): Promise<TranscriptEditorLocalState> => withTranscriptEditorDb(context, readTranscriptEditorStateOnDb);

const requireEditorDraftUnchanged = (
  state: TranscriptEditorLocalState, expected: TranscriptEditDraftRow | null,
): void => {
  if (!editorDraftMatches(state.draft, expected)) throw new TranscriptEditorError("EDITOR_DRAFT_CHANGED");
};

const requireEditorCurrentBase = (state: TranscriptEditorLocalState, baseId: string): void => {
  if (!state.currentVersion) throw new TranscriptEditorError("EDITOR_CURRENT_UNAVAILABLE");
  if (state.currentVersion.id !== baseId) throw new TranscriptEditorError("EDITOR_BASE_CHANGED");
  // The accepted edit (or server conflict) proves this cached base needs a
  // refresh. A different text must not become another request against that base.
  if (state.queue.some((row) => row.expected_current_version_id === baseId &&
      (row.queue_status === "succeeded" || row.queue_status === "conflict"))) {
    throw new TranscriptEditorError("EDITOR_REFRESH_REQUIRED");
  }
};

const requireNoUnresolvedEditorSave = (state: TranscriptEditorLocalState): void => {
  // Exhausting retries is not proof that a timed-out RPC never committed.
  // Preserve every failed snapshot; no cancellation, budget reset or replacement.
  if (state.queue.some((row) => row.queue_status === "failed")) {
    throw new TranscriptEditorError("EDITOR_OUTCOME_UNCONFIRMED");
  }
  if (state.queue.some((row) => row.queue_status === "pending" || row.queue_status === "submitting")) {
    throw new TranscriptEditorError("EDITOR_OPERATION_PENDING");
  }
};

const writeEditorDraftOnDb = async (
  db: SQLite.SQLiteDatabase, scope: TranscriptEditorScope,
  baseId: string, text: string, previous: TranscriptEditDraftRow | null,
): Promise<TranscriptEditDraftRow> => {
  if (previous && previous.base_version_id !== baseId) throw new TranscriptEditorError("EDITOR_BASE_PINNED");
  // An identical replay must not change the compare-and-swap token.
  if (previous?.plain_text === text) return previous;
  const timestamp = nextEditorTimestamp(previous);
  const row: TranscriptEditDraftRow = {
    user_id: scope.userId, workspace_id: scope.workspaceId, session_id: scope.sessionId,
    base_version_id: baseId, plain_text: text,
    created_at: previous?.created_at ?? timestamp, updated_at: timestamp,
  };
  if (previous) {
    const result = await db.runAsync(
      `UPDATE local_transcript_edit_drafts SET plain_text = ?, updated_at = ?
        WHERE user_id = ? AND workspace_id = ? AND session_id = ?
          AND base_version_id = ? AND plain_text = ? AND created_at = ? AND updated_at = ?`,
      [text, timestamp, scope.userId, scope.workspaceId, scope.sessionId, baseId,
        previous.plain_text, previous.created_at, previous.updated_at]);
    if (result.changes !== 1) throw new TranscriptEditorError("EDITOR_DRAFT_CHANGED");
  } else {
    await db.runAsync(
      `INSERT INTO local_transcript_edit_drafts
        (user_id, workspace_id, session_id, base_version_id, plain_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [scope.userId, scope.workspaceId, scope.sessionId, baseId, text, timestamp, timestamp]);
  }
  return row;
};

export const saveGuardedTranscriptEditDraft = async (
  input: TranscriptEditorContext & TranscriptEditorDraftCommand,
): Promise<TranscriptEditDraftRow> => {
  const scope = normalizeTranscriptEditorScope(input.scope);
  const expected = requireEditorDraftExpectation(scope, input.expectedDraft);
  const baseId = transcriptEditorUuid(input.baseVersionId);
  const text = input.plainText;
  validateTranscriptEditorText(text, true);
  return withTranscriptEditorDb({ scope, assertActive: input.assertActive }, async (db) => {
    const state = await readTranscriptEditorStateOnDb(db, scope);
    requireEditorDraftUnchanged(state, expected);
    if (!state.draft) requireEditorCurrentBase(state, baseId);
    return writeEditorDraftOnDb(db, scope, baseId, text, state.draft);
  });
};

export const enqueueGuardedTranscriptEditSnapshot = async (
  input: TranscriptEditorContext & TranscriptEditorSaveCommand,
): Promise<TranscriptEditorSaveResult> => {
  const scope = normalizeTranscriptEditorScope(input.scope);
  const expected = requireEditorDraftExpectation(scope, input.expectedDraft);
  const baseId = transcriptEditorUuid(input.baseVersionId);
  const id = transcriptEditorUuid(input.clientVersionId);
  const preserveNewerDraft = input.preserveNewerDraft === true;
  const text = input.plainText;
  if (id === baseId) throw new TranscriptEditorError("EDITOR_INPUT_INVALID");
  validateTranscriptEditorText(text, false);
  return withTranscriptEditorDb({ scope, assertActive: input.assertActive }, async (db) => {
    const state = await readTranscriptEditorStateOnDb(db, scope);
    const sameId = await db.getFirstAsync<TranscriptEditQueueRow>(
      "SELECT * FROM local_transcript_edit_queue WHERE id = ? LIMIT 1", [id]);
    const replay = { ...scope, expectedCurrentVersionId: baseId, plainText: text };
    if (sameId && !transcriptEditQueueReplayMatches(sameId, replay)) {
      throw new TranscriptEditorError("EDITOR_IDEMPOTENCY_CONFLICT");
    }
    // Replay before stale-base/draft checks: a successful prior save may already
    // have consumed that exact draft and advanced the current version.
    const existing = sameId ?? state.queue.find((row) => transcriptEditQueueReplayMatches(row, replay));
    if (existing) return { kind: "existing", operation: existing, draft: state.draft };
    requireNoUnresolvedEditorSave(state);
    requireEditorDraftUnchanged(state, expected);
    if (state.draft && state.draft.base_version_id !== baseId) throw new TranscriptEditorError("EDITOR_BASE_PINNED");
    if (state.draft && !state.baseVersion) throw new TranscriptEditorError("EDITOR_BASE_UNAVAILABLE");
    requireEditorCurrentBase(state, baseId);
    if (state.currentVersion?.plain_text === text) throw new TranscriptEditorError("EDITOR_UNCHANGED");
    // All original base, unresolved-operation and CAS guards above still apply.
    // Only the controller retrying an older frozen action requests preservation.
    const draft = preserveNewerDraft && state.draft
      ? state.draft
      : await writeEditorDraftOnDb(db, scope, baseId, text, state.draft);
    const timestamp = nowIso();
    const operation: TranscriptEditQueueRow = {
      id, user_id: scope.userId, workspace_id: scope.workspaceId, session_id: scope.sessionId,
      expected_current_version_id: baseId, plain_text: text, queue_status: "pending",
      attempt_count: 0, max_attempts: 5, next_retry_at: null, last_error_code: null,
      last_safe_error: null, created_at: timestamp, updated_at: timestamp,
    };
    await db.runAsync(
      `INSERT INTO local_transcript_edit_queue
        (id, user_id, workspace_id, session_id, expected_current_version_id, plain_text,
         queue_status, attempt_count, max_attempts, next_retry_at, last_error_code,
         last_safe_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 5, NULL, NULL, NULL, ?, ?)`,
      [id, scope.userId, scope.workspaceId, scope.sessionId, baseId, text, timestamp, timestamp]);
    return { kind: "queued", operation, draft };
  });
};

/** Discard only the observed draft. It never cancels or deletes an outbound save. */
export const discardGuardedTranscriptEditDraft = async (
  input: TranscriptEditorContext & { expectedDraft: Readonly<TranscriptEditDraftRow> | null },
): Promise<void> => {
  const scope = normalizeTranscriptEditorScope(input.scope);
  const expected = requireEditorDraftExpectation(scope, input.expectedDraft);
  return withTranscriptEditorDb({ scope, assertActive: input.assertActive }, async (db) => {
    const state = await readTranscriptEditorStateOnDb(db, scope);
    requireNoUnresolvedEditorSave(state);
    requireEditorDraftUnchanged(state, expected);
    if (!expected) return;
    const result = await db.runAsync(
      `DELETE FROM local_transcript_edit_drafts WHERE user_id = ? AND workspace_id = ? AND session_id = ?
        AND base_version_id = ? AND plain_text = ? AND created_at = ? AND updated_at = ?`,
      [scope.userId, scope.workspaceId, scope.sessionId, expected.base_version_id,
        expected.plain_text, expected.created_at, expected.updated_at]);
    if (result.changes !== 1) throw new TranscriptEditorError("EDITOR_DRAFT_CHANGED");
  });
};

/**
 * Preserve a LIVE editor's newer buffer, without rebasing or making an outbox.
 * The controller owns/revokes the observation capability (including on discard).
 * Database absence alone is never used as evidence of why a draft disappeared.
 */
export const preserveTranscriptEditorContinuityDraft = async (
  input: TranscriptEditorContext & TranscriptEditorContinuityCommand,
): Promise<TranscriptEditDraftRow> => {
  const scope = normalizeTranscriptEditorScope(input.scope);
  const proof = input.proof;
  if (!proof || (proof.kind !== "observed_base" && proof.kind !== "completed_save") ||
      !proof.base || proof.base.workspace_id !== scope.workspaceId ||
      proof.base.session_id !== scope.sessionId || proof.base.version_status !== "final") {
    throw new TranscriptEditorError("EDITOR_RECOVERY_REJECTED");
  }
  const baseId = transcriptEditorUuid(proof.base.id);
  const text = input.plainText;
  validateTranscriptEditorText(text, true);
  // Capture scalars before the first await; caller mutation cannot widen scope.
  const base = { ...proof.base };
  const kind = proof.kind;
  const operationId = proof.kind === "completed_save" ? transcriptEditorUuid(proof.operationId) : null;
  const savedText = proof.kind === "completed_save" ? proof.savedPlainText : null;
  return withTranscriptEditorDb({ scope, assertActive: input.assertActive }, async (db) => {
    const state = await readTranscriptEditorStateOnDb(db, scope);
    requireEditorDraftUnchanged(state, null);
    requireNoUnresolvedEditorSave(state);
    const stored = await readEditorVersionOnDb(db, scope, baseId);
    const fields = ["id", "workspace_id", "session_id", "version", "version_origin",
      "version_status", "parent_version_id", "plain_text", "content_checksum_sha256",
      "created_by", "created_at", "transcription_run_id"] as const;
    if (!stored || fields.some((field) => stored[field] !== base[field])) {
      throw new TranscriptEditorError("EDITOR_RECOVERY_REJECTED");
    }
    if (kind === "completed_save") {
      const operation = state.queue.find((row) => row.id === operationId);
      if (!operation || operation.queue_status !== "succeeded" ||
          operation.expected_current_version_id !== baseId ||
          operation.plain_text !== savedText || text === savedText) {
        throw new TranscriptEditorError("EDITOR_RECOVERY_REJECTED");
      }
    } else if (text === base.plain_text || state.queue.some((row) =>
      row.expected_current_version_id === baseId)) {
      // First autosave is not a route to revive a previously saved/discarded edit.
      throw new TranscriptEditorError("EDITOR_RECOVERY_REJECTED");
    }
    return writeEditorDraftOnDb(db, scope, baseId, text, null);
  });
};

export const upsertTranscriptionRequestIntent = async (
  row: TranscriptionRequestQueueRow,
): Promise<TranscriptionRequestQueueRow> => {
  const db = await openLocalDb();
  if (!db) return row;

  await db.runAsync(
    `INSERT INTO local_transcription_request_queue
      (id, user_id, workspace_id, session_id, recording_id,
       spoken_language_mode, expected_spoken_languages, queue_status,
       attempt_count, max_attempts, next_retry_at, server_job_id,
       last_error_code, last_safe_error, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace_id, idempotency_key) DO UPDATE SET
       session_id = excluded.session_id,
       recording_id = excluded.recording_id,
       spoken_language_mode = excluded.spoken_language_mode,
       expected_spoken_languages = excluded.expected_spoken_languages,
       queue_status = CASE
         WHEN local_transcription_request_queue.queue_status IN ('submitting','submitted')
           THEN local_transcription_request_queue.queue_status
         ELSE 'pending'
       END,
       attempt_count = CASE
         WHEN local_transcription_request_queue.queue_status IN ('submitting','submitted')
           THEN local_transcription_request_queue.attempt_count
         ELSE 0
       END,
       next_retry_at = CASE
         WHEN local_transcription_request_queue.queue_status IN ('submitting','submitted')
           THEN local_transcription_request_queue.next_retry_at
         ELSE NULL
       END,
       server_job_id = CASE
         WHEN local_transcription_request_queue.queue_status = 'submitted'
           THEN local_transcription_request_queue.server_job_id
         ELSE NULL
       END,
       last_error_code = CASE
         WHEN local_transcription_request_queue.queue_status IN ('submitting','submitted')
           THEN local_transcription_request_queue.last_error_code
         ELSE NULL
       END,
       last_safe_error = CASE
         WHEN local_transcription_request_queue.queue_status IN ('submitting','submitted')
           THEN local_transcription_request_queue.last_safe_error
         ELSE NULL
       END,
       updated_at = excluded.updated_at`,
    [
      row.id,
      row.user_id,
      row.workspace_id,
      row.session_id,
      row.recording_id,
      row.spoken_language_mode,
      JSON.stringify(row.expected_spoken_languages),
      row.queue_status,
      row.attempt_count,
      row.max_attempts,
      row.next_retry_at,
      row.server_job_id,
      row.last_error_code,
      row.last_safe_error,
      row.idempotency_key,
      row.created_at,
      row.updated_at,
    ],
  );

  const saved = (await db.getFirstAsync(
    `SELECT *
       FROM local_transcription_request_queue
      WHERE user_id = ? AND workspace_id = ? AND idempotency_key = ?
      LIMIT 1`,
    [row.user_id, row.workspace_id, row.idempotency_key],
  )) as LocalTranscriptionRequestQueueRow | null;

  return saved ? parseTranscriptionRequestQueueRow(saved) : row;
};

export const getTranscriptionRequestByIdempotencyKey = async (
  userId: string,
  workspaceId: string,
  idempotencyKey: string,
): Promise<TranscriptionRequestQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_transcription_request_queue
      WHERE user_id = ? AND workspace_id = ? AND idempotency_key = ?
      LIMIT 1`,
    [userId, workspaceId, idempotencyKey],
  )) as LocalTranscriptionRequestQueueRow | null;
  return row ? parseTranscriptionRequestQueueRow(row) : null;
};

export const getNextEligibleTranscriptionRequest = async (
  userId: string,
  now: string,
): Promise<TranscriptionRequestQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_transcription_request_queue
      WHERE user_id = ?
        AND queue_status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [userId, now],
  )) as LocalTranscriptionRequestQueueRow | null;
  return row ? parseTranscriptionRequestQueueRow(row) : null;
};

export const claimTranscriptionRequest = async (
  id: string,
): Promise<TranscriptionRequestQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const now = nowIso();
  const result = await db.runAsync(
    `UPDATE local_transcription_request_queue
        SET queue_status = 'submitting',
            attempt_count = attempt_count + 1,
            next_retry_at = NULL,
            last_error_code = NULL,
            last_safe_error = NULL,
            updated_at = ?
      WHERE id = ? AND queue_status = 'pending'`,
    [now, id],
  );
  if (result.changes !== 1) return null;
  const row = (await db.getFirstAsync(
    `SELECT * FROM local_transcription_request_queue WHERE id = ?`,
    [id],
  )) as LocalTranscriptionRequestQueueRow | null;
  return row ? parseTranscriptionRequestQueueRow(row) : null;
};

export const deferTranscriptionRequest = async (
  id: string,
  nextRetryAt: string,
  errorCode: string,
  safeError: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_transcription_request_queue
        SET queue_status = 'pending',
            attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
            next_retry_at = ?,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ?`,
    [nextRetryAt, errorCode, safeError, nowIso(), id],
  );
};

export const rescheduleTranscriptionRequest = async (
  id: string,
  nextRetryAt: string,
  errorCode: string,
  safeError: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_transcription_request_queue
        SET queue_status = 'pending',
            next_retry_at = ?,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ?`,
    [nextRetryAt, errorCode, safeError, nowIso(), id],
  );
};

export const markTranscriptionRequestSubmitted = async (
  id: string,
  serverJobId: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_transcription_request_queue
        SET queue_status = 'submitted',
            server_job_id = ?,
            attempt_count = 0,
            next_retry_at = NULL,
            last_error_code = NULL,
            last_safe_error = NULL,
            updated_at = ?
      WHERE id = ?`,
    [serverJobId, nowIso(), id],
  );
};

export const markTranscriptionRequestFailed = async (
  id: string,
  errorCode: string,
  safeError: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_transcription_request_queue
        SET queue_status = 'failed',
            next_retry_at = NULL,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ?`,
    [errorCode, safeError, nowIso(), id],
  );
};

export const markTranscriptionRequestCancelled = async (
  id: string,
  errorCode: string,
  safeError: string,
): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await db.runAsync(
    `UPDATE local_transcription_request_queue
        SET queue_status = 'cancelled',
            next_retry_at = NULL,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ?`,
    [errorCode, safeError, nowIso(), id],
  );
};

export const resetSubmittingTranscriptionRequests = async (
  userId: string,
): Promise<number> => {
  const db = await openLocalDb();
  if (!db) return 0;
  const result = await db.runAsync(
    `UPDATE local_transcription_request_queue
        SET queue_status = 'pending',
            attempt_count = CASE
              WHEN attempt_count > 0 THEN attempt_count - 1
              ELSE 0
            END,
            next_retry_at = NULL,
            updated_at = ?
      WHERE user_id = ? AND queue_status = 'submitting'`,
    [nowIso(), userId],
  );
  return result.changes;
};


// Transcription result synchronization -------------------------------------
// The existing SQLite v10 foundation stores durable server status and current
// transcript data. Result synchronization uses the submitted request row as
// its stable per-user anchor and never stores provider credentials or raw
// provider metadata.

interface LocalProcessingJobRow
  extends Omit<SyncedProcessingJob, "request_payload"> {
  request_payload: string;
}

interface LocalTranscriptionRunRow
  extends Omit<
    SyncedTranscriptionRun,
    | "requested_languages"
    | "detected_languages"
    | "provider_artifact_present"
    | "provider_cleanup_status"
  > {
  requested_languages: string;
  detected_languages: string;
  provider_job_id: string | null;
  provider_metadata: string;
}

interface LocalTranscriptVersionRow
  extends Omit<SyncedTranscriptVersion, "language_summary" | "is_current"> {
  language_summary: string;
  is_current: number;
}

const parseLocalProcessingJob = (
  row: LocalProcessingJobRow,
): SyncedProcessingJob => ({
  ...row,
  request_payload: parseJsonObject(row.request_payload) ?? {},
});

const parseLocalTranscriptionRun = (
  row: LocalTranscriptionRunRow,
): SyncedTranscriptionRun => ({
  id: row.id,
  processing_job_id: row.processing_job_id,
  workspace_id: row.workspace_id,
  session_id: row.session_id,
  recording_id: row.recording_id,
  created_by: row.created_by,
  run_attempt: row.run_attempt,
  provider_key: row.provider_key,
  provider_model: row.provider_model,
  request_mode: row.request_mode,
  requested_languages: parseStringArray(row.requested_languages),
  status: row.status,
  provider_artifact_present: row.provider_job_id != null,
  provider_cleanup_status: null,
  detected_languages: parseStringArray(row.detected_languages),
  primary_detected_language: row.primary_detected_language,
  language_detection_status: row.language_detection_status,
  started_at: row.started_at,
  completed_at: row.completed_at,
  last_error_code: row.last_error_code,
  last_safe_error: row.last_safe_error,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const parseLocalTranscriptVersion = (
  row: LocalTranscriptVersionRow,
): SyncedTranscriptVersion => ({
  ...row,
  language_summary: parseJsonObject(row.language_summary) ?? {},
  is_current: true,
});

const resultIncompleteSql = `
  NOT EXISTS (
    SELECT 1
      FROM local_processing_jobs result_job
      JOIN local_transcription_runs result_run
        ON result_run.processing_job_id = result_job.id
      JOIN local_transcript_versions result_version
        ON result_version.transcription_run_id = result_run.id
       AND result_version.version_origin = 'provider'
       AND result_version.version_status = 'final'
     WHERE result_job.id = request_row.server_job_id
       AND result_job.status = 'succeeded'
       AND result_run.status = 'succeeded'
  )
`;

export const getNextEligibleTranscriptionResultRequest = async (
  userId: string,
  now: string,
): Promise<TranscriptionRequestQueueRow | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT request_row.*
       FROM local_transcription_request_queue request_row
      WHERE request_row.user_id = ?
        AND request_row.queue_status = 'submitted'
        AND request_row.server_job_id IS NOT NULL
        AND (request_row.next_retry_at IS NULL OR request_row.next_retry_at <= ?)
        AND ${resultIncompleteSql}
      ORDER BY COALESCE(request_row.next_retry_at, request_row.created_at),
               request_row.created_at,
               request_row.id
      LIMIT 1`,
    [userId, now],
  )) as LocalTranscriptionRequestQueueRow | null;
  return row ? parseTranscriptionRequestQueueRow(row) : null;
};

export const getNextTranscriptionResultWakeAt = async (
  userId: string,
  now: string,
): Promise<string | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT MIN(COALESCE(request_row.next_retry_at, ?)) AS wake_at
       FROM local_transcription_request_queue request_row
      WHERE request_row.user_id = ?
        AND request_row.queue_status = 'submitted'
        AND request_row.server_job_id IS NOT NULL
        AND ${resultIncompleteSql}`,
    [now, userId],
  )) as { wake_at: string | null } | null;
  return row?.wake_at ?? null;
};

const requireResultQueueScopeOnDb = async (
  db: SQLite.SQLiteDatabase,
  input: {
    queueId: string;
    serverJobId: string;
    workspaceId: string;
    sessionId: string;
    recordingId: string;
  },
): Promise<void> => {
  const row = (await db.getFirstAsync(
    `SELECT id
       FROM local_transcription_request_queue
      WHERE id = ?
        AND queue_status = 'submitted'
        AND server_job_id = ?
        AND workspace_id = ?
        AND session_id = ?
        AND recording_id = ?
      LIMIT 1`,
    [
      input.queueId,
      input.serverJobId,
      input.workspaceId,
      input.sessionId,
      input.recordingId,
    ],
  )) as { id: string } | null;
  if (!row) {
    throw new Error("The local transcription result scope changed.");
  }
};

const upsertSyncedProcessingJobOnDb = async (
  db: SQLite.SQLiteDatabase,
  job: SyncedProcessingJob,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_processing_jobs
      (id, workspace_id, session_id, recording_id, created_by, job_type,
       status, idempotency_key, priority, attempt_count, max_attempts,
       next_attempt_at, lease_owner, lease_expires_at, started_at,
       completed_at, cancelled_at, last_error_code, last_safe_error,
       request_payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id=excluded.workspace_id,
       session_id=excluded.session_id,
       recording_id=excluded.recording_id,
       created_by=excluded.created_by,
       job_type=excluded.job_type,
       status=excluded.status,
       idempotency_key=excluded.idempotency_key,
       priority=excluded.priority,
       attempt_count=excluded.attempt_count,
       max_attempts=excluded.max_attempts,
       next_attempt_at=excluded.next_attempt_at,
       lease_owner=excluded.lease_owner,
       lease_expires_at=excluded.lease_expires_at,
       started_at=excluded.started_at,
       completed_at=excluded.completed_at,
       cancelled_at=excluded.cancelled_at,
       last_error_code=excluded.last_error_code,
       last_safe_error=excluded.last_safe_error,
       request_payload=excluded.request_payload,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at`,
    [
      job.id,
      job.workspace_id,
      job.session_id,
      job.recording_id,
      job.created_by,
      job.job_type,
      job.status,
      job.idempotency_key,
      job.priority,
      job.attempt_count,
      job.max_attempts,
      job.next_attempt_at,
      job.lease_owner,
      job.lease_expires_at,
      job.started_at,
      job.completed_at,
      job.cancelled_at,
      job.last_error_code,
      job.last_safe_error,
      JSON.stringify(job.request_payload),
      job.created_at,
      job.updated_at,
    ],
  );
};

const upsertSyncedTranscriptionRunOnDb = async (
  db: SQLite.SQLiteDatabase,
  run: SyncedTranscriptionRun,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_transcription_runs
      (id, processing_job_id, workspace_id, session_id, recording_id,
       created_by, run_attempt, provider_key, provider_model, request_mode,
       requested_languages, status, provider_job_id, detected_languages,
       primary_detected_language, language_detection_status, provider_metadata,
       started_at, completed_at, last_error_code, last_safe_error,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       processing_job_id=excluded.processing_job_id,
       workspace_id=excluded.workspace_id,
       session_id=excluded.session_id,
       recording_id=excluded.recording_id,
       created_by=excluded.created_by,
       run_attempt=excluded.run_attempt,
       provider_key=excluded.provider_key,
       provider_model=excluded.provider_model,
       request_mode=excluded.request_mode,
       requested_languages=excluded.requested_languages,
       status=excluded.status,
       provider_job_id=excluded.provider_job_id,
       detected_languages=excluded.detected_languages,
       primary_detected_language=excluded.primary_detected_language,
       language_detection_status=excluded.language_detection_status,
       provider_metadata=excluded.provider_metadata,
       started_at=excluded.started_at,
       completed_at=excluded.completed_at,
       last_error_code=excluded.last_error_code,
       last_safe_error=excluded.last_safe_error,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at`,
    [
      run.id,
      run.processing_job_id,
      run.workspace_id,
      run.session_id,
      run.recording_id,
      run.created_by,
      run.run_attempt,
      run.provider_key,
      run.provider_model,
      run.request_mode,
      JSON.stringify(run.requested_languages),
      run.status,
      null,
      JSON.stringify(run.detected_languages),
      run.primary_detected_language,
      run.language_detection_status,
      "{}",
      run.started_at,
      run.completed_at,
      run.last_error_code,
      run.last_safe_error,
      run.created_at,
      run.updated_at,
    ],
  );
};

const updateResultRequestOnDb = async (
  db: SQLite.SQLiteDatabase,
  input: {
    queueId: string;
    queueStatus: "submitted" | "failed" | "cancelled";
    nextRetryAt: string | null;
    attemptCountSql: "reset" | "increment";
    errorCode: string | null;
    safeError: string | null;
  },
): Promise<void> => {
  const attemptSql =
    input.attemptCountSql === "reset"
      ? "attempt_count = 0"
      : "attempt_count = MIN(attempt_count + 1, max_attempts)";
  const result = await db.runAsync(
    `UPDATE local_transcription_request_queue
        SET queue_status = ?,
            ${attemptSql},
            next_retry_at = ?,
            last_error_code = ?,
            last_safe_error = ?,
            updated_at = ?
      WHERE id = ? AND server_job_id IS NOT NULL`,
    [
      input.queueStatus,
      input.nextRetryAt,
      input.errorCode,
      input.safeError,
      nowIso(),
      input.queueId,
    ],
  );
  if (result.changes !== 1) {
    throw new Error("The local transcription result request is unavailable.");
  }
};

export const persistTranscriptionResultProgress = async (input: {
  queueId: string;
  job: SyncedProcessingJob;
  run: SyncedTranscriptionRun | null;
  nextRetryAt: string;
  errorCode: string;
  safeError: string;
}): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await runSerializedLocalTransaction(db, async () => {
    await requireResultQueueScopeOnDb(db, {
      queueId: input.queueId,
      serverJobId: input.job.id,
      workspaceId: input.job.workspace_id,
      sessionId: input.job.session_id,
      recordingId: input.job.recording_id,
    });
    await upsertSyncedProcessingJobOnDb(db, input.job);
    if (input.run) await upsertSyncedTranscriptionRunOnDb(db, input.run);
    await updateResultRequestOnDb(db, {
      queueId: input.queueId,
      queueStatus: "submitted",
      nextRetryAt: input.nextRetryAt,
      attemptCountSql: "reset",
      errorCode: input.errorCode,
      safeError: input.safeError,
    });
  });
};

export const rescheduleTranscriptionResultAfterFailure = async (input: {
  queueId: string;
  nextRetryAt: string;
  errorCode: string;
  safeError: string;
}): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await updateResultRequestOnDb(db, {
    queueId: input.queueId,
    queueStatus: "submitted",
    nextRetryAt: input.nextRetryAt,
    attemptCountSql: "increment",
    errorCode: input.errorCode,
    safeError: input.safeError,
  });
};

export const persistTerminalTranscriptionResult = async (input: {
  queueId: string;
  job: SyncedProcessingJob;
  run: SyncedTranscriptionRun | null;
  queueStatus: "failed" | "cancelled";
  errorCode: string;
  safeError: string;
}): Promise<void> => {
  const db = await openLocalDb();
  if (!db) return;
  await runSerializedLocalTransaction(db, async () => {
    await requireResultQueueScopeOnDb(db, {
      queueId: input.queueId,
      serverJobId: input.job.id,
      workspaceId: input.job.workspace_id,
      sessionId: input.job.session_id,
      recordingId: input.job.recording_id,
    });
    await upsertSyncedProcessingJobOnDb(db, input.job);
    if (input.run) await upsertSyncedTranscriptionRunOnDb(db, input.run);
    await updateResultRequestOnDb(db, {
      queueId: input.queueId,
      queueStatus: input.queueStatus,
      nextRetryAt: null,
      attemptCountSql: "reset",
      errorCode: input.errorCode,
      safeError: input.safeError,
    });
  });
};

export const persistCompletedTranscriptionResult = async (input: {
  queueId: string;
  job: SyncedProcessingJob;
  run: SyncedTranscriptionRun;
  version: SyncedTranscriptVersionRecord;
  segments: SyncedTranscriptSegment[];
}): Promise<void> => {
  if (
    input.run.processing_job_id !== input.job.id ||
    input.version.transcription_run_id !== input.run.id ||
    input.version.version_origin !== "provider" ||
    input.version.version_status !== "final" ||
    input.version.workspace_id !== input.job.workspace_id ||
    input.version.session_id !== input.job.session_id ||
    input.segments.some(
      (segment) =>
        segment.workspace_id !== input.job.workspace_id ||
        segment.session_id !== input.job.session_id ||
        segment.transcript_version_id !== input.version.id,
    )
  ) {
    throw new Error("The transcript result scope is invalid.");
  }

  const db = await openLocalDb();
  if (!db) return;
  await runSerializedLocalTransaction(db, async () => {
    await requireResultQueueScopeOnDb(db, {
      queueId: input.queueId,
      serverJobId: input.job.id,
      workspaceId: input.job.workspace_id,
      sessionId: input.job.session_id,
      recordingId: input.job.recording_id,
    });
    await upsertSyncedProcessingJobOnDb(db, input.job);
    await upsertSyncedTranscriptionRunOnDb(db, input.run);

    const localCurrent = (await db.getFirstAsync(
      `SELECT id, version
         FROM local_transcript_versions
        WHERE session_id = ? AND is_current = 1
        LIMIT 1`,
      [input.version.session_id],
    )) as { id: string; version: number } | null;

    // A provider result may already be non-current remotely because a newer
    // provider result or user edit has become current. Persist its immutable
    // transcript/evidence without changing whichever local version is current.
    if (!input.version.is_current) {
      await upsertGenericTranscriptVersionOnDb(
        db,
        input.version,
        localCurrent?.id === input.version.id,
      );
      await replaceGenericTranscriptSegmentsOnDb(
        db,
        input.version,
        input.segments,
      );
      await updateResultRequestOnDb(db, {
        queueId: input.queueId,
        queueStatus: "submitted",
        nextRetryAt: null,
        attemptCountSql: "reset",
        errorCode: null,
        safeError: null,
      });
      return;
    }

    // Result polling can overlap a generic current-version pull. Never allow
    // an older provider result snapshot to demote a newer immutable edit that
    // is already cached locally.
    if (localCurrent && localCurrent.version > input.version.version) {
      // Keep the provider result as immutable non-current history so the
      // durable completion marker remains satisfied without demoting the
      // newer local current version.
      await upsertGenericTranscriptVersionOnDb(db, input.version, false);
      await replaceGenericTranscriptSegmentsOnDb(
        db,
        input.version,
        input.segments,
      );
      await updateResultRequestOnDb(db, {
        queueId: input.queueId,
        queueStatus: "submitted",
        nextRetryAt: null,
        attemptCountSql: "reset",
        errorCode: null,
        safeError: null,
      });
      return;
    }
    if (
      localCurrent &&
      localCurrent.version === input.version.version &&
      localCurrent.id !== input.version.id
    ) {
      throw new Error(
        "The completed transcript result conflicts with local version history.",
      );
    }

    await db.runAsync(
      `UPDATE local_transcript_versions
          SET is_current = 0
        WHERE session_id = ? AND id <> ?`,
      [input.version.session_id, input.version.id],
    );
    await db.runAsync(
      `INSERT INTO local_transcript_versions
        (id, workspace_id, session_id, transcription_run_id, created_by,
         version, version_origin, version_status, parent_version_id, plain_text,
         language_summary, content_checksum_sha256, is_current,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id=excluded.workspace_id,
         session_id=excluded.session_id,
         transcription_run_id=excluded.transcription_run_id,
         created_by=excluded.created_by,
         version=excluded.version,
         version_origin=excluded.version_origin,
         version_status=excluded.version_status,
         parent_version_id=excluded.parent_version_id,
         plain_text=excluded.plain_text,
         language_summary=excluded.language_summary,
         content_checksum_sha256=excluded.content_checksum_sha256,
         is_current=1,
         created_at=excluded.created_at,
         updated_at=excluded.updated_at`,
      [
        input.version.id,
        input.version.workspace_id,
        input.version.session_id,
        input.version.transcription_run_id,
        input.version.created_by,
        input.version.version,
        input.version.version_origin,
        input.version.version_status,
        input.version.parent_version_id,
        input.version.plain_text,
        JSON.stringify(input.version.language_summary),
        input.version.content_checksum_sha256,
        input.version.created_at,
        input.version.updated_at,
      ],
    );

    await db.runAsync(
      "DELETE FROM local_transcript_segments WHERE transcript_version_id = ?",
      [input.version.id],
    );
    for (const segment of input.segments) {
      await db.runAsync(
        `INSERT INTO local_transcript_segments
          (id, workspace_id, session_id, transcript_version_id, segment_index,
           start_ms, end_ms, text, language_code, speaker_label, confidence,
           provider_segment_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id,
           session_id=excluded.session_id,
           transcript_version_id=excluded.transcript_version_id,
           segment_index=excluded.segment_index,
           start_ms=excluded.start_ms,
           end_ms=excluded.end_ms,
           text=excluded.text,
           language_code=excluded.language_code,
           speaker_label=excluded.speaker_label,
           confidence=excluded.confidence,
           provider_segment_id=excluded.provider_segment_id,
           created_at=excluded.created_at,
           updated_at=excluded.updated_at`,
        [
          segment.id,
          segment.workspace_id,
          segment.session_id,
          segment.transcript_version_id,
          segment.segment_index,
          segment.start_ms,
          segment.end_ms,
          segment.text,
          segment.language_code,
          segment.speaker_label,
          segment.confidence,
          segment.provider_segment_id,
          segment.created_at,
          segment.updated_at,
        ],
      );
    }

    await updateResultRequestOnDb(db, {
      queueId: input.queueId,
      queueStatus: "submitted",
      nextRetryAt: null,
      attemptCountSql: "reset",
      errorCode: null,
      safeError: null,
    });
  });
};

const upsertGenericTranscriptVersionOnDb = async (
  db: SQLite.SQLiteDatabase,
  version: SyncedTranscriptVersionRecord,
  isCurrent: boolean,
): Promise<void> => {
  await db.runAsync(
    `INSERT INTO local_transcript_versions
      (id, workspace_id, session_id, transcription_run_id, created_by,
       version, version_origin, version_status, parent_version_id, plain_text,
       language_summary, content_checksum_sha256, is_current,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id=excluded.workspace_id,
       session_id=excluded.session_id,
       transcription_run_id=excluded.transcription_run_id,
       created_by=excluded.created_by,
       version=excluded.version,
       version_origin=excluded.version_origin,
       version_status=excluded.version_status,
       parent_version_id=excluded.parent_version_id,
       plain_text=excluded.plain_text,
       language_summary=excluded.language_summary,
       content_checksum_sha256=excluded.content_checksum_sha256,
       is_current=excluded.is_current,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at`,
    [
      version.id,
      version.workspace_id,
      version.session_id,
      version.transcription_run_id,
      version.created_by,
      version.version,
      version.version_origin,
      version.version_status,
      version.parent_version_id,
      version.plain_text,
      JSON.stringify(version.language_summary),
      version.content_checksum_sha256,
      isCurrent ? 1 : 0,
      version.created_at,
      version.updated_at,
    ],
  );
};

const replaceGenericTranscriptSegmentsOnDb = async (
  db: SQLite.SQLiteDatabase,
  version: SyncedTranscriptVersionRecord,
  segments: readonly SyncedTranscriptSegment[],
): Promise<void> => {
  await db.runAsync(
    "DELETE FROM local_transcript_segments WHERE transcript_version_id = ?",
    [version.id],
  );
  for (const segment of segments) {
    await db.runAsync(
      `INSERT INTO local_transcript_segments
        (id, workspace_id, session_id, transcript_version_id, segment_index,
         start_ms, end_ms, text, language_code, speaker_label, confidence,
         provider_segment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id=excluded.workspace_id,
         session_id=excluded.session_id,
         transcript_version_id=excluded.transcript_version_id,
         segment_index=excluded.segment_index,
         start_ms=excluded.start_ms,
         end_ms=excluded.end_ms,
         text=excluded.text,
         language_code=excluded.language_code,
         speaker_label=excluded.speaker_label,
         confidence=excluded.confidence,
         provider_segment_id=excluded.provider_segment_id,
         created_at=excluded.created_at,
         updated_at=excluded.updated_at`,
      [
        segment.id,
        segment.workspace_id,
        segment.session_id,
        segment.transcript_version_id,
        segment.segment_index,
        segment.start_ms,
        segment.end_ms,
        segment.text,
        segment.language_code,
        segment.speaker_label,
        segment.confidence,
        segment.provider_segment_id,
        segment.created_at,
        segment.updated_at,
      ],
    );
  }
};

const segmentsMatchVersion = (
  version: SyncedTranscriptVersionRecord,
  segments: readonly SyncedTranscriptSegment[],
): boolean =>
  segments.every(
    (segment) =>
      segment.workspace_id === version.workspace_id &&
      segment.session_id === version.session_id &&
      segment.transcript_version_id === version.id,
  );

export interface TranscriptCurrentVersionSyncTarget {
  workspace_id: string;
  session_id: string;
}

export const listTranscriptCurrentVersionSyncTargets = async (): Promise<
  TranscriptCurrentVersionSyncTarget[]
> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT workspace_id, id AS session_id
       FROM local_sessions
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC, id ASC`,
  )) as TranscriptCurrentVersionSyncTarget[];
};

/** Require an unbroken path before caching any intermediate/evidence rows. */
const assertCurrentTranscriptLineage = (
  snapshot: Extract<CurrentTranscriptVersionSnapshot, { kind: "ready" }>,
): void => {
  const { currentVersion, intermediateVersions, evidenceVersion } = snapshot;
  const invalid = () => new Error("The transcript ancestry snapshot is invalid.");
  if (!Array.isArray(intermediateVersions)) throw invalid();

  if (currentVersion.version_origin !== "user_edit") {
    if (intermediateVersions.length > 0 || evidenceVersion !== null) {
      throw invalid();
    }
    return;
  }

  const depth = intermediateVersions.length + (evidenceVersion ? 1 : 0);
  if (depth > MAX_TRANSCRIPT_LINEAGE_DEPTH) throw invalid();

  const visited = new Set<string>([currentVersion.id]);
  let child: SyncedTranscriptVersionRecord = currentVersion;
  for (const parent of intermediateVersions) {
    if (
      !parent ||
      parent.version_origin === "provider" ||
      visited.has(parent.id) ||
      !isTranscriptLineageParent(child, parent)
    ) {
      throw invalid();
    }
    visited.add(parent.id);
    child = parent;
  }

  if (evidenceVersion) {
    if (
      visited.has(evidenceVersion.id) ||
      !isTranscriptLineageParent(child, evidenceVersion)
    ) {
      throw invalid();
    }
  } else if (child.parent_version_id !== null) {
    // An omitted parent is an incomplete snapshot, not proof of no evidence.
    throw invalid();
  }
};

export const persistCurrentTranscriptVersionSnapshot = async (
  snapshot: Extract<CurrentTranscriptVersionSnapshot, { kind: "ready" }>,
): Promise<void> => {
  const {
    currentVersion,
    currentSegments,
    intermediateVersions,
    evidenceVersion,
    evidenceSegments,
  } = snapshot;

  if (
    currentVersion.is_current !== true ||
    currentVersion.version_status !== "final" ||
    !segmentsMatchVersion(currentVersion, currentSegments) ||
    (currentVersion.version_origin === "user_edit" &&
      currentSegments.length > 0)
  ) {
    throw new Error("The current transcript snapshot is invalid.");
  }

  if (evidenceVersion === null) {
    if (evidenceSegments.length > 0) {
      throw new Error("The transcript evidence snapshot is invalid.");
    }
  } else if (
    evidenceVersion.is_current ||
    evidenceVersion.version_origin !== "provider" ||
    evidenceVersion.version_status !== "final" ||
    evidenceVersion.id === currentVersion.id ||
    evidenceVersion.workspace_id !== currentVersion.workspace_id ||
    evidenceVersion.session_id !== currentVersion.session_id ||
    evidenceVersion.version >= currentVersion.version ||
    !segmentsMatchVersion(evidenceVersion, evidenceSegments)
  ) {
    throw new Error("The transcript evidence snapshot is invalid.");
  }

  assertCurrentTranscriptLineage(snapshot);

  const db = await openLocalDb();
  if (!db) return;

  await runSerializedLocalTransaction(db, async () => {
    const localCurrent = (await db.getFirstAsync(
      `SELECT id, version
         FROM local_transcript_versions
        WHERE session_id = ? AND is_current = 1
        LIMIT 1`,
      [currentVersion.session_id],
    )) as { id: string; version: number } | null;

    // Remote reads and app lifecycle events can overlap. Never let an older
    // completed snapshot demote a newer immutable server version that is
    // already cached locally.
    if (localCurrent && localCurrent.version > currentVersion.version) {
      return;
    }
    if (
      localCurrent &&
      localCurrent.version === currentVersion.version &&
      localCurrent.id !== currentVersion.id
    ) {
      throw new Error(
        "The current transcript version identity conflicts with local history.",
      );
    }

    if (evidenceVersion) {
      await upsertGenericTranscriptVersionOnDb(db, evidenceVersion, false);
      await replaceGenericTranscriptSegmentsOnDb(
        db,
        evidenceVersion,
        evidenceSegments,
      );
    }

    // Keep all validated intermediate parents, including an unseen edit from
    // another device. Do not rewrite import segments we did not fetch.
    for (const ancestor of [...intermediateVersions].reverse()) {
      await upsertGenericTranscriptVersionOnDb(db, ancestor, false);
      if (ancestor.version_origin === "user_edit") {
        await replaceGenericTranscriptSegmentsOnDb(db, ancestor, []);
      }
    }

    await db.runAsync(
      `UPDATE local_transcript_versions
          SET is_current = 0
        WHERE session_id = ? AND id <> ?`,
      [currentVersion.session_id, currentVersion.id],
    );

    await upsertGenericTranscriptVersionOnDb(db, currentVersion, true);
    await replaceGenericTranscriptSegmentsOnDb(
      db,
      currentVersion,
      currentSegments,
    );
  });
};

export const getLocalProcessingJob = async (
  id: string,
): Promise<SyncedProcessingJob | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    "SELECT * FROM local_processing_jobs WHERE id = ? LIMIT 1",
    [id],
  )) as LocalProcessingJobRow | null;
  return row ? parseLocalProcessingJob(row) : null;
};

export const getLocalTranscriptionRunForJob = async (
  processingJobId: string,
): Promise<SyncedTranscriptionRun | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_transcription_runs
      WHERE processing_job_id = ?
      ORDER BY run_attempt DESC
      LIMIT 1`,
    [processingJobId],
  )) as LocalTranscriptionRunRow | null;
  return row ? parseLocalTranscriptionRun(row) : null;
};

/** Getters bound to one read snapshot. Never call public shared-db getters here. */
export interface LocalTranscriptSnapshotReads {
  getCurrentVersion: (sessionId: string) => Promise<SyncedTranscriptVersion | null>;
  getVersionById: (input: { versionId: string; workspaceId: string; sessionId: string }) => Promise<SyncedTranscriptVersionRecord | null>;
  listSegments: (versionId: string) => Promise<SyncedTranscriptSegment[]>;
}

/** One result = one local snapshot, including session checks and ancestry. */
export const withLocalTranscriptReadSnapshot = async <T>(
  sessionId: string,
  operation: (reads: LocalTranscriptSnapshotReads) => Promise<T>,
): Promise<T | null> => {
  if (Platform.OS === "web") return null;
  return withLocalReadSnapshot({ sessionId }, async (db, scope) => {
    const session = await db.getFirstAsync<{
      id: string; workspace_id: string; status: string; deleted_at: string | null;
    }>("SELECT id, workspace_id, status, deleted_at FROM local_sessions WHERE id = ? LIMIT 1", [scope.sessionId]);
    const deleting = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM local_session_deletion_queue WHERE session_id = ? LIMIT 1", [scope.sessionId]);
    if (!session || session.id !== scope.sessionId || typeof session.workspace_id !== "string" ||
        typeof session.status !== "string" || session.deleted_at !== null ||
        session.status === "deleting" || session.status === "deleted" || deleting) {
      throw new LocalReadSnapshotError("LOCAL_READ_CONTEXT_INACTIVE");
    }
    const workspaceId = session.workspace_id;
    const readVersion = async (versionId?: string): Promise<SyncedTranscriptVersionRecord | null> => {
      const row = await db.getFirstAsync<LocalTranscriptVersionRow>(
        `SELECT * FROM local_transcript_versions
          WHERE session_id = ? AND workspace_id = ? AND ${versionId === undefined ? "is_current = 1" : "id = ?"} LIMIT 1`,
        versionId === undefined ? [scope.sessionId, workspaceId] : [scope.sessionId, workspaceId, versionId],
      );
      if (!row) return null;
      if (row.session_id !== scope.sessionId || row.workspace_id !== workspaceId ||
          (versionId !== undefined && row.id !== versionId) ||
          (row.is_current !== 0 && row.is_current !== 1) || (versionId === undefined && row.is_current !== 1)) {
        throw new LocalReadSnapshotError("LOCAL_READ_QUERY_FAILED");
      }
      return { ...row, language_summary: parseJsonObject(row.language_summary) ?? {}, is_current: row.is_current === 1 };
    };
    return operation({
      getCurrentVersion: async (id) => {
        if (id.toLowerCase() !== scope.sessionId) throw new LocalReadSnapshotError("LOCAL_READ_INPUT_INVALID");
        const version = await readVersion();
        return version ? { ...version, is_current: true } : null;
      },
      getVersionById: async (input) => {
        if (input.sessionId !== scope.sessionId || input.workspaceId !== workspaceId) {
          throw new LocalReadSnapshotError("LOCAL_READ_INPUT_INVALID");
        }
        return readVersion(input.versionId);
      },
      listSegments: async (versionId) => db.getAllAsync<SyncedTranscriptSegment>(
        `SELECT * FROM local_transcript_segments
          WHERE transcript_version_id = ? AND workspace_id = ? AND session_id = ? ORDER BY segment_index ASC`,
        [versionId, workspaceId, scope.sessionId],
      ),
    });
  });
};

export const getCurrentTranscriptVersionForSession = async (
  sessionId: string,
): Promise<SyncedTranscriptVersion | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_transcript_versions
      WHERE session_id = ? AND is_current = 1
      LIMIT 1`,
    [sessionId],
  )) as LocalTranscriptVersionRow | null;
  return row ? parseLocalTranscriptVersion(row) : null;
};

/** Read an exact cached version without promoting its current marker. */
export const getTranscriptVersionByIdForSession = async (input: {
  versionId: string;
  workspaceId: string;
  sessionId: string;
}): Promise<SyncedTranscriptVersionRecord | null> => {
  const db = await openLocalDb();
  if (!db) return null;
  const row = (await db.getFirstAsync(
    `SELECT *
       FROM local_transcript_versions
      WHERE id = ? AND workspace_id = ? AND session_id = ?
      LIMIT 1`,
    [input.versionId, input.workspaceId, input.sessionId],
  )) as LocalTranscriptVersionRow | null;
  if (!row) return null;
  if (
    row.id !== input.versionId ||
    row.workspace_id !== input.workspaceId ||
    row.session_id !== input.sessionId ||
    (row.is_current !== 0 && row.is_current !== 1)
  ) {
    throw new Error("The cached transcript version scope is invalid.");
  }
  return {
    ...row,
    language_summary: parseJsonObject(row.language_summary) ?? {},
    is_current: row.is_current === 1,
  };
};

export const listTranscriptSegmentsForVersion = async (
  transcriptVersionId: string,
): Promise<SyncedTranscriptSegment[]> => {
  const db = await openLocalDb();
  if (!db) return [];
  return (await db.getAllAsync(
    `SELECT *
       FROM local_transcript_segments
      WHERE transcript_version_id = ?
      ORDER BY segment_index ASC`,
    [transcriptVersionId],
  )) as SyncedTranscriptSegment[];
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
  const releaseReads = pauseSessionReadSnapshots(input.sessionId);
  try { await prepareSessionDeletionWithReadsPaused(input); }
  finally { releaseReads(); }
};

const prepareSessionDeletionWithReadsPaused = async (
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
  const releaseReads = pauseSessionReadSnapshots(sessionId);
  try { await hardDeleteLocalSessionDataWithReadsPaused(sessionId); }
  finally { releaseReads(); }
};

const hardDeleteLocalSessionDataWithReadsPaused = async (
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
    await db.runAsync(
      `DELETE FROM local_transcript_segments WHERE session_id = ?`,
      [sessionId],
    );
    await db.runAsync(
      `DELETE FROM local_transcript_edit_queue WHERE session_id = ?`,
      [sessionId],
    );
    await db.runAsync(
      `DELETE FROM local_transcript_edit_drafts WHERE session_id = ?`,
      [sessionId],
    );
    await db.runAsync(
      `DELETE FROM local_transcript_versions WHERE session_id = ?`,
      [sessionId],
    );
    await db.runAsync(
      `DELETE FROM local_transcription_runs WHERE session_id = ?`,
      [sessionId],
    );
    await db.runAsync(
      `DELETE FROM local_processing_jobs WHERE session_id = ?`,
      [sessionId],
    );
    await db.runAsync(
      `DELETE FROM local_transcription_request_queue WHERE session_id = ?`,
      [sessionId],
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
      `DELETE FROM local_transcript_segments
        WHERE workspace_id IN ${workspaceClause.sql}
           OR session_id IN ${sessionClause.sql}
           OR transcript_version_id IN (
                SELECT id
                  FROM local_transcript_versions
                 WHERE created_by = ?
              )`,
      [
        ...workspaceClause.params,
        ...sessionClause.params,
        input.userId,
      ],
    );
    await db.runAsync(
      `DELETE FROM local_transcript_edit_queue
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
      `DELETE FROM local_transcript_edit_drafts
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
      `DELETE FROM local_transcript_versions
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
      `DELETE FROM local_transcription_runs
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
      `DELETE FROM local_processing_jobs
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
      `DELETE FROM local_transcription_request_queue
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
