import type { SupabaseClient } from "@supabase/supabase-js";

import type { RecordingRecord } from "@/src/services/sqlite/repository";

import { getSupabase } from "./client";

export type RecordingSyncErrorCode =
  | "SUPABASE_NOT_CONFIGURED"
  | "AUTHENTICATION_REQUIRED"
  | "NETWORK_UNAVAILABLE"
  | "RATE_LIMITED"
  | "REMOTE_SERVER_ERROR"
  | "REMOTE_ACCESS_DENIED"
  | "REMOTE_CONFLICT"
  | "REMOTE_VALIDATION_ERROR"
  | "REMOTE_UNKNOWN_ERROR";

export class RecordingSyncError extends Error {
  readonly code: RecordingSyncErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly cause?: unknown;

  constructor(
    code: RecordingSyncErrorCode,
    message: string,
    options: {
      retryable: boolean;
      status?: number | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "RecordingSyncError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.cause = options.cause;
  }
}

interface RemoteErrorShape {
  code?: string;
  message?: string;
  status?: number;
}

export interface RemoteRecordingRow {
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

const RECORDING_COLUMNS =
  "id,workspace_id,project_id,session_id,local_file_uri,private_storage_path,mime_type,original_file_name,file_size,duration_ms,recording_format,checksum_sha256,upload_status,upload_error_code,upload_error_message,created_at,updated_at" as const;

const safeMessageForCode = (code: RecordingSyncErrorCode): string => {
  switch (code) {
    case "SUPABASE_NOT_CONFIGURED":
      return "Cloud recording storage is not configured.";
    case "AUTHENTICATION_REQUIRED":
      return "Sign in again to synchronize this recording.";
    case "NETWORK_UNAVAILABLE":
      return "The recording is saved locally and will upload when the network is available.";
    case "RATE_LIMITED":
      return "Recording upload is temporarily busy and will retry automatically.";
    case "REMOTE_SERVER_ERROR":
      return "Cloud recording storage is temporarily unavailable and will retry automatically.";
    case "REMOTE_ACCESS_DENIED":
      return "You do not have permission to store this recording.";
    case "REMOTE_CONFLICT":
      return "The recording could not be stored because of a data conflict.";
    case "REMOTE_VALIDATION_ERROR":
      return "The recording metadata was rejected by the cloud database.";
    default:
      return "The recording could not be synchronized.";
  }
};

export const normalizeRecordingSyncError = (
  error: unknown,
  statusOverride?: number | null,
): RecordingSyncError => {
  if (error instanceof RecordingSyncError) return error;

  const shape = (error ?? {}) as RemoteErrorShape;
  const status = statusOverride ?? shape.status ?? null;
  const code = shape.code ?? "";
  const message = String(shape.message ?? error ?? "").toLowerCase();

  if (
    error instanceof TypeError ||
    message.includes("failed to fetch") ||
    message.includes("network request failed") ||
    message.includes("networkerror") ||
    message.includes("timeout")
  ) {
    return new RecordingSyncError(
      "NETWORK_UNAVAILABLE",
      safeMessageForCode("NETWORK_UNAVAILABLE"),
      { retryable: true, status, cause: error },
    );
  }

  if (status === 401 || code === "PGRST301" || message.includes("jwt")) {
    return new RecordingSyncError(
      "AUTHENTICATION_REQUIRED",
      safeMessageForCode("AUTHENTICATION_REQUIRED"),
      { retryable: true, status, cause: error },
    );
  }

  if (status === 429) {
    return new RecordingSyncError(
      "RATE_LIMITED",
      safeMessageForCode("RATE_LIMITED"),
      { retryable: true, status, cause: error },
    );
  }

  if ((status != null && status >= 500) || code.startsWith("08")) {
    return new RecordingSyncError(
      "REMOTE_SERVER_ERROR",
      safeMessageForCode("REMOTE_SERVER_ERROR"),
      { retryable: true, status, cause: error },
    );
  }

  if (
    status === 403 ||
    code === "42501" ||
    message.includes("row-level security") ||
    message.includes("permission denied")
  ) {
    return new RecordingSyncError(
      "REMOTE_ACCESS_DENIED",
      safeMessageForCode("REMOTE_ACCESS_DENIED"),
      { retryable: false, status, cause: error },
    );
  }

  if (status === 409 || code === "23505") {
    return new RecordingSyncError(
      "REMOTE_CONFLICT",
      safeMessageForCode("REMOTE_CONFLICT"),
      { retryable: false, status, cause: error },
    );
  }

  if (
    status === 400 ||
    code.startsWith("22") ||
    code.startsWith("23") ||
    code.startsWith("PGRST")
  ) {
    return new RecordingSyncError(
      "REMOTE_VALIDATION_ERROR",
      safeMessageForCode("REMOTE_VALIDATION_ERROR"),
      { retryable: false, status, cause: error },
    );
  }

  return new RecordingSyncError(
    "REMOTE_UNKNOWN_ERROR",
    safeMessageForCode("REMOTE_UNKNOWN_ERROR"),
    { retryable: false, status, cause: error },
  );
};

const requireAuthenticatedClient = async (
  clientOverride?: SupabaseClient,
): Promise<{ client: SupabaseClient; userId: string }> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new RecordingSyncError(
      "SUPABASE_NOT_CONFIGURED",
      safeMessageForCode("SUPABASE_NOT_CONFIGURED"),
      { retryable: false },
    );
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw normalizeRecordingSyncError(error, 401);
  const userId = data.session?.user.id;
  if (!userId) {
    throw new RecordingSyncError(
      "AUTHENTICATION_REQUIRED",
      safeMessageForCode("AUTHENTICATION_REQUIRED"),
      { retryable: true, status: 401 },
    );
  }

