import * as FileSystem from "expo-file-system/legacy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

import { env } from "@/src/config/env";

import { getSupabase } from "./client";
import {
  normalizeRecordingSyncError,
  RecordingSyncError,
} from "./recording-repository";

export const SESSION_ASSETS_BUCKET = "session-assets";

const validateStoragePath = (path: string): void => {
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    segments.length < 4 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\"),
    )
  ) {
    throw new RecordingSyncError(
      "REMOTE_VALIDATION_ERROR",
      "The recording Storage path is invalid.",
      { retryable: false, status: 400 },
    );
  }
};

const encodeStoragePath = (path: string): string =>
  path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const requireAuthenticatedClient = async (
  clientOverride?: SupabaseClient,
): Promise<{
  client: SupabaseClient;
  accessToken: string;
}> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new RecordingSyncError(
      "SUPABASE_NOT_CONFIGURED",
      "Cloud recording storage is not configured.",
      { retryable: false },
    );
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw normalizeRecordingSyncError(error, 401);
  const accessToken = data.session?.access_token;
  if (!accessToken) {
    throw new RecordingSyncError(
      "AUTHENTICATION_REQUIRED",
      "Sign in again to upload this recording.",
      { retryable: true, status: 401 },
    );
  }
  return { client, accessToken };
};

const uploadWebBlob = async (input: {
  client: SupabaseClient;
  path: string;
  fileUri: string;
  mimeType: string;
}): Promise<void> => {
  const response = await fetch(input.fileUri);
  if (!response.ok) {
    throw new RecordingSyncError(
      "REMOTE_VALIDATION_ERROR",
      "The browser recording could not be read for upload.",
      { retryable: false, status: response.status },
    );
  }
  const blob = await response.blob();
  const result = await input.client.storage
    .from(SESSION_ASSETS_BUCKET)
    .upload(input.path, blob, {
      contentType: input.mimeType || blob.type || "application/octet-stream",
      upsert: true,
      cacheControl: "3600",
    });
  if (result.error) {
    throw normalizeRecordingSyncError(result.error);
  }
};

const uploadNativeFile = async (input: {
  path: string;
  fileUri: string;
  mimeType: string;
  accessToken: string;
}): Promise<void> => {
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    throw new RecordingSyncError(
      "SUPABASE_NOT_CONFIGURED",
      "Cloud recording storage is not configured.",
      { retryable: false },
    );
  }

  const info = await FileSystem.getInfoAsync(input.fileUri);
  if (!info.exists) {
    throw new RecordingSyncError(
      "REMOTE_VALIDATION_ERROR",
      "The local recording file is no longer available.",
      { retryable: false, status: 400 },
    );
  }

  const url = `${env.supabaseUrl}/storage/v1/object/${SESSION_ASSETS_BUCKET}/${encodeStoragePath(input.path)}`;
  let result: Awaited<ReturnType<typeof FileSystem.uploadAsync>>;
  try {
    result = await FileSystem.uploadAsync(url, input.fileUri, {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        apikey: env.supabaseAnonKey,
        "Content-Type": input.mimeType,
        "x-upsert": "true",
      },
    });
  } catch (error) {
    throw normalizeRecordingSyncError(error);
  }

  if (result.status < 200 || result.status >= 300) {
    let message = result.body;
    try {
      const parsed = JSON.parse(result.body) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? result.body;
    } catch {
      // Preserve the safe HTTP body for error classification below.
    }
    throw normalizeRecordingSyncError(
      { message, status: result.status },
      result.status,
    );
  }
};

export const uploadPrivateSessionAsset = async (input: {
  path: string;
  fileUri: string;
  mimeType: string;
  client?: SupabaseClient;
}): Promise<void> => {
  validateStoragePath(input.path);
  const { client, accessToken } = await requireAuthenticatedClient(input.client);

  if (Platform.OS === "web") {
    await uploadWebBlob({
      client,
      path: input.path,
      fileUri: input.fileUri,
      mimeType: input.mimeType,
    });
    return;
  }

  await uploadNativeFile({
    path: input.path,
    fileUri: input.fileUri,
    mimeType: input.mimeType,
    accessToken,
  });
};

export const createSignedSessionAssetUrl = async (input: {
  path: string;
  expiresInSeconds?: number;
  client?: SupabaseClient;
}): Promise<string> => {
  validateStoragePath(input.path);
  const { client } = await requireAuthenticatedClient(input.client);
  const response = await client.storage
    .from(SESSION_ASSETS_BUCKET)
    .createSignedUrl(input.path, input.expiresInSeconds ?? 15 * 60);
  if (response.error) {
    throw normalizeRecordingSyncError(response.error);
  }
  return response.data.signedUrl;
};
