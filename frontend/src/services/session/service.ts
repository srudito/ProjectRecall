// Session service. Project metadata is local-first on native and remote-only
// on web. The remaining Milestone 1 entities are still local-only and will be
// moved onto the same synchronization foundation in the next pass.

import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

import {
  SessionStatus,
  type SpokenLanguageMode,
  TimelineEventType,
  UploadStatus,
} from "@/src/domain/enums";
import {
  atomicCreateProjectWithSync,
  atomicRequeueProjectSync,
  deleteMetadataOperationsForEntity,
  getProject,
  insertBookmark,
  insertMediaAsset,
  insertNote,
  insertTimelineEvent,
  listBookmarksForSession,
  listMediaAssetsForSession,
  listNotesForSession,
  listProjects,
  listSessions,
  listTimelineEvents,
  softDeleteSession,
  upsertProject,
  upsertSession,
  type BookmarkRecord,
  type MediaAssetRecord,
  type NoteRecord,
  type ProjectRecord,
  type SessionRecord,
  type TimelineEventRecord,
} from "@/src/services/sqlite/repository";
import {
  fetchRemoteProjects,
  upsertRemoteProject,
} from "@/src/services/supabase/project-repository";
import { notifyProjectSyncChanges } from "@/src/services/sync/project-sync-events";
import { requestProjectSync } from "@/src/services/sync/project-sync-worker";
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
  requestProjectSync();
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
  requestProjectSync();
  return pending;
};

