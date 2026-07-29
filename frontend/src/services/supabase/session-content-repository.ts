import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  BookmarkRecord,
  NoteRecord,
  TimelineEventRecord,
} from "@/src/services/sqlite/repository";

import { getSupabase } from "./client";
import {
  normalizeProjectSyncError,
  ProjectSyncError,
  type ProjectSyncErrorCode,
} from "./project-repository";

interface RemoteNoteRow {
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

interface RemoteBookmarkRow {
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

interface RemoteTimelineEventRow {
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

const NOTE_COLUMNS =
  "id,workspace_id,project_id,session_id,text,recording_offset_ms,created_by,created_at,updated_at,deleted_at" as const;

const BOOKMARK_COLUMNS =
  "id,workspace_id,project_id,session_id,label,recording_offset_ms,created_by,created_at,updated_at,deleted_at" as const;

const TIMELINE_COLUMNS =
  "id,workspace_id,project_id,session_id,event_type,source_entity_type,source_entity_id,recording_offset_ms,created_by,created_at" as const;

type SessionContentEntity = "note" | "bookmark" | "timeline event";

const safeMessageForCode = (
  code: ProjectSyncErrorCode,
  entity: SessionContentEntity,
): string => {
  switch (code) {
    case "SUPABASE_NOT_CONFIGURED":
      return "Cloud synchronization is not configured.";
    case "AUTHENTICATION_REQUIRED":
      return `Sign in again to synchronize this ${entity}.`;
    case "NETWORK_UNAVAILABLE":
      return `The ${entity} is saved locally and will synchronize when the network is available.`;
    case "RATE_LIMITED":
      return "Cloud synchronization is temporarily busy and will retry automatically.";
    case "REMOTE_SERVER_ERROR":
      return "The cloud service is temporarily unavailable and will retry automatically.";
    case "REMOTE_ACCESS_DENIED":
      return `You do not have permission to synchronize this ${entity}.`;
    case "REMOTE_CONFLICT":
      return `The ${entity} could not be synchronized because of a data conflict.`;
    case "REMOTE_VALIDATION_ERROR":
      return `The ${entity} data was rejected by the cloud database.`;
    default:
      return `The ${entity} could not be synchronized.`;
  }
};

export const normalizeSessionContentSyncError = (
  error: unknown,
  entity: SessionContentEntity,
  statusOverride?: number | null,
): ProjectSyncError => {
  const normalized = normalizeProjectSyncError(error, statusOverride);
  return new ProjectSyncError(
    normalized.code,
    safeMessageForCode(normalized.code, entity),
    {
      retryable: normalized.retryable,
      status: normalized.status,
      cause: normalized.cause ?? error,
    },
  );
};

const requireAuthenticatedClient = async (
  entity: SessionContentEntity,
  clientOverride?: SupabaseClient,
): Promise<{ client: SupabaseClient; userId: string }> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new ProjectSyncError(
      "SUPABASE_NOT_CONFIGURED",
      safeMessageForCode("SUPABASE_NOT_CONFIGURED", entity),
      { retryable: false },
    );
  }

  const { data, error } = await client.auth.getSession();
  if (error) {
    throw normalizeSessionContentSyncError(error, entity, 401);
  }

  const userId = data.session?.user.id;
  if (!userId) {
    throw new ProjectSyncError(
      "AUTHENTICATION_REQUIRED",
      safeMessageForCode("AUTHENTICATION_REQUIRED", entity),
      { retryable: true, status: 401 },
    );
  }

