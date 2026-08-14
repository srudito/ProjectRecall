import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/src/config/env";
import { getSupabase } from "@/src/services/supabase/client";
import { storage } from "@/src/utils/storage";

const cacheKey = `transcription.feature.enabled.v1:${env.appEnv}`;
const memoryTtlMs = 60_000;

let memoryValue: boolean | null = null;
let memoryUpdatedAt = 0;

const readCached = async (): Promise<boolean> => {
  if (memoryValue !== null) return memoryValue;
  const cached = await storage.getItem<boolean>(cacheKey, false);
  memoryValue = cached === true;
  memoryUpdatedAt = Date.now();
  return memoryValue;
};

export const resolveTranscriptionFeatureEnabled = async (
  clientOverride?: SupabaseClient,
): Promise<boolean> => {
  const now = Date.now();
  if (memoryValue !== null && now - memoryUpdatedAt < memoryTtlMs) {
    return memoryValue;
  }

  const client = clientOverride ?? getSupabase();
  if (!client) return readCached();

  try {
    const response = await client
      .from("feature_flags")
      .select("enabled")
      .eq("flag_key", "transcription_enabled")
      .maybeSingle();

    if (response.error || !response.data) {
      return readCached();
    }

    const enabled = response.data.enabled === true;
    memoryValue = enabled;
    memoryUpdatedAt = now;
    await storage.setItem(cacheKey, enabled);
    return enabled;
  } catch {
    return readCached();
  }
};

export const __resetTranscriptionFeatureCacheForTests = (): void => {
  memoryValue = null;
  memoryUpdatedAt = 0;
};