const refreshNativeProjectsFromCloud = async (
  workspaceId: string,
): Promise<void> => {
  try {
    const remoteProjects = await fetchRemoteProjects(workspaceId);
    const changed = await mergeRemoteProjectsIntoLocal(remoteProjects);
    if (changed) {
      notifyProjectSyncChanges();
    }
  } finally {
    requestProjectSync();
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

// --- Session ---------------------------------------------------------------
export interface CreateSessionInput {
  workspaceId: string;
  createdBy: string;
  projectId: string | null;
  title: string;
  spokenLanguageMode: SpokenLanguageMode;
  expectedSpokenLanguages: string[];
}

export const createSession = async (
  input: CreateSessionInput,
): Promise<SessionRecord> => {
  const now = nowIso();
  const session: SessionRecord = {
    id: generateId(),
    workspace_id: input.workspaceId,
    project_id: input.projectId,
    created_by: input.createdBy,
    title: input.title,
    status: SessionStatus.DRAFT,
    spoken_language_mode: input.spokenLanguageMode,
    expected_spoken_languages: input.expectedSpokenLanguages,
    started_at: null,
    stopped_at: null,
    total_recorded_duration_ms: 0,
    local_sync_status: UploadStatus.LOCAL_ONLY,
    cloud_sync_status: UploadStatus.LOCAL_ONLY,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await upsertSession(session);
  return session;
};

export const setSessionStatus = async (
  session: SessionRecord,
  status: string,
): Promise<SessionRecord> => {
  const updated = { ...session, status, updated_at: nowIso() };
  await upsertSession(updated);
  return updated;
};

export const markSessionRecording = async (
  session: SessionRecord,
): Promise<SessionRecord> => {
  const updated = {
    ...session,
    status: SessionStatus.RECORDING,
    started_at: session.started_at ?? nowIso(),
    updated_at: nowIso(),
  };
  await upsertSession(updated);
  return updated;
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
  };
  await upsertSession(updated);
  return updated;
};

export const deleteSession = async (session: SessionRecord): Promise<void> => {
  await softDeleteSession(session.id);
};

export const fetchSessions = (workspaceId: string) => listSessions(workspaceId);

// --- Notes / Bookmarks / Media --------------------------------------------
export const addNote = async (input: {
  session: SessionRecord;
  createdBy: string;
  text: string;
  offsetMs: number;
}): Promise<NoteRecord> => {
  const now = nowIso();
  const note: NoteRecord = {
    id: generateId(),
    workspace_id: input.session.workspace_id,
    project_id: input.session.project_id,
    session_id: input.session.id,
    text: input.text,
    recording_offset_ms: input.offsetMs,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
  };
  await insertNote(note);
  await recordTimelineEvent(input.session, {
    event_type: TimelineEventType.NOTE_ADDED,
    source_entity_type: "note",
    source_entity_id: note.id,
    recording_offset_ms: note.recording_offset_ms,
    created_by: input.createdBy,
  });
  return note;
};

export const addBookmark = async (input: {
  session: SessionRecord;
  createdBy: string;
  label: string;
  offsetMs: number;
}): Promise<BookmarkRecord> => {
  const now = nowIso();
  const bookmark: BookmarkRecord = {
    id: generateId(),
    workspace_id: input.session.workspace_id,
    project_id: input.session.project_id,
    session_id: input.session.id,
    label: input.label,
    recording_offset_ms: input.offsetMs,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
  };
  await insertBookmark(bookmark);
  await recordTimelineEvent(input.session, {
    event_type: TimelineEventType.BOOKMARK_ADDED,
    source_entity_type: "bookmark",
    source_entity_id: bookmark.id,
    recording_offset_ms: bookmark.recording_offset_ms,
    created_by: input.createdBy,
  });
  return bookmark;
};

export const addMediaAsset = async (input: {
  session: SessionRecord;
  addedBy: string;
  assetType: "image" | "video" | "document";
  mimeType: string;
  originalFileName: string;
  sanitizedFileName: string;
  localFileUri: string | null;
  fileSize: number;
  durationMs?: number | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  offsetMs: number;
  userCaption?: string | null;
}): Promise<MediaAssetRecord> => {
  const now = nowIso();
  const asset: MediaAssetRecord = {
    id: generateId(),
    workspace_id: input.session.workspace_id,
    project_id: input.session.project_id,
    session_id: input.session.id,
    added_by: input.addedBy,
    asset_type: input.assetType,
    mime_type: input.mimeType,
    original_file_name: input.originalFileName,
    sanitized_file_name: input.sanitizedFileName,
    local_file_uri: input.localFileUri,
    file_size: input.fileSize,
    duration_ms: input.durationMs ?? null,
    image_width: input.imageWidth ?? null,
    image_height: input.imageHeight ?? null,
    recording_offset_ms: input.offsetMs,
    user_caption: input.userCaption ?? null,
    upload_status: UploadStatus.LOCAL_ONLY,
    created_at: now,
    updated_at: now,
  };
  await insertMediaAsset(asset);
  const eventType =
    input.assetType === "image"
      ? TimelineEventType.IMAGE_ADDED
      : input.assetType === "video"
        ? TimelineEventType.VIDEO_ADDED
        : TimelineEventType.DOCUMENT_ADDED;
  await recordTimelineEvent(input.session, {
    event_type: eventType,
    source_entity_type: "media_asset",
    source_entity_id: asset.id,
    recording_offset_ms: asset.recording_offset_ms,
    created_by: input.addedBy,
  });
  return asset;
};

// --- Timeline --------------------------------------------------------------
export const recordTimelineEvent = async (
  session: SessionRecord,
  event: Omit<
    TimelineEventRecord,
    "id" | "workspace_id" | "project_id" | "session_id" | "created_at"
  >,
): Promise<TimelineEventRecord> => {
  const record: TimelineEventRecord = {
    id: generateId(),
    workspace_id: session.workspace_id,
    project_id: session.project_id,
    session_id: session.id,
    ...event,
    created_at: nowIso(),
  };
  await insertTimelineEvent(record);
  return record;
};

export const getSessionBundle = async (sessionId: string) => {
  const [notes, bookmarks, assets, timeline] = await Promise.all([
    listNotesForSession(sessionId),
    listBookmarksForSession(sessionId),
    listMediaAssetsForSession(sessionId),
    listTimelineEvents(sessionId),
  ]);
  return { notes, bookmarks, assets, timeline };
};
