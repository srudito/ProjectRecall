// Session service — thin wrappers that keep local SQLite in sync with Supabase
// where credentials are configured, and fall back to local-only otherwise.

import * as Crypto from "expo-crypto";

import { SessionStatus, SpokenLanguageMode, TimelineEventType, UploadStatus } from "@/src/domain/enums";
import {
  BookmarkRecord,
  MediaAssetRecord,
  NoteRecord,
  ProjectRecord,
  SessionRecord,
  TimelineEventRecord,
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
} from "@/src/services/sqlite/repository";

const generateId = () => Crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// --- Project ---------------------------------------------------------------
export interface CreateProjectInput {
  workspaceId: string;
  createdBy: string;
  name: string;
  description?: string;
}

export const createProject = async (input: CreateProjectInput): Promise<ProjectRecord> => {
  const now = nowIso();
const project: ProjectRecord = {
  id: generateId(),
  workspace_id: input.workspaceId,
  name: input.name,
  description: input.description ?? null,
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
  await upsertProject(project);
  return project;
};

export const fetchProjects = (workspaceId: string) => listProjects(workspaceId);

// --- Session ---------------------------------------------------------------
export interface CreateSessionInput {
  workspaceId: string;
  createdBy: string;
  projectId: string | null;
  title: string;
  spokenLanguageMode: SpokenLanguageMode;
  expectedSpokenLanguages: string[];
}

export const createSession = async (input: CreateSessionInput): Promise<SessionRecord> => {
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

export const setSessionStatus = async (session: SessionRecord, status: string): Promise<SessionRecord> => {
  const updated = { ...session, status, updated_at: nowIso() };
  await upsertSession(updated);
  return updated;
};

export const markSessionRecording = async (session: SessionRecord): Promise<SessionRecord> => {
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

// --- Timeline ---------------------------------------------------------------
export const recordTimelineEvent = async (
  session: SessionRecord,
  event: Omit<TimelineEventRecord, "id" | "workspace_id" | "project_id" | "session_id" | "created_at">,
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
