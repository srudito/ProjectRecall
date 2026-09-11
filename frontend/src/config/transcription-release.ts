import { env } from "./env";

/**
 * Source-controlled production mutation approval.
 *
 * C2G.3 Gate C opens only the reviewed source approval key after the contained
 * backend deployment provenance gate completed. This does not enable production
 * transcription on its own: public.feature_flags.transcription_enabled remains
 * the independent server admission key and stays disabled until a later gate.
 */
export const TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED = true;
export const TRANSCRIPTION_PRODUCTION_ROLLOUT_APPROVAL_ID =
  "C2G3_GATE_C_SOURCE_APPROVAL_V1";
export const TRANSCRIPTION_PRODUCTION_BACKEND_DEPLOYMENT_GATE_ID =
  "C2G3_GATE_B_BACKEND_DEPLOYMENT_PROVENANCE";
export const TRANSCRIPTION_PRODUCTION_BACKEND_METADATA_FINGERPRINT =
  "ef25db51bd709f5be586e67ce775490cd29a48b3a37f90c441ea1e44b110500f";

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
