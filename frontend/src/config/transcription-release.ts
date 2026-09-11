import { env } from "./env";

/**
 * Source-controlled production mutation lock.
 *
 * C2G.1 deliberately keeps this false. A later, separately reviewed rollout
 * checkpoint may change it only after production database, Edge Function,
 * worker/Cron, feature-flag, and cleanup-state verification has passed.
 * Within the validated production profile, environment values cannot override
 * this source lock to activate provider spend or transcript-edit writes.
 */
export const TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED = false;

/**
 * Development, preview, and the Jest test environment retain the already-tested
 * workflow. Unknown or misspelled environments fail closed rather than
 * inheriting development behavior. Production requires the approval above.
 */
export const isTranscriptionMutationReleasedForEnvironment = (
  appEnv: unknown,
): boolean => {
  const normalized =
    typeof appEnv === "string" ? appEnv.trim().toLowerCase() : "";
  if (
    normalized === "development" ||
    normalized === "preview" ||
    normalized === "test"
  ) {
    return true;
  }
  if (normalized === "production") {
    return TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED;
  }
  return false;
};

export const isTranscriptionMutationReleased = (): boolean => {
  if (process.env.NODE_ENV === "test") return true;
  return isTranscriptionMutationReleasedForEnvironment(env.appEnv);
};
