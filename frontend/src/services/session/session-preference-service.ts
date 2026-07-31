import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

import {
  atomicUpsertSessionUserPreferenceWithSync,
  deleteMetadataOperationsForEntity,
  getSessionUserPreference,
  listSessionUserPreferences,
  upsertSessionUserPreference,
  type SessionUserPreferenceRecord,
} from "@/src/services/sqlite/repository";
import {
  fetchRemoteSessionPreferences,
  upsertRemoteSessionPreference,
} from "@/src/services/supabase/session-preference-repository";
import { notifyMetadataSyncChanges } from "@/src/services/sync/project-sync-events";
import { requestMetadataSync } from "@/src/services/sync/project-sync-worker";
import { buildIdempotencyKey } from "@/src/services/upload-queue/backoff";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requireUuid = (value: string, fieldName: string): void => {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a valid UUID.`);
  }
};

export const sessionPreferenceId = (
  userId: string,
  sessionId: string,
): string => `session-preference:${userId}:${sessionId}`;

const preferenceContentMatches = (
  left: SessionUserPreferenceRecord,
  right: SessionUserPreferenceRecord,
): boolean =>
  left.user_id === right.user_id &&
  left.session_id === right.session_id &&
  left.is_starred === right.is_starred;

const timestampMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const mergeRemoteSessionPreferencesIntoLocal = async (
  remotePreferences: SessionUserPreferenceRecord[],
): Promise<boolean> => {
  let changed = false;

  for (const remote of remotePreferences) {
    const local = await getSessionUserPreference(
      remote.user_id,
      remote.session_id,
    );

    if (!local) {
      await upsertSessionUserPreference(remote);
      changed = true;
      continue;
    }

    const localPending =
      local.local_sync_status !== "synchronized" ||
      local.cloud_sync_status !== "synchronized";
    const remoteAtLeastAsNew =
      timestampMs(remote.updated_at) >= timestampMs(local.updated_at);

    if (localPending) {
      if (!preferenceContentMatches(local, remote) && !remoteAtLeastAsNew) {
        continue;
      }

      await upsertSessionUserPreference({
        ...remote,
        local_sync_status: "synchronized",
        cloud_sync_status: "synchronized",
        last_sync_error_code: null,
        last_sync_error_message: null,
        last_synced_at: new Date().toISOString(),
      });
      await deleteMetadataOperationsForEntity(
        "session_preference",
        local.id,
      );
      changed = true;
      continue;
    }

    const remoteNewer =
      timestampMs(remote.updated_at) > timestampMs(local.updated_at);
    if (remoteNewer || !preferenceContentMatches(local, remote)) {
      await upsertSessionUserPreference(remote);
      changed = true;
    }
  }

  return changed;
};

const refreshNativePreferencesFromCloud = async (input: {
  userId: string;
  workspaceId: string;
  sessionIds: string[];
}): Promise<void> => {
  try {
    const remote = await fetchRemoteSessionPreferences(input);
    const changed = await mergeRemoteSessionPreferencesIntoLocal(remote);
    if (changed) notifyMetadataSyncChanges();
  } finally {
    requestMetadataSync();
  }
};

export const fetchSessionUserPreferences = async (input: {
  userId: string;
  workspaceId: string;
  sessionIds: string[];
}): Promise<SessionUserPreferenceRecord[]> => {
  requireUuid(input.userId, "userId");
  requireUuid(input.workspaceId, "workspaceId");
  input.sessionIds.forEach((sessionId) => requireUuid(sessionId, "sessionId"));

  if (Platform.OS === "web") {
    return fetchRemoteSessionPreferences(input);
  }

  const local = await listSessionUserPreferences(
    input.userId,
    input.workspaceId,
  );
  void refreshNativePreferencesFromCloud(input).catch(() => {
    // Local preferences remain available while offline. Pending changes stay
    // in the durable metadata queue and retry on the next lifecycle trigger.
  });
  return local;
};

export const setSessionStarred = async (input: {
  userId: string;
  workspaceId: string;
  sessionId: string;
  isStarred: boolean;
}): Promise<SessionUserPreferenceRecord> => {
  requireUuid(input.userId, "userId");
  requireUuid(input.workspaceId, "workspaceId");
  requireUuid(input.sessionId, "sessionId");

  const existing =
    Platform.OS === "web"
      ? null
      : await getSessionUserPreference(input.userId, input.sessionId);
  const now = new Date().toISOString();
  const preference: SessionUserPreferenceRecord = {
    id: sessionPreferenceId(input.userId, input.sessionId),
    user_id: input.userId,
    workspace_id: input.workspaceId,
    session_id: input.sessionId,
    is_starred: input.isStarred,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    local_sync_status: Platform.OS === "web" ? "synchronizing" : "pending",
    cloud_sync_status: "pending",
    last_sync_error_code: null,
    last_sync_error_message: null,
    last_synced_at: existing?.last_synced_at ?? null,
  };

  if (Platform.OS === "web") {
    return upsertRemoteSessionPreference(preference);
  }

  await atomicUpsertSessionUserPreferenceWithSync({
    preference,
    queueRowId: Crypto.randomUUID(),
    idempotencyKey: buildIdempotencyKey([
      "upsert",
      "session_preference",
      input.userId,
      input.sessionId,
    ]),
  });
  notifyMetadataSyncChanges();
  requestMetadataSync();
  return preference;
};