  return { client, userId };
};

const toRemotePayload = (recording: RecordingRecord): RemoteRecordingRow => ({
  id: recording.id,
  workspace_id: recording.workspace_id,
  project_id: recording.project_id,
  session_id: recording.session_id,
  // Never persist device-specific file:// or browser blob: URIs in cloud rows.
  local_file_uri: null,
  private_storage_path: recording.private_storage_path,
  mime_type: recording.mime_type,
  original_file_name: recording.original_file_name,
  file_size: recording.file_size,
  duration_ms: recording.duration_ms,
  recording_format: recording.recording_format,
  checksum_sha256: recording.checksum_sha256,
  upload_status: recording.upload_status,
  upload_error_code: recording.upload_error_code,
  upload_error_message: recording.upload_error_message,
  created_at: recording.created_at,
  updated_at: recording.updated_at,
});

export const mapRemoteRecording = (
  row: RemoteRecordingRow,
): RecordingRecord => ({
  ...row,
  local_file_uri: null,
});

export const upsertRemoteRecording = async (
  recording: RecordingRecord,
  clientOverride?: SupabaseClient,
): Promise<RecordingRecord> => {
  const { client } = await requireAuthenticatedClient(clientOverride);
  const response = await client
    .from("recordings")
    .upsert(toRemotePayload(recording), { onConflict: "id" })
    .select(RECORDING_COLUMNS)
    .single();

  if (response.error) {
    throw normalizeRecordingSyncError(response.error, response.status);
  }

  return mapRemoteRecording(response.data);
};

export const fetchRemoteRecordingForSession = async (
  sessionId: string,
  clientOverride?: SupabaseClient,
): Promise<RecordingRecord | null> => {
  const { client } = await requireAuthenticatedClient(clientOverride);
  const response = await client
    .from("recordings")
    .select(RECORDING_COLUMNS)
    .eq("session_id", sessionId)
    .maybeSingle();

  if (response.error) {
    throw normalizeRecordingSyncError(response.error, response.status);
  }

  return response.data ? mapRemoteRecording(response.data) : null;
};

export const fetchRemoteRecordings = async (
  workspaceId: string,
  clientOverride?: SupabaseClient,
): Promise<RecordingRecord[]> => {
  const { client } = await requireAuthenticatedClient(clientOverride);
  const response = await client
    .from("recordings")
    .select(RECORDING_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });

  if (response.error) {
    throw normalizeRecordingSyncError(response.error, response.status);
  }

  return (response.data ?? []).map(mapRemoteRecording);
};
