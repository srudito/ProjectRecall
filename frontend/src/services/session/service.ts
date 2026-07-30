// Session service. Projects, sessions, notes, bookmarks, supported timeline
// events, primary recordings, and image/video/document evidence are local-first
// on native and remote-backed on web. Binary uploads use private Storage.

import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import {
  SessionStatus,
  type SpokenLanguageMode,
  TimelineEventType,
} from "@/src/domain/enums";
import {
  atomicCreateBookmarkWithTimelineSync,
  atomicCreateNoteWithTimelineSync,
  atomicCreateMediaAssetWithUploadAndTimeline,
  atomicCreateProjectWithSync,
  atomicCreateRecordingWithUpload,
  atomicCreateTimelineEventWithSync,
  atomicRequeueMediaAssetUpload,
  atomicRequeueProjectSync,
  atomicRequeueRecordingUpload,
  atomicRequeueSessionSync,
  atomicUpsertSessionWithSync,
  deleteMetadataOperationsForEntity,
  deleteUploadOperationsForEntity,
  getBookmark,
  getMediaAsset,
  getNote,
  getProject,
  getRecordingForSession,
  getSession,
  getTimelineEvent,
  insertTimelineEvent,
  listBookmarksForSession,
  listMediaAssetsForSession,
  listNotesForSession,
  listProjects,
  listSessions,
  listTimelineEvents,
  softDeleteSession,
  upsertBookmark,
  upsertMediaAsset,
  upsertNote,
  upsertProject,
  upsertRecording,
  upsertSession,
  upsertTimelineEvent,
  type BookmarkRecord,
  type MediaAssetRecord,
  type NoteRecord,
  type ProjectRecord,
  type RecordingRecord,
  type SessionRecord,
  type TimelineEventRecord,
  type UploadQueueRow,
} from "@/src/services/sqlite/repository";
import { prepareMediaAssetFile } from "@/src/services/media-file-persistence";
import { prepareStoppedRecordingFile } from "@/src/services/recording/file-persistence";
import {
  fetchRemoteMediaAssets,
  upsertRemoteMediaAsset,
} from "@/src/services/supabase/media-asset-repository";
import {
  fetchRemoteProject,
  fetchRemoteProjects,
  upsertRemoteProject,
} from "@/src/services/supabase/project-repository";
import {
  fetchRemoteRecordingForSession,
  upsertRemoteRecording,
} from "@/src/services/supabase/recording-repository";
import {
  createSignedSessionAssetUrl,
  uploadPrivateSessionAsset,
} from "@/src/services/supabase/session-assets";
import {
  fetchRemoteSession,
  fetchRemoteSessions,
  upsertRemoteSession,
} from "@/src/services/supabase/session-repository";
import {
  fetchRemoteBookmarks,
  fetchRemoteNotes,
  fetchRemoteTimelineEvents,
  upsertRemoteBookmark,
  upsertRemoteNote,
  upsertRemoteTimelineEvent,
} from "@/src/services/supabase/session-content-repository";
import { requestMediaUploadSync } from "@/src/services/sync/media-upload-worker";
import { notifyMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { requestMetadataSync } from "@/src/services/sync/project-sync-worker";
import { requestRecordingUploadSync } from "@/src/services/sync/recording-upload-worker";
import { buildIdempotencyKey } from "@/src/services/upload-queue/backoff";

const generateId = () => Crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requireUuid = (value: string, fieldName: string): void => {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a valid UUID.`);
  }
};

const isUnsynchronizedProject = (project: ProjectRecord): boolean =>
  project.local_sync_status !== "synchronized" ||
  project.cloud_sync_status !== "synchronized";

const projectContentMatches = (
  left: ProjectRecord,
  right: ProjectRecord,
): boolean =>
  left.id === right.id &&
  left.workspace_id === right.workspace_id &&
  left.name === right.name &&
  left.description === right.description &&
  left.status === right.status &&
  left.default_spoken_language_mode === right.default_spoken_language_mode &&
  JSON.stringify(left.default_expected_spoken_languages ?? null) ===
    JSON.stringify(right.default_expected_spoken_languages ?? null) &&
  left.default_summary_output_language === right.default_summary_output_language &&
  left.default_translation_target_language === right.default_translation_target_language &&
  left.created_by === right.created_by &&
  left.deleted_at === right.deleted_at;

const timestampMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Merge authorized cloud rows without overwriting a newer pending local edit.
 * Cloud absence never deletes a local row because a partial/failed response is
 * not proof that the local project was deleted.
 */
export const mergeRemoteProjectsIntoLocal = async (
  remoteProjects: ProjectRecord[],
): Promise<boolean> => {
  let changed = false;

  for (const remote of remoteProjects) {
    const local = await getProject(remote.id);

    if (!local) {
      await upsertProject(remote);
      changed = true;
      continue;
    }

    if (isUnsynchronizedProject(local)) {
      const alreadyReachedCloud = projectContentMatches(local, remote);
      const cloudIsAtLeastAsNew =
        timestampMs(remote.updated_at) >= timestampMs(local.updated_at);

      if (!alreadyReachedCloud && !cloudIsAtLeastAsNew) {
        continue;
      }

      await upsertProject({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: nowIso(),
      });
      await deleteMetadataOperationsForEntity("project", remote.id);
      changed = true;
      continue;
    }

    const remoteIsNewer =
      timestampMs(remote.updated_at) > timestampMs(local.updated_at);
    const contentChanged = !projectContentMatches(local, remote);

    if (remoteIsNewer || contentChanged) {
      await upsertProject({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: nowIso(),
      });
      changed = true;
    }
  }

  return changed;
};

// --- Project ---------------------------------------------------------------
export interface CreateProjectInput {
  workspaceId: string;
  createdBy: string;
  name: string;
  description?: string;
}

export const createProject = async (
  input: CreateProjectInput,
): Promise<ProjectRecord> => {
  requireUuid(input.workspaceId, "workspaceId");
  requireUuid(input.createdBy, "createdBy");

  const projectName = input.name.trim();
  if (!projectName) throw new Error("Project name is required.");

  const now = nowIso();
  const project: ProjectRecord = {
    id: generateId(),
    workspace_id: input.workspaceId,
    name: projectName,
    description: input.description?.trim() || null,
    status: "active",
    default_spoken_language_mode: null,
    default_expected_spoken_languages: [],
    default_summary_output_language: null,
    default_translation_target_language: null,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
    last_synced_at: null,
  };

  if (Platform.OS === "web") {
    return upsertRemoteProject(project);
  }

  await atomicCreateProjectWithSync({
    project,
    queueRowId: generateId(),
    idempotencyKey: buildIdempotencyKey(["upsert", "project", project.id]),
  });
  requestMetadataSync();
  return project;
};

export const retryProjectSync = async (
  project: ProjectRecord,
): Promise<ProjectRecord> => {
  requireUuid(project.workspace_id, "workspaceId");
  requireUuid(project.created_by, "createdBy");

  if (Platform.OS === "web") {
    return upsertRemoteProject(project);
  }

  const pending: ProjectRecord = {
    ...project,
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
  };

  await atomicRequeueProjectSync({
    projectId: project.id,
    userId: project.created_by,
    workspaceId: project.workspace_id,
    queueRowId: generateId(),
    idempotencyKey: buildIdempotencyKey(["upsert", "project", project.id]),
  });
  requestMetadataSync();
  return pending;
};

const refreshNativeProjectsFromCloud = async (
  workspaceId: string,
): Promise<void> => {
  try {
    const remoteProjects = await fetchRemoteProjects(workspaceId);
    const changed = await mergeRemoteProjectsIntoLocal(remoteProjects);
    if (changed) {
      notifyMetadataSyncChanges();
    }
  } finally {
    requestMetadataSync();
  }
};

export const fetchProjects = async (
  workspaceId: string,
): Promise<ProjectRecord[]> => {
  requireUuid(workspaceId, "workspaceId");

  if (Platform.OS === "web") {
    return fetchRemoteProjects(workspaceId);
  }

  const localProjects = await listProjects(workspaceId);
  void refreshNativeProjectsFromCloud(workspaceId).catch(() => {
    // Local data remains authoritative while offline or when cloud refresh
    // fails. The project worker retains safe diagnostics for queued writes.
  });
  return localProjects;
};

export const fetchProject = async (
  projectId: string,
): Promise<ProjectRecord | null> => {
  requireUuid(projectId, "projectId");

  if (Platform.OS === "web") {
    return fetchRemoteProject(projectId);
  }

  const local = await getProject(projectId);
  if (local?.deleted_at != null) return null;

  if (local) {
    void fetchRemoteProject(projectId)
      .then(async (remote) => {
        if (!remote) return;
        const changed = await mergeRemoteProjectsIntoLocal([remote]);
        if (changed) notifyMetadataSyncChanges();
      })
      .catch(() => {
        // Keep the locally cached project available while offline.
      });
    return local;
  }

  try {
    const remote = await fetchRemoteProject(projectId);
    if (!remote || remote.deleted_at != null) return null;
    await upsertProject(remote);
    return remote;
  } catch {
    return null;
  }
};

export const fetchProjectReferences = async (
  projectIds: string[],
): Promise<ProjectRecord[]> => {
  const uniqueIds = [...new Set(projectIds)];
  const rows = await Promise.all(
    uniqueIds.map(async (projectId) => {
      try {
        return await fetchProject(projectId);
      } catch {
        return null;
      }
    }),
  );

  return rows.filter((project): project is ProjectRecord => project != null);
};

// --- Session ---------------------------------------------------------------
export interface CreateSessionInput {
  workspaceId: string;
  createdBy: string;
  projectId: string | null;
  title: string;
  spokenLanguageMode: SpokenLanguageMode;
  expectedSpokenLanguages: string[];
}

const isUnsynchronizedSession = (session: SessionRecord): boolean =>
  session.local_sync_status !== "synchronized" ||
  session.cloud_sync_status !== "synchronized";

const sessionContentMatches = (
  left: SessionRecord,
  right: SessionRecord,
): boolean =>
  left.id === right.id &&
  left.workspace_id === right.workspace_id &&
  left.project_id === right.project_id &&
  left.created_by === right.created_by &&
  left.title === right.title &&
  left.session_type === right.session_type &&
  left.status === right.status &&
  left.started_at === right.started_at &&
  left.stopped_at === right.stopped_at &&
  left.total_recorded_duration_ms === right.total_recorded_duration_ms &&
  left.spoken_language_mode === right.spoken_language_mode &&
  JSON.stringify(left.expected_spoken_languages) ===
    JSON.stringify(right.expected_spoken_languages) &&
  JSON.stringify(left.detected_spoken_languages) ===
    JSON.stringify(right.detected_spoken_languages) &&
  left.primary_detected_language === right.primary_detected_language &&
  left.language_detection_status === right.language_detection_status &&
  left.summary_output_language === right.summary_output_language &&
  left.translation_target_language === right.translation_target_language &&
  left.transcript_display_mode === right.transcript_display_mode &&
  JSON.stringify(left.language_metadata) === JSON.stringify(right.language_metadata) &&
  left.deleted_at === right.deleted_at;

export const mergeRemoteSessionsIntoLocal = async (
  remoteSessions: SessionRecord[],
): Promise<boolean> => {
  let changed = false;

  for (const remote of remoteSessions) {
    const local = await getSession(remote.id);

    if (!local) {
      await upsertSession(remote);
      changed = true;
      continue;
    }

    // Local deletion is intentionally preserved until cloud-aware deletion is
    // implemented; a cloud refresh must never resurrect the hidden local row.
    if (local.deleted_at != null) {
      continue;
    }

    if (isUnsynchronizedSession(local)) {
      const alreadyReachedCloud = sessionContentMatches(local, remote);
      const cloudIsAtLeastAsNew =
        timestampMs(remote.updated_at) >= timestampMs(local.updated_at);

      if (!alreadyReachedCloud && !cloudIsAtLeastAsNew) {
        continue;
      }

      await upsertSession({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: nowIso(),
      });
      await deleteMetadataOperationsForEntity("session", remote.id);
      changed = true;
      continue;
    }

    const remoteIsNewer =
      timestampMs(remote.updated_at) > timestampMs(local.updated_at);
    const contentChanged = !sessionContentMatches(local, remote);

    if (remoteIsNewer || contentChanged) {
      await upsertSession({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: nowIso(),
      });
      changed = true;
    }
  }

  return changed;
};

const saveSessionWithSync = async (
  session: SessionRecord,
): Promise<SessionRecord> => {
  requireUuid(session.workspace_id, "workspaceId");
  requireUuid(session.created_by, "createdBy");
  if (session.project_id) requireUuid(session.project_id, "projectId");

  if (Platform.OS === "web") {
    return upsertRemoteSession(session);
  }

  await atomicUpsertSessionWithSync({
    session,
    queueRowId: generateId(),
    idempotencyKey: buildIdempotencyKey(["upsert", "session", session.id]),
  });
  requestMetadataSync();
  return session;
};

export const createSession = async (
  input: CreateSessionInput,
): Promise<SessionRecord> => {
  requireUuid(input.workspaceId, "workspaceId");
  requireUuid(input.createdBy, "createdBy");
  if (input.projectId) requireUuid(input.projectId, "projectId");

  const now = nowIso();
  const session: SessionRecord = {
    id: generateId(),
    workspace_id: input.workspaceId,
    project_id: input.projectId,
    created_by: input.createdBy,
    title: input.title.trim() || "Untitled session",
    session_type: "standard",
    status: SessionStatus.DRAFT,
    started_at: null,
    stopped_at: null,
    total_recorded_duration_ms: 0,
    spoken_language_mode: input.spokenLanguageMode,
    expected_spoken_languages: input.expectedSpokenLanguages,
    detected_spoken_languages: [],
    primary_detected_language: null,
    language_detection_status: "NOT_STARTED",
    summary_output_language: null,
    translation_target_language: null,
    transcript_display_mode: "ORIGINAL",
    language_metadata: null,
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    last_sync_error_code: null,
    last_sync_error_message: null,
    last_synced_at: null,
  };

  return saveSessionWithSync(session);
};

export const retrySessionSync = async (
  session: SessionRecord,
): Promise<SessionRecord> => {
  requireUuid(session.workspace_id, "workspaceId");
  requireUuid(session.created_by, "createdBy");
  if (session.project_id) requireUuid(session.project_id, "projectId");

  const pending: SessionRecord = {
    ...session,
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
  };

  if (Platform.OS === "web") {
    return upsertRemoteSession(pending);
  }

  await atomicRequeueSessionSync({
    sessionId: session.id,
    userId: session.created_by,
    workspaceId: session.workspace_id,
    projectId: session.project_id,
    queueRowId: generateId(),
    idempotencyKey: buildIdempotencyKey(["upsert", "session", session.id]),
  });
  requestMetadataSync();
  return pending;
};

export const setSessionStatus = async (
  session: SessionRecord,
  status: string,
): Promise<SessionRecord> => {
  const updated: SessionRecord = {
    ...session,
    status,
    updated_at: nowIso(),
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
  };
  return saveSessionWithSync(updated);
};

export const markSessionRecording = async (
  session: SessionRecord,
): Promise<SessionRecord> => {
  const updated: SessionRecord = {
    ...session,
    status: SessionStatus.RECORDING,
    started_at: session.started_at ?? nowIso(),
    updated_at: nowIso(),
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
  };
  return saveSessionWithSync(updated);
};

export const markSessionStopped = async (
  session: SessionRecord,
  totalDurationMs: number,
): Promise<SessionRecord> => {
  const updated: SessionRecord = {
    ...session,
    status: SessionStatus.RECORDED,
    stopped_at: nowIso(),
    total_recorded_duration_ms: totalDurationMs,
    updated_at: nowIso(),
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
  };
  return saveSessionWithSync(updated);
};

export const deleteSession = async (session: SessionRecord): Promise<void> => {
  await softDeleteSession(session.id);
  await deleteMetadataOperationsForEntity("session", session.id);
};

const refreshNativeSessionsFromCloud = async (
  workspaceId: string,
): Promise<void> => {
  try {
    const remoteSessions = await fetchRemoteSessions(workspaceId);
    const changed = await mergeRemoteSessionsIntoLocal(remoteSessions);
    if (changed) notifyMetadataSyncChanges();
  } finally {
    requestMetadataSync();
  }
};

export const fetchSessions = async (
  workspaceId: string,
): Promise<SessionRecord[]> => {
  requireUuid(workspaceId, "workspaceId");

  if (Platform.OS === "web") {
    return fetchRemoteSessions(workspaceId);
  }

  const localSessions = await listSessions(workspaceId);
  void refreshNativeSessionsFromCloud(workspaceId).catch(() => {
    // Local sessions remain available while offline. Queue diagnostics retain
    // the safe cloud error for pending writes.
  });
  return localSessions;
};

export const fetchSession = async (
  sessionId: string,
): Promise<SessionRecord | null> => {
  requireUuid(sessionId, "sessionId");

  if (Platform.OS === "web") {
    return fetchRemoteSession(sessionId);
  }

  const local = await getSession(sessionId);
  if (local?.deleted_at != null) return null;

  if (local) {
    void fetchRemoteSession(sessionId)
      .then(async (remote) => {
        if (!remote) return;
        const changed = await mergeRemoteSessionsIntoLocal([remote]);
        if (changed) notifyMetadataSyncChanges();
      })
      .catch(() => {
        // The local row remains usable offline.
      });
    return local;
  }

  try {
    const remote = await fetchRemoteSession(sessionId);
    if (!remote) return null;
    await upsertSession(remote);
    return remote;
  } catch {
    return null;
  }
};

// --- Primary recording file -------------------------------------------------
const recordingStoragePath = (
  workspaceId: string,
  sessionId: string,
  recordingId: string,
  fileName: string,
): string => `${workspaceId}/${sessionId}/${recordingId}/${fileName}`;

const recordingUploadQueueRow = (input: {
  recording: RecordingRecord;
  userId: string;
}): UploadQueueRow => {
  const now = nowIso();
  const targetStoragePath =
    input.recording.private_storage_path ??
    recordingStoragePath(
      input.recording.workspace_id,
      input.recording.session_id,
      input.recording.id,
      input.recording.original_file_name,
    );

  return {
    id: generateId(),
    user_id: input.userId,
    workspace_id: input.recording.workspace_id,
    session_id: input.recording.session_id,
    source_entity_type: "recording",
    source_entity_id: input.recording.id,
    local_file_uri: input.recording.local_file_uri ?? "",
    target_storage_path: targetStoragePath,
    queue_status: "pending",
    attempt_count: 0,
    next_retry_at: null,
    last_error_code: null,
    last_safe_error: null,
    idempotency_key: buildIdempotencyKey([
      "upload",
      "recording",
      input.recording.id,
    ]),
    created_at: now,
    updated_at: now,
  };
};

const recordingContentMatches = (
  left: RecordingRecord,
  right: RecordingRecord,
): boolean =>
  left.id === right.id &&
  left.workspace_id === right.workspace_id &&
  left.project_id === right.project_id &&
  left.session_id === right.session_id &&
  left.private_storage_path === right.private_storage_path &&
  left.mime_type === right.mime_type &&
  left.original_file_name === right.original_file_name &&
  left.file_size === right.file_size &&
  left.duration_ms === right.duration_ms &&
  left.recording_format === right.recording_format &&
  left.checksum_sha256 === right.checksum_sha256 &&
  left.upload_status === right.upload_status;

export const mergeRemoteRecordingIntoLocal = async (
  remote: RecordingRecord,
): Promise<boolean> => {
  const local = await getRecordingForSession(remote.session_id);

  if (!local) {
    await upsertRecording(remote);
    return true;
  }

  const remoteIsSynchronized = remote.upload_status === "synchronized";
  const localHasPendingWrite =
    local.upload_status === "pending" || local.upload_status === "uploading";

  if (localHasPendingWrite && !remoteIsSynchronized) {
    return false;
  }

  const merged: RecordingRecord = {
    ...remote,
    local_file_uri: local.local_file_uri ?? remote.local_file_uri,
  };

  const changed =
    !recordingContentMatches(local, merged) ||
    local.local_file_uri !== merged.local_file_uri ||
    local.upload_error_code !== merged.upload_error_code ||
    local.upload_error_message !== merged.upload_error_message;

  if (!changed) return false;

  await upsertRecording(merged);
  if (remoteIsSynchronized) {
    await deleteUploadOperationsForEntity("recording", remote.id);
  }
  return true;
};

export interface SaveStoppedRecordingInput {
  session: SessionRecord;
  createdBy: string;
  sourceFileUri: string;
  durationMs: number;
  reportedFileSize: number;
}

/**
 * Persist the recorder output and enqueue its private Storage upload. Native
 * copies the cache output to the application document directory first. Web
 * uploads immediately because blob URLs do not survive a page reload.
 */
export const saveStoppedRecording = async (
  input: SaveStoppedRecordingInput,
): Promise<RecordingRecord> => {
  requireUuid(input.session.id, "sessionId");
  requireUuid(input.session.workspace_id, "workspaceId");
  requireUuid(input.createdBy, "createdBy");

  const existing = await getRecordingForSession(input.session.id);
  const recordingId = existing?.id ?? generateId();
  const prepared = await prepareStoppedRecordingFile({
    recordingId,
    sessionId: input.session.id,
    sourceUri: input.sourceFileUri,
    reportedFileSize: input.reportedFileSize,
  });
  const now = nowIso();
  const path = recordingStoragePath(
    input.session.workspace_id,
    input.session.id,
    recordingId,
    prepared.originalFileName,
  );

  const recording: RecordingRecord = {
    id: recordingId,
    workspace_id: input.session.workspace_id,
    project_id: input.session.project_id,
    session_id: input.session.id,
    local_file_uri: prepared.localFileUri,
    private_storage_path: path,
    mime_type: prepared.mimeType,
    original_file_name: prepared.originalFileName,
    file_size: prepared.fileSize,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    recording_format: prepared.recordingFormat,
    checksum_sha256: null,
    upload_status: Platform.OS === "web" ? "uploading" : "pending",
    upload_error_code: null,
    upload_error_message: null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  if (Platform.OS === "web") {
    let uploading = await upsertRemoteRecording(recording);
    try {
      await uploadPrivateSessionAsset({
        path,
        fileUri: prepared.localFileUri,
        mimeType: prepared.mimeType,
      });
      uploading = await upsertRemoteRecording({
        ...uploading,
        private_storage_path: path,
        upload_status: "synchronized",
        upload_error_code: null,
        upload_error_message: null,
        updated_at: nowIso(),
      });
      notifyMetadataSyncChanges();
      return uploading;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void upsertRemoteRecording({
        ...uploading,
        upload_status: "failed",
        upload_error_code: "UPLOAD_FAILED",
        upload_error_message: message,
        updated_at: nowIso(),
      }).catch(() => {});
      throw error;
    }
  }

  const queueRow = recordingUploadQueueRow({
    recording,
    userId: input.createdBy,
  });
  await atomicCreateRecordingWithUpload({ recording, upload: queueRow });
  notifyMetadataSyncChanges();
  requestRecordingUploadSync();
  return recording;
};

const refreshNativeRecordingFromCloud = async (
  sessionId: string,
): Promise<void> => {
  try {
    const remote = await fetchRemoteRecordingForSession(sessionId);
    if (!remote) return;
    const changed = await mergeRemoteRecordingIntoLocal(remote);
    if (changed) notifyMetadataSyncChanges();
  } finally {
    requestRecordingUploadSync();
  }
};

export const fetchRecordingForSession = async (
  sessionId: string,
): Promise<RecordingRecord | null> => {
  requireUuid(sessionId, "sessionId");

  if (Platform.OS === "web") {
    return fetchRemoteRecordingForSession(sessionId);
  }

  const local = await getRecordingForSession(sessionId);
  if (local) {
    void refreshNativeRecordingFromCloud(sessionId).catch(() => {
      requestRecordingUploadSync();
    });
    return local;
  }

  try {
    const remote = await fetchRemoteRecordingForSession(sessionId);
    if (!remote) return null;
    await upsertRecording(remote);
    return remote;
  } catch {
    return null;
  }
};

export const resolveRecordingPlaybackUri = async (
  recording: RecordingRecord,
): Promise<string | null> => {
  if (Platform.OS !== "web" && recording.local_file_uri) {
    try {
      const info = await FileSystem.getInfoAsync(recording.local_file_uri);
      if (info.exists) return recording.local_file_uri;
    } catch {
      // Fall back to a signed cloud URL below.
    }
  }

  if (!recording.private_storage_path) return null;
  return createSignedSessionAssetUrl({
    path: recording.private_storage_path,
  });
};

export const retryRecordingUpload = async (input: {
  recording: RecordingRecord;
  userId: string;
}): Promise<RecordingRecord> => {
  requireUuid(input.recording.id, "recordingId");
  requireUuid(input.recording.workspace_id, "workspaceId");
  requireUuid(input.recording.session_id, "sessionId");
  requireUuid(input.userId, "userId");

  const localFileUri = input.recording.local_file_uri;
  if (!localFileUri) {
    throw new Error("The local recording file is no longer available.");
  }

  const pending: RecordingRecord = {
    ...input.recording,
    upload_status: "pending",
    upload_error_code: null,
    upload_error_message: null,
    updated_at: nowIso(),
  };

  if (Platform.OS === "web") {
    await uploadPrivateSessionAsset({
      path:
        pending.private_storage_path ??
        recordingStoragePath(
          pending.workspace_id,
          pending.session_id,
          pending.id,
          pending.original_file_name,
        ),
      fileUri: localFileUri,
      mimeType: pending.mime_type,
    });
    return upsertRemoteRecording({
      ...pending,
      upload_status: "synchronized",
      updated_at: nowIso(),
    });
  }

  const upload = recordingUploadQueueRow({
    recording: pending,
    userId: input.userId,
  });
  await atomicRequeueRecordingUpload({
    recordingId: pending.id,
    upload,
  });
  notifyMetadataSyncChanges();
  requestRecordingUploadSync();
  return pending;
};

// --- Evidence/media files --------------------------------------------------
const mediaAssetStoragePath = (
  workspaceId: string,
  sessionId: string,
  assetId: string,
  fileName: string,
): string => `${workspaceId}/${sessionId}/${assetId}/${fileName}`;

const mediaUploadQueueRow = (input: {
  asset: MediaAssetRecord;
  userId: string;
}): UploadQueueRow => {
  const now = nowIso();
  const targetStoragePath =
    input.asset.private_storage_path ??
    mediaAssetStoragePath(
      input.asset.workspace_id,
      input.asset.session_id,
      input.asset.id,
      input.asset.sanitized_file_name,
    );

  return {
    id: generateId(),
    user_id: input.userId,
    workspace_id: input.asset.workspace_id,
    session_id: input.asset.session_id,
    source_entity_type: "media_asset",
    source_entity_id: input.asset.id,
    local_file_uri: input.asset.local_file_uri ?? "",
    target_storage_path: targetStoragePath,
    queue_status: "pending",
    attempt_count: 0,
    next_retry_at: null,
    last_error_code: null,
    last_safe_error: null,
    idempotency_key: buildIdempotencyKey([
      "upload",
      "media_asset",
      input.asset.id,
    ]),
    created_at: now,
    updated_at: now,
  };
};

const mediaAssetContentMatches = (
  left: MediaAssetRecord,
  right: MediaAssetRecord,
): boolean =>
  left.id === right.id &&
  left.workspace_id === right.workspace_id &&
  left.project_id === right.project_id &&
  left.session_id === right.session_id &&
  left.added_by === right.added_by &&
  left.asset_type === right.asset_type &&
  left.mime_type === right.mime_type &&
  left.original_file_name === right.original_file_name &&
  left.sanitized_file_name === right.sanitized_file_name &&
  left.private_storage_path === right.private_storage_path &&
  left.file_size === right.file_size &&
  left.duration_ms === right.duration_ms &&
  left.image_width === right.image_width &&
  left.image_height === right.image_height &&
  left.page_count === right.page_count &&
  left.captured_at === right.captured_at &&
  left.recording_offset_ms === right.recording_offset_ms &&
  left.user_caption === right.user_caption &&
  left.checksum_sha256 === right.checksum_sha256 &&
  left.upload_status === right.upload_status &&
  left.deleted_at === right.deleted_at;

export const mergeRemoteMediaAssetsIntoLocal = async (
  remoteAssets: MediaAssetRecord[],
): Promise<boolean> => {
  let changed = false;

  for (const remote of remoteAssets) {
    const local = await getMediaAsset(remote.id);
    if (!local) {
      await upsertMediaAsset(remote);
      changed = true;
      continue;
    }

    const remoteIsSynchronized = remote.upload_status === "synchronized";
    const localHasPendingWrite =
      local.upload_status === "pending" || local.upload_status === "uploading";
    if (localHasPendingWrite && !remoteIsSynchronized) continue;

    const merged: MediaAssetRecord = {
      ...remote,
      local_file_uri: local.local_file_uri ?? remote.local_file_uri,
    };
    const contentChanged =
      !mediaAssetContentMatches(local, merged) ||
      local.local_file_uri !== merged.local_file_uri ||
      local.upload_error_code !== merged.upload_error_code ||
      local.upload_error_message !== merged.upload_error_message;
    if (!contentChanged) continue;

    await upsertMediaAsset(merged);
    if (remoteIsSynchronized) {
      await deleteUploadOperationsForEntity("media_asset", remote.id);
    }
    changed = true;
  }

  return changed;
};

export const resolveMediaAssetUri = async (
  asset: MediaAssetRecord,
): Promise<string | null> => {
  if (Platform.OS !== "web" && asset.local_file_uri) {
    try {
      const info = await FileSystem.getInfoAsync(asset.local_file_uri);
      if (info.exists) return asset.local_file_uri;
    } catch {
      // Fall back to a short-lived signed URL below.
    }
  }

  if (!asset.private_storage_path) return null;
  return createSignedSessionAssetUrl({ path: asset.private_storage_path });
};

export const retryMediaAssetUpload = async (input: {
  asset: MediaAssetRecord;
  userId: string;
}): Promise<MediaAssetRecord> => {
  requireUuid(input.asset.id, "assetId");
  requireUuid(input.asset.workspace_id, "workspaceId");
  requireUuid(input.asset.session_id, "sessionId");
  requireUuid(input.userId, "userId");

  const localFileUri = input.asset.local_file_uri;
  if (!localFileUri) {
    throw new Error("The local evidence file is no longer available.");
  }

  const pending: MediaAssetRecord = {
    ...input.asset,
    upload_status: "pending",
    upload_error_code: null,
    upload_error_message: null,
    updated_at: nowIso(),
  };

  if (Platform.OS === "web") {
    const path =
      pending.private_storage_path ??
      mediaAssetStoragePath(
        pending.workspace_id,
        pending.session_id,
        pending.id,
        pending.sanitized_file_name,
      );
    await uploadPrivateSessionAsset({
      path,
      fileUri: localFileUri,
      mimeType: pending.mime_type,
    });
    return upsertRemoteMediaAsset({
      ...pending,
      private_storage_path: path,
      upload_status: "synchronized",
      updated_at: nowIso(),
    });
  }

  const upload = mediaUploadQueueRow({ asset: pending, userId: input.userId });
  await atomicRequeueMediaAssetUpload({ assetId: pending.id, upload });
  notifyMetadataSyncChanges();
  requestMediaUploadSync();
  return pending;
};

// --- Notes / Bookmarks / Media --------------------------------------------
const isUnsynchronizedContent = (record: {
  local_sync_status: string;
  cloud_sync_status: string;
}): boolean =>
  record.local_sync_status !== "synchronized" ||
  record.cloud_sync_status !== "synchronized";

const noteContentMatches = (left: NoteRecord, right: NoteRecord): boolean =>
  left.id === right.id &&
  left.workspace_id === right.workspace_id &&
  left.project_id === right.project_id &&
  left.session_id === right.session_id &&
  left.text === right.text &&
  left.recording_offset_ms === right.recording_offset_ms &&
  left.created_by === right.created_by &&
  left.deleted_at === right.deleted_at;

const bookmarkContentMatches = (
  left: BookmarkRecord,
  right: BookmarkRecord,
): boolean =>
  left.id === right.id &&
  left.workspace_id === right.workspace_id &&
  left.project_id === right.project_id &&
  left.session_id === right.session_id &&
  left.label === right.label &&
  left.recording_offset_ms === right.recording_offset_ms &&
  left.created_by === right.created_by &&
  left.deleted_at === right.deleted_at;

const timelineContentMatches = (
  left: TimelineEventRecord,
  right: TimelineEventRecord,
): boolean =>
  left.id === right.id &&
  left.workspace_id === right.workspace_id &&
  left.project_id === right.project_id &&
  left.session_id === right.session_id &&
  left.event_type === right.event_type &&
  left.source_entity_type === right.source_entity_type &&
  left.source_entity_id === right.source_entity_id &&
  left.recording_offset_ms === right.recording_offset_ms &&
  left.created_by === right.created_by &&
  left.created_at === right.created_at;

export const mergeRemoteNotesIntoLocal = async (
  remoteNotes: NoteRecord[],
): Promise<boolean> => {
  let changed = false;

  for (const remote of remoteNotes) {
    const local = await getNote(remote.id);
    if (!local) {
      await upsertNote(remote);
      changed = true;
      continue;
    }

    if (local.deleted_at != null) continue;

    if (isUnsynchronizedContent(local)) {
      const same = noteContentMatches(local, remote);
      const cloudIsAtLeastAsNew =
        timestampMs(remote.updated_at) >= timestampMs(local.updated_at);
      if (!same && !cloudIsAtLeastAsNew) continue;

      await upsertNote({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: nowIso(),
      });
      await deleteMetadataOperationsForEntity("note", remote.id);
      changed = true;
      continue;
    }

    const remoteIsNewer =
      timestampMs(remote.updated_at) > timestampMs(local.updated_at);
    if (remoteIsNewer || !noteContentMatches(local, remote)) {
      await upsertNote(remote);
      changed = true;
    }
  }

  return changed;
};

export const mergeRemoteBookmarksIntoLocal = async (
  remoteBookmarks: BookmarkRecord[],
): Promise<boolean> => {
  let changed = false;

  for (const remote of remoteBookmarks) {
    const local = await getBookmark(remote.id);
    if (!local) {
      await upsertBookmark(remote);
      changed = true;
      continue;
    }

    if (local.deleted_at != null) continue;

    if (isUnsynchronizedContent(local)) {
      const same = bookmarkContentMatches(local, remote);
      const cloudIsAtLeastAsNew =
        timestampMs(remote.updated_at) >= timestampMs(local.updated_at);
      if (!same && !cloudIsAtLeastAsNew) continue;

      await upsertBookmark({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: nowIso(),
      });
      await deleteMetadataOperationsForEntity("bookmark", remote.id);
      changed = true;
      continue;
    }

    const remoteIsNewer =
      timestampMs(remote.updated_at) > timestampMs(local.updated_at);
    if (remoteIsNewer || !bookmarkContentMatches(local, remote)) {
      await upsertBookmark(remote);
      changed = true;
    }
  }

  return changed;
};

export const mergeRemoteTimelineIntoLocal = async (
  remoteEvents: TimelineEventRecord[],
): Promise<boolean> => {
  let changed = false;

  for (const remote of remoteEvents) {
    const local = await getTimelineEvent(remote.id);
    if (!local) {
      await upsertTimelineEvent(remote);
      changed = true;
      continue;
    }

    if (isUnsynchronizedContent(local)) {
      if (!timelineContentMatches(local, remote)) continue;

      await upsertTimelineEvent({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: nowIso(),
      });
      await deleteMetadataOperationsForEntity("timeline_event", remote.id);
      changed = true;
      continue;
    }

    if (!timelineContentMatches(local, remote)) {
      await upsertTimelineEvent(remote);
      changed = true;
    }
  }

  return changed;
};

const createPendingTimelineEvent = (
  session: SessionRecord,
  event: Omit<
    TimelineEventRecord,
    | "id"
    | "workspace_id"
    | "project_id"
    | "session_id"
    | "created_at"
    | "local_sync_status"
    | "cloud_sync_status"
    | "last_sync_error_code"
    | "last_sync_error_message"
    | "last_synced_at"
  >,
): TimelineEventRecord => ({
  id: generateId(),
  workspace_id: session.workspace_id,
  project_id: session.project_id,
  session_id: session.id,
  ...event,
  created_at: nowIso(),
  local_sync_status: "pending",
  cloud_sync_status: "pending",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: null,
});

const SYNCABLE_TIMELINE_EVENTS = new Set<string>([
  TimelineEventType.RECORDING_STARTED,
  TimelineEventType.RECORDING_PAUSED,
  TimelineEventType.RECORDING_RESUMED,
  TimelineEventType.RECORDING_STOPPED,
  TimelineEventType.NOTE_ADDED,
  TimelineEventType.BOOKMARK_ADDED,
  TimelineEventType.IMAGE_ADDED,
  TimelineEventType.VIDEO_ADDED,
  TimelineEventType.DOCUMENT_ADDED,
]);

export const addNote = async (input: {
  session: SessionRecord;
  createdBy: string;
  text: string;
  offsetMs: number;
}): Promise<NoteRecord> => {
  requireUuid(input.session.id, "sessionId");
  requireUuid(input.session.workspace_id, "workspaceId");
  requireUuid(input.createdBy, "createdBy");

  const noteText = input.text.trim();
  if (!noteText) throw new Error("Note text is required.");

  const now = nowIso();
  const note: NoteRecord = {
    id: generateId(),
    workspace_id: input.session.workspace_id,
    project_id: input.session.project_id,
    session_id: input.session.id,
    text: noteText,
    recording_offset_ms: input.offsetMs,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
    last_synced_at: null,
  };
  const timelineEvent = createPendingTimelineEvent(input.session, {
    event_type: TimelineEventType.NOTE_ADDED,
    source_entity_type: "note",
    source_entity_id: note.id,
    recording_offset_ms: note.recording_offset_ms,
    created_by: input.createdBy,
  });

  if (Platform.OS === "web") {
    const remoteNote = await upsertRemoteNote(note);
    await upsertRemoteTimelineEvent(timelineEvent);
    return remoteNote;
  }

  await atomicCreateNoteWithTimelineSync({
    note,
    timelineEvent,
    noteQueue: {
      queueRowId: generateId(),
      idempotencyKey: buildIdempotencyKey(["upsert", "note", note.id]),
    },
    timelineQueue: {
      queueRowId: generateId(),
      idempotencyKey: buildIdempotencyKey([
        "upsert",
        "timeline_event",
        timelineEvent.id,
      ]),
    },
  });
  requestMetadataSync();
  return note;
};

export const addBookmark = async (input: {
  session: SessionRecord;
  createdBy: string;
  label: string;
  offsetMs: number;
}): Promise<BookmarkRecord> => {
  requireUuid(input.session.id, "sessionId");
  requireUuid(input.session.workspace_id, "workspaceId");
  requireUuid(input.createdBy, "createdBy");

  const now = nowIso();
  const bookmark: BookmarkRecord = {
    id: generateId(),
    workspace_id: input.session.workspace_id,
    project_id: input.session.project_id,
    session_id: input.session.id,
    label: input.label.trim() || "Bookmark",
    recording_offset_ms: input.offsetMs,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    local_sync_status: "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
    last_synced_at: null,
  };
  const timelineEvent = createPendingTimelineEvent(input.session, {
    event_type: TimelineEventType.BOOKMARK_ADDED,
    source_entity_type: "bookmark",
    source_entity_id: bookmark.id,
    recording_offset_ms: bookmark.recording_offset_ms,
    created_by: input.createdBy,
  });

  if (Platform.OS === "web") {
    const remoteBookmark = await upsertRemoteBookmark(bookmark);
    await upsertRemoteTimelineEvent(timelineEvent);
    return remoteBookmark;
  }

  await atomicCreateBookmarkWithTimelineSync({
    bookmark,
    timelineEvent,
    bookmarkQueue: {
      queueRowId: generateId(),
      idempotencyKey: buildIdempotencyKey([
        "upsert",
        "bookmark",
        bookmark.id,
      ]),
    },
    timelineQueue: {
      queueRowId: generateId(),
      idempotencyKey: buildIdempotencyKey([
        "upsert",
        "timeline_event",
        timelineEvent.id,
      ]),
    },
  });
  requestMetadataSync();
  return bookmark;
};

export const addMediaAsset = async (input: {
  session: SessionRecord;
  addedBy: string;
  assetType: "image" | "video" | "document";
  mimeType: string;
  originalFileName: string;
  sourceFileUri: string;
  reportedFileSize: number;
  durationMs?: number | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  pageCount?: number | null;
  offsetMs: number;
  userCaption?: string | null;
}): Promise<MediaAssetRecord> => {
  requireUuid(input.session.id, "sessionId");
  requireUuid(input.session.workspace_id, "workspaceId");
  requireUuid(input.addedBy, "addedBy");

  const assetId = generateId();
  const prepared = await prepareMediaAssetFile({
    assetId,
    sessionId: input.session.id,
    sourceUri: input.sourceFileUri,
    mimeType: input.mimeType,
    originalFileName: input.originalFileName,
    reportedFileSize: input.reportedFileSize,
    assetType: input.assetType,
  });
  const now = nowIso();
  const path = mediaAssetStoragePath(
    input.session.workspace_id,
    input.session.id,
    assetId,
    prepared.sanitizedFileName,
  );
  const asset: MediaAssetRecord = {
    id: assetId,
    workspace_id: input.session.workspace_id,
    project_id: input.session.project_id,
    session_id: input.session.id,
    added_by: input.addedBy,
    asset_type: input.assetType,
    mime_type: prepared.mimeType,
    original_file_name: prepared.originalFileName,
    sanitized_file_name: prepared.sanitizedFileName,
    local_file_uri: prepared.localFileUri,
    private_storage_path: path,
    file_size: prepared.fileSize,
    duration_ms: input.durationMs ?? null,
    image_width: input.imageWidth ?? null,
    image_height: input.imageHeight ?? null,
    page_count: input.pageCount ?? null,
    captured_at: now,
    recording_offset_ms: Math.max(0, Math.round(input.offsetMs)),
    user_caption: input.userCaption?.trim() || null,
    checksum_sha256: null,
    upload_status: Platform.OS === "web" ? "uploading" : "pending",
    upload_error_code: null,
    upload_error_message: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  const eventType =
    input.assetType === "image"
      ? TimelineEventType.IMAGE_ADDED
      : input.assetType === "video"
        ? TimelineEventType.VIDEO_ADDED
        : TimelineEventType.DOCUMENT_ADDED;
  const timelineEvent = createPendingTimelineEvent(input.session, {
    event_type: eventType,
    source_entity_type: "media_asset",
    source_entity_id: asset.id,
    recording_offset_ms: asset.recording_offset_ms,
    created_by: input.addedBy,
  });

  if (Platform.OS === "web") {
    let uploading = await upsertRemoteMediaAsset(asset);
    try {
      await uploadPrivateSessionAsset({
        path,
        fileUri: prepared.localFileUri,
        mimeType: prepared.mimeType,
      });
      uploading = await upsertRemoteMediaAsset({
        ...uploading,
        private_storage_path: path,
        upload_status: "synchronized",
        upload_error_code: null,
        upload_error_message: null,
        updated_at: nowIso(),
      });
      await upsertRemoteTimelineEvent(timelineEvent);
      notifyMetadataSyncChanges();
      return uploading;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void upsertRemoteMediaAsset({
        ...uploading,
        upload_status: "failed",
        upload_error_code: "UPLOAD_FAILED",
        upload_error_message: message,
        updated_at: nowIso(),
      }).catch(() => {});
      throw error;
    }
  }

  const upload = mediaUploadQueueRow({ asset, userId: input.addedBy });
  await atomicCreateMediaAssetWithUploadAndTimeline({
    asset,
    timelineEvent,
    upload,
    timelineQueue: {
      queueRowId: generateId(),
      idempotencyKey: buildIdempotencyKey([
        "upsert",
        "timeline_event",
        timelineEvent.id,
      ]),
    },
  });
  notifyMetadataSyncChanges();
  requestMediaUploadSync();
  return asset;
};

// --- Timeline --------------------------------------------------------------
export const recordTimelineEvent = async (
  session: SessionRecord,
  event: Omit<
    TimelineEventRecord,
    | "id"
    | "workspace_id"
    | "project_id"
    | "session_id"
    | "created_at"
    | "local_sync_status"
    | "cloud_sync_status"
    | "last_sync_error_code"
    | "last_sync_error_message"
    | "last_synced_at"
  >,
): Promise<TimelineEventRecord> => {
  const shouldSync = SYNCABLE_TIMELINE_EVENTS.has(event.event_type);
  const record = createPendingTimelineEvent(session, event);
  if (!shouldSync) {
    record.local_sync_status = "local_only";
    record.cloud_sync_status = "not_started";
  }

  if (Platform.OS === "web") {
    return shouldSync ? upsertRemoteTimelineEvent(record) : record;
  }

  if (shouldSync) {
    await atomicCreateTimelineEventWithSync({
      timelineEvent: record,
      timelineQueue: {
        queueRowId: generateId(),
        idempotencyKey: buildIdempotencyKey([
          "upsert",
          "timeline_event",
          record.id,
        ]),
      },
    });
    requestMetadataSync();
  } else {
    await insertTimelineEvent(record);
  }

  return record;
};

const refreshNativeSessionContentFromCloud = async (
  sessionId: string,
): Promise<boolean> => {
  const [remoteNotes, remoteBookmarks, remoteAssets, remoteTimeline] =
    await Promise.all([
      fetchRemoteNotes(sessionId),
      fetchRemoteBookmarks(sessionId),
      fetchRemoteMediaAssets(sessionId),
      fetchRemoteTimelineEvents(sessionId),
    ]);

  const [notesChanged, bookmarksChanged, assetsChanged, timelineChanged] =
    await Promise.all([
      mergeRemoteNotesIntoLocal(remoteNotes),
      mergeRemoteBookmarksIntoLocal(remoteBookmarks),
      mergeRemoteMediaAssetsIntoLocal(remoteAssets),
      mergeRemoteTimelineIntoLocal(remoteTimeline),
    ]);

  const changed =
    notesChanged || bookmarksChanged || assetsChanged || timelineChanged;
  if (changed) notifyMetadataSyncChanges();
  requestMetadataSync();
  requestMediaUploadSync();
  return changed;
};

export const getSessionBundle = async (sessionId: string) => {
  requireUuid(sessionId, "sessionId");

  if (Platform.OS === "web") {
    const [notes, bookmarks, assets, timeline] = await Promise.all([
      fetchRemoteNotes(sessionId),
      fetchRemoteBookmarks(sessionId),
      fetchRemoteMediaAssets(sessionId),
      fetchRemoteTimelineEvents(sessionId),
    ]);
    return { notes, bookmarks, assets, timeline };
  }

  const readLocal = async () => {
    const [notes, bookmarks, assets, timeline] = await Promise.all([
      listNotesForSession(sessionId),
      listBookmarksForSession(sessionId),
      listMediaAssetsForSession(sessionId),
      listTimelineEvents(sessionId),
    ]);
    return { notes, bookmarks, assets, timeline };
  };

  const local = await readLocal();
  void refreshNativeSessionContentFromCloud(sessionId).catch(() => {
    // Local content remains available while offline. Pending writes stay in
    // the durable metadata queue and are retried by the lifecycle worker.
    requestMetadataSync();
  });
  return local;
};
