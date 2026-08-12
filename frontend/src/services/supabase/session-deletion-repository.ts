import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabase } from "./client";
import { ProjectSyncError } from "./project-repository";
import { normalizeSessionSyncError } from "./session-repository";

const normalizeSessionDeletionError = (
  error: unknown,
  status?: number | null,
): ProjectSyncError => {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");

  if (message.includes("TRANSCRIPTION_PROVIDER_SUBMISSION_IN_PROGRESS")) {
    return new ProjectSyncError(
      "TRANSCRIPTION_PROVIDER_SUBMISSION_IN_PROGRESS",
      "Transcription submission is still in progress. Session cleanup will retry automatically.",
      { retryable: true, status, cause: error },
    );
  }

  if (message.includes("TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED")) {
    return new ProjectSyncError(
      "TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED",
      "Transcription provider cleanup is still pending. Session cleanup will retry automatically.",
      { retryable: true, status, cause: error },
    );
  }

  return normalizeSessionSyncError(error, status);
};

const requireAuthenticatedClient = async (
  clientOverride?: SupabaseClient,
): Promise<SupabaseClient> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new ProjectSyncError(
      "SUPABASE_NOT_CONFIGURED",
      "Cloud deletion is not configured.",
      { retryable: false },
    );
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw normalizeSessionSyncError(error, 401);
  if (!data.session?.user.id) {
    throw new ProjectSyncError(
      "AUTHENTICATION_REQUIRED",
      "Sign in again to finish deleting this session.",
      { retryable: true, status: 401 },
    );
  }
  return client;
};

/**
 * Delete the session row. Existing foreign-key cascades remove recording,
 * evidence, note, bookmark, timeline, upload audit, and future session rows.
 * A missing row is treated as already deleted, making retries idempotent.
 */
export const deleteRemoteSessionCascade = async (input: {
  sessionId: string;
  workspaceId: string;
  client?: SupabaseClient;
}): Promise<void> => {
  const client = await requireAuthenticatedClient(input.client);
  const response = await client
    .from("sessions")
    .delete()
    .eq("id", input.sessionId)
    .eq("workspace_id", input.workspaceId)
    .select("id");

  if (response.error) {
    throw normalizeSessionDeletionError(response.error, response.status);
  }
};