  return { client, userId };
};

const assertCreator = (
  authenticatedUserId: string,
  createdBy: string,
  entity: SessionContentEntity,
): void => {
  if (authenticatedUserId === createdBy) return;

  throw new ProjectSyncError(
    "REMOTE_ACCESS_DENIED",
    safeMessageForCode("REMOTE_ACCESS_DENIED", entity),
    { retryable: false, status: 403 },
  );
};

const mapRemoteNote = (row: RemoteNoteRow): NoteRecord => ({
  ...row,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: new Date().toISOString(),
});

const mapRemoteBookmark = (row: RemoteBookmarkRow): BookmarkRecord => ({
  ...row,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: new Date().toISOString(),
});

const mapRemoteTimelineEvent = (
  row: RemoteTimelineEventRow,
): TimelineEventRecord => ({
  ...row,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: new Date().toISOString(),
});

export { mapRemoteBookmark, mapRemoteNote, mapRemoteTimelineEvent };

export const upsertRemoteNote = async (
  note: NoteRecord,
  clientOverride?: SupabaseClient,
): Promise<NoteRecord> => {
  const { client, userId } = await requireAuthenticatedClient(
    "note",
    clientOverride,
  );
  assertCreator(userId, note.created_by, "note");

  const response = await client
    .from("user_notes")
    .upsert(
      {
        id: note.id,
        workspace_id: note.workspace_id,
        project_id: note.project_id,
        session_id: note.session_id,
        text: note.text,
        recording_offset_ms: note.recording_offset_ms,
        created_by: note.created_by,
        created_at: note.created_at,
        updated_at: note.updated_at,
        deleted_at: note.deleted_at,
      },
      { onConflict: "id" },
    )
    .select(NOTE_COLUMNS)
    .single();

  if (response.error) {
    throw normalizeSessionContentSyncError(
      response.error,
      "note",
      response.status,
    );
  }

  return mapRemoteNote(response.data);
};

export const fetchRemoteNotes = async (
  sessionId: string,
  clientOverride?: SupabaseClient,
): Promise<NoteRecord[]> => {
  const { client } = await requireAuthenticatedClient("note", clientOverride);

  const response = await client
    .from("user_notes")
    .select(NOTE_COLUMNS)
    .eq("session_id", sessionId)
    .is("deleted_at", null)
    .order("recording_offset_ms", { ascending: true })
    .order("created_at", { ascending: true });

  if (response.error) {
    throw normalizeSessionContentSyncError(
      response.error,
      "note",
      response.status,
    );
  }

  return (response.data ?? []).map(mapRemoteNote);
};

export const upsertRemoteBookmark = async (
  bookmark: BookmarkRecord,
  clientOverride?: SupabaseClient,
): Promise<BookmarkRecord> => {
  const { client, userId } = await requireAuthenticatedClient(
    "bookmark",
    clientOverride,
  );
  assertCreator(userId, bookmark.created_by, "bookmark");

  const response = await client
    .from("bookmarks")
    .upsert(
      {
        id: bookmark.id,
        workspace_id: bookmark.workspace_id,
        project_id: bookmark.project_id,
        session_id: bookmark.session_id,
        label: bookmark.label,
        recording_offset_ms: bookmark.recording_offset_ms,
        created_by: bookmark.created_by,
        created_at: bookmark.created_at,
        updated_at: bookmark.updated_at,
        deleted_at: bookmark.deleted_at,
      },
      { onConflict: "id" },
    )
    .select(BOOKMARK_COLUMNS)
    .single();

  if (response.error) {
    throw normalizeSessionContentSyncError(
      response.error,
      "bookmark",
      response.status,
    );
  }

  return mapRemoteBookmark(response.data);
};

export const fetchRemoteBookmarks = async (
  sessionId: string,
  clientOverride?: SupabaseClient,
): Promise<BookmarkRecord[]> => {
  const { client } = await requireAuthenticatedClient(
    "bookmark",
    clientOverride,
  );

  const response = await client
    .from("bookmarks")
    .select(BOOKMARK_COLUMNS)
    .eq("session_id", sessionId)
    .is("deleted_at", null)
    .order("recording_offset_ms", { ascending: true })
    .order("created_at", { ascending: true });

  if (response.error) {
    throw normalizeSessionContentSyncError(
      response.error,
      "bookmark",
      response.status,
    );
  }

  return (response.data ?? []).map(mapRemoteBookmark);
};

export const upsertRemoteTimelineEvent = async (
  event: TimelineEventRecord,
  clientOverride?: SupabaseClient,
): Promise<TimelineEventRecord> => {
  const { client, userId } = await requireAuthenticatedClient(
    "timeline event",
    clientOverride,
  );
  assertCreator(userId, event.created_by, "timeline event");

  const response = await client
    .from("timeline_events")
    .upsert(
      {
        id: event.id,
        workspace_id: event.workspace_id,
        project_id: event.project_id,
        session_id: event.session_id,
        event_type: event.event_type,
        source_entity_type: event.source_entity_type,
        source_entity_id: event.source_entity_id,
        recording_offset_ms: event.recording_offset_ms,
        created_by: event.created_by,
        created_at: event.created_at,
      },
      { onConflict: "id" },
    )
    .select(TIMELINE_COLUMNS)
    .single();

  if (response.error) {
    throw normalizeSessionContentSyncError(
      response.error,
      "timeline event",
      response.status,
    );
  }

  return mapRemoteTimelineEvent(response.data);
};

export const fetchRemoteTimelineEvents = async (
  sessionId: string,
  clientOverride?: SupabaseClient,
): Promise<TimelineEventRecord[]> => {
  const { client } = await requireAuthenticatedClient(
    "timeline event",
    clientOverride,
  );

  const response = await client
    .from("timeline_events")
    .select(TIMELINE_COLUMNS)
    .eq("session_id", sessionId)
    .order("recording_offset_ms", { ascending: true })
    .order("created_at", { ascending: true });

  if (response.error) {
    throw normalizeSessionContentSyncError(
      response.error,
      "timeline event",
      response.status,
    );
  }

  return (response.data ?? []).map(mapRemoteTimelineEvent);
};
