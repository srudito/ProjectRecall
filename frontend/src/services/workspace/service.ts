// Local workspace helper. Milestone 1: personal workspace only.
// We assume the Supabase auth trigger created a personal workspace whose id
// is deterministically retrievable by querying workspaces where owner = auth.uid().
// For local-only mode (no Supabase), we synthesize a stable local workspace id
// from the user id so local records still validate.

import * as Crypto from "expo-crypto";

import { getSupabase } from "@/src/services/supabase/client";

export interface PersonalWorkspace {
  id: string;
  name: string;
}

const LOCAL_NAMESPACE_KEY = "workspace";

export const resolvePersonalWorkspace = async (userId: string): Promise<PersonalWorkspace> => {
  const supabase = getSupabase();
  if (supabase) {
    const { data } = await supabase
      .from("workspaces")
      .select("id, name")
      .eq("owner_user_id", userId)
      .eq("workspace_type", "personal")
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      return { id: data.id, name: data.name };
    }
  }
  // Local-only fallback: derive a deterministic UUID from the user id.
  // Not cryptographically meaningful — it just needs to be stable.
  const seed = `${LOCAL_NAMESPACE_KEY}:${userId || "anonymous"}`;
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, seed);
  // Convert first 32 hex chars into a 4-4-4-4-12 UUID shape.
  const hex = digest.slice(0, 32).toLowerCase();
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return { id, name: "My workspace" };
};
