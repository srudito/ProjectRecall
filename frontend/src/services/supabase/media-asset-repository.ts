import type { SupabaseClient } from "@supabase/supabase-js";

import type { MediaAssetRecord } from "@/src/services/sqlite/repository";

import { getSupabase } from "./client";
import {
  RecordingSyncError,
  type RecordingSyncErrorCode,
} from "./recording-repository";

export type MediaAssetSyncErrorCode = RecordingSyncErrorCode;

export class MediaAssetSyncError extends Error {
  readonly code: MediaAssetSyncErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly cause?: unknown;

  constructor(
    code: MediaAssetSyncErrorCode,
    message: string,
    options: {
      retryable: boolean;
      status?: number | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "MediaAssetSyncError";
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
  retryable?: boolean;
}

export interface RemoteMediaAssetRow {
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

const MEDIA_ASSET_COLUMNS =
  "id,workspace_id,project_id,session_id,added_by,asset_type,mime_type,original_file_name,sanitized_file_name,local_file_uri,private_storage_path,file_size,duration_ms,image_width,image_height,page_count,captured_at,recording_offset_ms,user_caption,checksum_sha256,upload_status,upload_error_code,upload_error_message,created_at,updated_at,deleted_at" as const;

const safeMessageForCode = (code: MediaAssetSyncErrorCode): string => {
  switch (code) {
    case "SUPABASE_NOT_CONFIGURED":
      return "Cloud evidence storage is not configured.";
    case "AUTHENTICATION_REQUIRED":
      return "Sign in again to synchronize this evidence.";
    case "NETWORK_UNAVAILABLE":
      return "The evidence is saved locally and will upload when the network is available.";
    case "RATE_LIMITED":
      return "Evidence upload is temporarily busy and will retry automatically.";
    case "REMOTE_SERVER_ERROR":
      return "Cloud evidence storage is temporarily unavailable and will retry automatically.";
    case "REMOTE_ACCESS_DENIED":
      return "You do not have permission to store this evidence.";
    case "REMOTE_CONFLICT":
      return "The evidence could not be stored because of a data conflict.";
    case "REMOTE_VALIDATION_ERROR":
      return "The evidence metadata was rejected by the cloud database.";
    default:
      return "The evidence could not be synchronized.";
  }
};

export const normalizeMediaAssetSyncError = (
  error: unknown,
  statusOverride?: number | null,
): MediaAssetSyncError => {
  if (error instanceof MediaAssetSyncError) return error;

  if (error instanceof RecordingSyncError) {
    return new MediaAssetSyncError(error.code, safeMessageForCode(error.code), {
      retryable: error.retryable,
      status: error.status,
      cause: error,
    });
  }

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
    return new MediaAssetSyncError(
      "NETWORK_UNAVAILABLE",
      safeMessageForCode("NETWORK_UNAVAILABLE"),
      { retryable: true, status, cause: error },
    );
  }

  if (status === 401 || code === "PGRST301" || message.includes("jwt")) {
    return new MediaAssetSyncError(
      "AUTHENTICATION_REQUIRED",
      safeMessageForCode("AUTHENTICATION_REQUIRED"),
      { retryable: true, status, cause: error },
    );
  }

  if (status === 429) {
    return new MediaAssetSyncError(
      "RATE_LIMITED",
      safeMessageForCode("RATE_LIMITED"),
      { retryable: true, status, cause: error },
    );
  }

  if ((status != null && status >= 500) || code.startsWith("08")) {
    return new MediaAssetSyncError(
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
    return new MediaAssetSyncError(
      "REMOTE_ACCESS_DENIED",
      safeMessageForCode("REMOTE_ACCESS_DENIED"),
      { retryable: false, status, cause: error },
    );
  }

  if (status === 409 || code === "23505") {
    return new MediaAssetSyncError(
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
    return new MediaAssetSyncError(
      "REMOTE_VALIDATION_ERROR",
      safeMessageForCode("REMOTE_VALIDATION_ERROR"),
      { retryable: false, status, cause: error },
    );
  }

  return new MediaAssetSyncError(
    "REMOTE_UNKNOWN_ERROR",
    safeMessageForCode("REMOTE_UNKNOWN_ERROR"),
    { retryable: false, status, cause: error },
  );
};

const requireAuthenticatedClient = async (
  clientOverride?: SupabaseClient,
): Promise<SupabaseClient> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new MediaAssetSyncError(
      "SUPABASE_NOT_CONFIGURED",
      safeMessageForCode("SUPABASE_NOT_CONFIGURED"),
      { retryable: false },
    );
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw normalizeMediaAssetSyncError(error, 401);
  if (!data.session?.user.id) {
    throw new MediaAssetSyncError(
      "AUTHENTICATION_REQUIRED",
      safeMessageForCode("AUTHENTICATION_REQUIRED"),
      { retryable: true, status: 401 },
    );
  }
  return client;
};

const toRemotePayload = (asset: MediaAssetRecord): RemoteMediaAssetRow => ({
  id: asset.id,
  workspace_id: asset.workspace_id,
  project_id: asset.project_id,
  session_id: asset.session_id,
  added_by: asset.added_by,
  asset_type: asset.asset_type,
  mime_type: asset.mime_type,
  original_file_name: asset.original_file_name,
  sanitized_file_name: asset.sanitized_file_name,
  local_file_uri: null,
  private_storage_path: asset.private_storage_path,
  file_size: asset.file_size,
  duration_ms: asset.duration_ms,
  image_width: asset.image_width,
  image_height: asset.image_height,
  page_count: asset.page_count,
  captured_at: asset.captured_at,
  recording_offset_ms: asset.recording_offset_ms,
  user_caption: asset.user_caption,
  checksum_sha256: asset.checksum_sha256,
  upload_status: asset.upload_status,
  upload_error_code: asset.upload_error_code,
  upload_error_message: asset.upload_error_message,
  created_at: asset.created_at,
  updated_at: asset.updated_at,
  deleted_at: asset.deleted_at,
});

export const mapRemoteMediaAsset = (
  row: RemoteMediaAssetRow,
): MediaAssetRecord => ({
  ...row,
  local_file_uri: null,
});

export const upsertRemoteMediaAsset = async (
  asset: MediaAssetRecord,
  clientOverride?: SupabaseClient,
): Promise<MediaAssetRecord> => {
  const client = await requireAuthenticatedClient(clientOverride);
  const response = await client
    .from("media_assets")
    .upsert(toRemotePayload(asset), { onConflict: "id" })
    .select(MEDIA_ASSET_COLUMNS)
    .single();

  if (response.error) {
    throw normalizeMediaAssetSyncError(response.error, response.status);
  }
  return mapRemoteMediaAsset(response.data);
};

export const fetchRemoteMediaAssets = async (
  sessionId: string,
  clientOverride?: SupabaseClient,
): Promise<MediaAssetRecord[]> => {
  const client = await requireAuthenticatedClient(clientOverride);
  const response = await client
    .from("media_assets")
    .select(MEDIA_ASSET_COLUMNS)
    .eq("session_id", sessionId)
    .is("deleted_at", null)
    .order("recording_offset_ms", { ascending: true })
    .order("created_at", { ascending: true });

  if (response.error) {
    throw normalizeMediaAssetSyncError(response.error, response.status);
  }
  return (response.data ?? []).map(mapRemoteMediaAsset);
};

export const fetchRemoteMediaAsset = async (
  assetId: string,
  clientOverride?: SupabaseClient,
): Promise<MediaAssetRecord | null> => {
  const client = await requireAuthenticatedClient(clientOverride);
  const response = await client
    .from("media_assets")
    .select(MEDIA_ASSET_COLUMNS)
    .eq("id", assetId)
    .is("deleted_at", null)
    .maybeSingle();

  if (response.error) {
    throw normalizeMediaAssetSyncError(response.error, response.status);
  }
  return response.data ? mapRemoteMediaAsset(response.data) : null;
};
