import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionUserPreferenceRecord } from "@/src/services/sqlite/repository";

import { getSupabase } from "./client";
import {
  normalizeProjectSyncError,
  ProjectSyncError,
} from "./project-repository";

interface RemoteSessionPreferenceRow {
  user_id: string;
  session_id: string;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
}

const SESSION_PREFERENCE_COLUMNS =
  "user_id,session_id,is_starred,created_at,updated_at" as const;

const requireAuthenticatedClient = async (
  clientOverride?: SupabaseClient,
): Promise<{ client: SupabaseClient; userId: string }> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new ProjectSyncError(
      "SUPABASE_NOT_CONFIGURED",
      "Cloud synchronization is not configured.",
      { retryable: false },
    );
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw normalizeProjectSyncError(error, 401);
  const userId = data.session?.user.id;
  if (!userId) {
    throw new ProjectSyncError(
      "AUTHENTICATION_REQUIRED",
      "Sign in again to synchronize session preferences.",
      { retryable: true, status: 401 },
    );
  }

  return { client, userId };
};

const mapRemotePreference = (
  row: RemoteSessionPreferenceRow,
  workspaceId: string,
): SessionUserPreferenceRecord => ({
  id: `session-preference:${row.user_id}:${row.session_id}`,
  user_id: row.user_id,
  workspace_id: workspaceId,
  session_id: row.session_id,
  is_starred: row.is_starred,
  created_at: row.created_at,
  updated_at: row.updated_at,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: new Date().toISOString(),
});

export const upsertRemoteSessionPreference = async (
  preference: SessionUserPreferenceRecord,
  clientOverride?: SupabaseClient,
): Promise<SessionUserPreferenceRecord> => {
  const { client, userId } = await requireAuthenticatedClient(clientOverride);
  if (userId !== preference.user_id) {
    throw new ProjectSyncError(
      "REMOTE_ACCESS_DENIED",
      "You cannot change another user's session preferences.",
      { retryable: false, status: 403 },
    );
  }

  const response = await client
    .from("session_user_preferences")
    .upsert(
      {
        user_id: preference.user_id,
        session_id: preference.session_id,
        is_starred: preference.is_starred,
      },
      { onConflict: "user_id,session_id" },
    )
    .select(SESSION_PREFERENCE_COLUMNS)
    .single();

  if (response.error) {
    throw normalizeProjectSyncError(response.error, response.status);
  }

  return mapRemotePreference(
    response.data as unknown as RemoteSessionPreferenceRow,
    preference.workspace_id,
  );
};

const chunk = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

export const fetchRemoteSessionPreferences = async (input: {
  userId: string;
  workspaceId: string;
  sessionIds: string[];
  clientOverride?: SupabaseClient;
}): Promise<SessionUserPreferenceRecord[]> => {
  const { client, userId } = await requireAuthenticatedClient(
    input.clientOverride,
  );
  if (userId !== input.userId) {
    throw new ProjectSyncError(
      "REMOTE_ACCESS_DENIED",
      "You cannot read another user's session preferences.",
      { retryable: false, status: 403 },
    );
  }

  const uniqueSessionIds = [...new Set(input.sessionIds)];
  if (uniqueSessionIds.length === 0) return [];

  const rows: RemoteSessionPreferenceRow[] = [];
  for (const sessionIdChunk of chunk(uniqueSessionIds, 100)) {
    const response = await client
      .from("session_user_preferences")
      .select(SESSION_PREFERENCE_COLUMNS)
      .eq("user_id", input.userId)
      .in("session_id", sessionIdChunk);

    if (response.error) {
      throw normalizeProjectSyncError(response.error, response.status);
    }
    rows.push(
      ...((response.data ?? []) as unknown as RemoteSessionPreferenceRow[]),
    );
  }

  return rows.map((row) => mapRemotePreference(row, input.workspaceId));
};
