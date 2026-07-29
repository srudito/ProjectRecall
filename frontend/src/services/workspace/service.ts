// Personal workspace resolver. The real Supabase workspace id is cached so a
// previously authenticated native user can continue creating and reopening
// local data while offline without inventing an id that will later fail RLS.

import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";

import { getSupabase } from "@/src/services/supabase/client";
import { storage } from "@/src/utils/storage";

export interface PersonalWorkspace {
  id: string;
  name: string;
}

const LOCAL_NAMESPACE_KEY = "workspace";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const workspaceIdKey = (userId: string) => `workspace.personal.${userId}.id`;
const workspaceNameKey = (userId: string) => `workspace.personal.${userId}.name`;

const requireUserId = (userId: string): void => {
  if (!UUID_PATTERN.test(userId)) {
    throw new Error("An authenticated user id is required to resolve a workspace.");
  }
};

const readCachedWorkspace = async (
  userId: string,
): Promise<PersonalWorkspace | null> => {
  const id = await storage.getItem<string>(workspaceIdKey(userId), "");
  if (!id || !UUID_PATTERN.test(id)) return null;
  const name = await storage.getItem<string>(workspaceNameKey(userId), "My workspace");
  return { id, name: name || "My workspace" };
};

const cacheWorkspace = async (
  userId: string,
  workspace: PersonalWorkspace,
): Promise<void> => {
  await Promise.all([
    storage.setItem(workspaceIdKey(userId), workspace.id),
    storage.setItem(workspaceNameKey(userId), workspace.name),
  ]);
};

const isDefinitelyOffline = (state: {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}): boolean =>
  state.isConnected === false || state.isInternetReachable === false;

export const resolvePersonalWorkspace = async (
  userId: string,
): Promise<PersonalWorkspace> => {
  requireUserId(userId);

  const cached = await readCachedWorkspace(userId);
  const supabase = getSupabase();

  // A native cold start while offline must use the last verified workspace
  // immediately. Do not wait for a cloud request that cannot succeed.
  if (cached && supabase) {
    try {
      const connection = await NetInfo.fetch();
      if (isDefinitelyOffline(connection)) {
        return cached;
      }
    } catch {
      // Unknown connectivity: try the cloud below, then fall back to cache.
    }
  }

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("workspaces")
        .select("id, name")
        .eq("owner_user_id", userId)
        .eq("workspace_type", "personal")
        .limit(1)
        .maybeSingle();

      if (data?.id) {
        const workspace = { id: data.id, name: data.name };
        await cacheWorkspace(userId, workspace);
        return workspace;
      }

      if (cached) return cached;

      if (error) {
        throw new Error("The personal workspace could not be loaded from the cloud.");
      }

      throw new Error("No personal workspace exists for the signed-in user.");
    } catch (cause) {
      // supabase-js may reject on a low-level fetch failure instead of returning
      // an error object. The cached, previously verified workspace remains the
      // correct local scope while offline.
      if (cached) return cached;

      if (cause instanceof Error) throw cause;
      throw new Error("The personal workspace could not be loaded.");
    }
  }

  if (cached) return cached;

  // True local-only mode: derive a deterministic id from a valid user UUID.
  // This branch is never used when Supabase is configured.
  const seed = `${LOCAL_NAMESPACE_KEY}:${userId}`;
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    seed,
  );
  const hex = digest.slice(0, 32).toLowerCase();
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const workspace = { id, name: "My workspace" };
  await cacheWorkspace(userId, workspace);
  return workspace;
};
