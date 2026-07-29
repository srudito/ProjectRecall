// Session service. Projects, sessions, notes, bookmarks, and supported timeline
// events are local-first on native and remote-backed on web. Recording/media
// metadata and binary files remain local-only until the Storage milestone.

import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

import {
  SessionStatus,
  type SpokenLanguageMode,
  TimelineEventType,
  UploadStatus,
} from "@/src/domain/enums";
import {
  atomicCreateBookmarkWithTimelineSync,
  atomicCreateNoteWithTimelineSync,
  atomicCreateProjectWithSync,
  atomicCreateTimelineEventWithSync,
  atomicRequeueProjectSync,
  atomicRequeueSessionSync,
  atomicUpsertSessionWithSync,
  deleteMetadataOperationsForEntity,
  getBookmark,
  getNote,
  getProject,
  getSession,
  getTimelineEvent,
  insertMediaAsset,
  insertTimelineEvent,
  listBookmarksForSession,
  listMediaAssetsForSession,
  listNotesForSession,
  listProjects,
  listSessions,
  listTimelineEvents,
  softDeleteSession,
  upsertBookmark,
  upsertNote,
  upsertProject,
  upsertSession,
  upsertTimelineEvent,
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
import { notifyMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { requestMetadataSync } from "@/src/services/sync/project-sync-worker";
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
  const [remoteNotes, remoteBookmarks, remoteTimeline] = await Promise.all([
    fetchRemoteNotes(sessionId),
    fetchRemoteBookmarks(sessionId),
    fetchRemoteTimelineEvents(sessionId),
  ]);

  const [notesChanged, bookmarksChanged, timelineChanged] = await Promise.all([
    mergeRemoteNotesIntoLocal(remoteNotes),
    mergeRemoteBookmarksIntoLocal(remoteBookmarks),
    mergeRemoteTimelineIntoLocal(remoteTimeline),
  ]);

  const changed = notesChanged || bookmarksChanged || timelineChanged;
  if (changed) notifyMetadataSyncChanges();
  requestMetadataSync();
  return changed;
};

export const getSessionBundle = async (sessionId: string) => {
  requireUuid(sessionId, "sessionId");

  if (Platform.OS === "web") {
    const [notes, bookmarks, timeline] = await Promise.all([
      fetchRemoteNotes(sessionId),
      fetchRemoteBookmarks(sessionId),
      fetchRemoteTimelineEvents(sessionId),
    ]);
    return { notes, bookmarks, assets: [] as MediaAssetRecord[], timeline };
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
