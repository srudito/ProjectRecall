import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionRecord } from "@/src/services/sqlite/repository";

import { getSupabase } from "./client";
import {
  normalizeProjectSyncError,
  ProjectSyncError,
  type ProjectSyncErrorCode,
} from "./project-repository";

interface RemoteSessionRow {
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
}

const SESSION_COLUMNS =
  "id,workspace_id,project_id,created_by,title,session_type,status,started_at,stopped_at,total_recorded_duration_ms,spoken_language_mode,expected_spoken_languages,detected_spoken_languages,primary_detected_language,language_detection_status,summary_output_language,translation_target_language,transcript_display_mode,language_metadata,local_sync_status,cloud_sync_status,created_at,updated_at,deleted_at" as const;

const safeMessageForCode = (code: ProjectSyncErrorCode): string => {
  switch (code) {
    case "SUPABASE_NOT_CONFIGURED":
      return "Cloud synchronization is not configured.";
    case "AUTHENTICATION_REQUIRED":
      return "Sign in again to synchronize this session.";
    case "NETWORK_UNAVAILABLE":
      return "The session is saved locally and will synchronize when the network is available.";
    case "RATE_LIMITED":
      return "Cloud synchronization is temporarily busy and will retry automatically.";
    case "REMOTE_SERVER_ERROR":
      return "The cloud service is temporarily unavailable and will retry automatically.";
    case "REMOTE_ACCESS_DENIED":
      return "You do not have permission to synchronize this session.";
    case "REMOTE_CONFLICT":
      return "The session could not be synchronized because of a data conflict.";
    case "REMOTE_VALIDATION_ERROR":
      return "The session data was rejected by the cloud database.";
    default:
      return "The session could not be synchronized.";
  }
};

export const normalizeSessionSyncError = (
  error: unknown,
  statusOverride?: number | null,
): ProjectSyncError => {
  const normalized = normalizeProjectSyncError(error, statusOverride);
  return new ProjectSyncError(
    normalized.code,
    safeMessageForCode(normalized.code),
    {
      retryable: normalized.retryable,
      status: normalized.status,
      cause: normalized.cause ?? error,
    },
  );
};

const requireAuthenticatedClient = async (
  clientOverride?: SupabaseClient,
): Promise<{ client: SupabaseClient; userId: string }> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new ProjectSyncError(
      "SUPABASE_NOT_CONFIGURED",
      safeMessageForCode("SUPABASE_NOT_CONFIGURED"),
      { retryable: false },
    );
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw normalizeSessionSyncError(error, 401);

  const userId = data.session?.user.id;
  if (!userId) {
    throw new ProjectSyncError(
      "AUTHENTICATION_REQUIRED",
      safeMessageForCode("AUTHENTICATION_REQUIRED"),
      { retryable: true, status: 401 },
    );
  }

  return { client, userId };
};

const toRemotePayload = (session: SessionRecord): RemoteSessionRow => ({
  id: session.id,
  workspace_id: session.workspace_id,
  project_id: session.project_id,
  created_by: session.created_by,
  title: session.title,
  session_type: session.session_type,
  status: session.status,
  started_at: session.started_at,
  stopped_at: session.stopped_at,
  total_recorded_duration_ms: session.total_recorded_duration_ms,
  spoken_language_mode: session.spoken_language_mode,
  expected_spoken_languages: session.expected_spoken_languages,
  detected_spoken_languages: session.detected_spoken_languages,
  primary_detected_language: session.primary_detected_language,
  language_detection_status: session.language_detection_status,
  summary_output_language: session.summary_output_language,
  translation_target_language: session.translation_target_language,
  transcript_display_mode: session.transcript_display_mode,
  language_metadata: session.language_metadata,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  created_at: session.created_at,
  updated_at: session.updated_at,
  deleted_at: session.deleted_at,
});

export const mapRemoteSession = (row: RemoteSessionRow): SessionRecord => ({
  ...row,
  expected_spoken_languages: row.expected_spoken_languages ?? [],
  detected_spoken_languages: row.detected_spoken_languages ?? [],
  language_metadata: row.language_metadata ?? null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: new Date().toISOString(),
});

export const upsertRemoteSession = async (
  session: SessionRecord,
  clientOverride?: SupabaseClient,
): Promise<SessionRecord> => {
  const { client, userId } = await requireAuthenticatedClient(clientOverride);
  if (userId !== session.created_by) {
    throw new ProjectSyncError(
      "REMOTE_ACCESS_DENIED",
      safeMessageForCode("REMOTE_ACCESS_DENIED"),
      { retryable: false, status: 403 },
    );
  }

  const response = await client
    .from("sessions")
    .upsert(toRemotePayload(session), { onConflict: "id" })
    .select(SESSION_COLUMNS)
    .single();

  if (response.error) {
    throw normalizeSessionSyncError(response.error, response.status);
  }

  return mapRemoteSession(response.data);
};

export const fetchRemoteSessions = async (
  workspaceId: string,
  clientOverride?: SupabaseClient,
): Promise<SessionRecord[]> => {
  const { client } = await requireAuthenticatedClient(clientOverride);

  const response = await client
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (response.error) {
    throw normalizeSessionSyncError(response.error, response.status);
  }

  return (response.data ?? []).map(mapRemoteSession);
};

export const fetchRemoteSession = async (
  sessionId: string,
  clientOverride?: SupabaseClient,
): Promise<SessionRecord | null> => {
  const { client } = await requireAuthenticatedClient(clientOverride);

  const response = await client
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .is("deleted_at", null)
    .maybeSingle();

  if (response.error) {
    throw normalizeSessionSyncError(response.error, response.status);
  }

  return response.data ? mapRemoteSession(response.data) : null;
};
