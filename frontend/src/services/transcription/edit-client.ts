import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabase } from "@/src/services/supabase/client";

export type TranscriptEditClientErrorCode =
  | "SUPABASE_NOT_CONFIGURED"
  | "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED"
  | "TRANSCRIPT_EDIT_FEATURE_DISABLED"
  | "TRANSCRIPT_EDIT_SESSION_UNAVAILABLE"
  | "TRANSCRIPT_EDIT_FORBIDDEN"
  | "TRANSCRIPT_EDIT_CURRENT_VERSION_UNAVAILABLE"
  | "TRANSCRIPT_EDIT_IDEMPOTENCY_CONFLICT"
  | "TRANSCRIPT_EDIT_BASE_CONFLICT"
  | "TRANSCRIPT_EDIT_UNCHANGED"
  | "TRANSCRIPT_EDIT_INPUT_INVALID"
  | "TRANSCRIPT_EDIT_CURRENT_VERSION_CONFLICT"
  | "TRANSCRIPT_EDIT_REQUEST_FAILED"
  | "TRANSCRIPT_EDIT_RESPONSE_INVALID"
  | "NETWORK_UNAVAILABLE";

export class TranscriptEditClientError extends Error {
  readonly code: TranscriptEditClientErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: TranscriptEditClientErrorCode,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message);
    this.name = "TranscriptEditClientError";
    this.code = code;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

export interface RemoteTranscriptEditResult {
  transcriptVersionId: string;
  versionNumber: number;
  currentVersionId: string;
  wasCreated: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const safeMessages: Readonly<Record<TranscriptEditClientErrorCode, string>> = {
  SUPABASE_NOT_CONFIGURED: "Cloud transcript editing is not configured.",
  TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED:
    "Sign in again before synchronizing transcript edits.",
  TRANSCRIPT_EDIT_FEATURE_DISABLED:
    "Transcript editing is temporarily unavailable.",
  TRANSCRIPT_EDIT_SESSION_UNAVAILABLE:
    "This session is no longer available for transcript editing.",
  TRANSCRIPT_EDIT_FORBIDDEN:
    "You no longer have permission to edit this transcript.",
  TRANSCRIPT_EDIT_CURRENT_VERSION_UNAVAILABLE:
    "The current transcript version is not available for editing.",
  TRANSCRIPT_EDIT_IDEMPOTENCY_CONFLICT:
    "This saved edit identifier conflicts with another transcript version.",
  TRANSCRIPT_EDIT_BASE_CONFLICT:
    "The transcript changed elsewhere before this edit could be saved.",
  TRANSCRIPT_EDIT_UNCHANGED:
    "The edited transcript is unchanged from the current version.",
  TRANSCRIPT_EDIT_INPUT_INVALID:
    "The transcript edit is not valid.",
  TRANSCRIPT_EDIT_CURRENT_VERSION_CONFLICT:
    "The transcript changed while this edit was being synchronized.",
  TRANSCRIPT_EDIT_REQUEST_FAILED:
    "The transcript edit could not be synchronized yet.",
  TRANSCRIPT_EDIT_RESPONSE_INVALID:
    "The transcript edit service returned an invalid response.",
  NETWORK_UNAVAILABLE:
    "The transcript edit is saved locally and will retry when the network is available.",
};

const knownServerCodes = new Set<TranscriptEditClientErrorCode>([
  "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED",
  "TRANSCRIPT_EDIT_FEATURE_DISABLED",
  "TRANSCRIPT_EDIT_SESSION_UNAVAILABLE",
  "TRANSCRIPT_EDIT_FORBIDDEN",
  "TRANSCRIPT_EDIT_CURRENT_VERSION_UNAVAILABLE",
  "TRANSCRIPT_EDIT_IDEMPOTENCY_CONFLICT",
  "TRANSCRIPT_EDIT_BASE_CONFLICT",
  "TRANSCRIPT_EDIT_UNCHANGED",
  "TRANSCRIPT_EDIT_INPUT_INVALID",
  "TRANSCRIPT_EDIT_CURRENT_VERSION_CONFLICT",
]);

const retryableServerCodes = new Set<TranscriptEditClientErrorCode>([
  "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED",
  "TRANSCRIPT_EDIT_CURRENT_VERSION_CONFLICT",
]);

const looksLikeNetworkFailure = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "").toLowerCase()
      : String(error ?? "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("network request failed") ||
    message.includes("networkerror") ||
    message.includes("timeout")
  );
};

const knownMarkerFromError = (
  error: unknown,
): TranscriptEditClientErrorCode | null => {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  for (const value of [candidate.message, candidate.details, candidate.hint]) {
    if (
      typeof value === "string" &&
      knownServerCodes.has(value.trim() as TranscriptEditClientErrorCode)
    ) {
      return value.trim() as TranscriptEditClientErrorCode;
    }
  }
  return null;
};

export const normalizeTranscriptEditClientError = (
  error: unknown,
): TranscriptEditClientError => {
  if (error instanceof TranscriptEditClientError) return error;

  if (looksLikeNetworkFailure(error)) {
    return new TranscriptEditClientError(
      "NETWORK_UNAVAILABLE",
      safeMessages.NETWORK_UNAVAILABLE,
      { retryable: true, cause: error },
    );
  }

  const serverCode = knownMarkerFromError(error);
  if (serverCode) {
    return new TranscriptEditClientError(
      serverCode,
      safeMessages[serverCode],
      {
        retryable: retryableServerCodes.has(serverCode),
        cause: error,
      },
    );
  }

  return new TranscriptEditClientError(
    "TRANSCRIPT_EDIT_REQUEST_FAILED",
    safeMessages.TRANSCRIPT_EDIT_REQUEST_FAILED,
    { retryable: true, cause: error },
  );
};

const parseUuid = (value: unknown): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_RESPONSE_INVALID",
      safeMessages.TRANSCRIPT_EDIT_RESPONSE_INVALID,
      { retryable: true },
    );
  }
  return value.toLowerCase();
};

const parseRemoteResult = (value: unknown): RemoteTranscriptEditResult => {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_RESPONSE_INVALID",
      safeMessages.TRANSCRIPT_EDIT_RESPONSE_INVALID,
      { retryable: true },
    );
  }

  const row = value[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_RESPONSE_INVALID",
      safeMessages.TRANSCRIPT_EDIT_RESPONSE_INVALID,
      { retryable: true },
    );
  }

  const candidate = row as Record<string, unknown>;
  const versionNumber = candidate.version_number;
  if (!Number.isSafeInteger(versionNumber) || (versionNumber as number) < 1) {
    throw new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_RESPONSE_INVALID",
      safeMessages.TRANSCRIPT_EDIT_RESPONSE_INVALID,
      { retryable: true },
    );
  }
  if (typeof candidate.was_created !== "boolean") {
    throw new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_RESPONSE_INVALID",
      safeMessages.TRANSCRIPT_EDIT_RESPONSE_INVALID,
      { retryable: true },
    );
  }

  return {
    transcriptVersionId: parseUuid(candidate.transcript_version_id),
    versionNumber: versionNumber as number,
    currentVersionId: parseUuid(candidate.current_version_id),
    wasCreated: candidate.was_created,
  };
};

export const invokeRemoteTranscriptEdit = async (
  input: {
    sessionId: string;
    expectedCurrentVersionId: string;
    clientVersionId: string;
    plainText: string;
    expectedUserId: string;
  },
  clientOverride?: SupabaseClient,
): Promise<RemoteTranscriptEditResult> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new TranscriptEditClientError(
      "SUPABASE_NOT_CONFIGURED",
      safeMessages.SUPABASE_NOT_CONFIGURED,
      { retryable: false },
    );
  }

  const sessionResponse = await client.auth.getSession();
  const session = sessionResponse.data.session;
  if (
    sessionResponse.error ||
    !session?.access_token ||
    session.user.id !== input.expectedUserId
  ) {
    throw new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED",
      safeMessages.TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED,
      { retryable: true, cause: sessionResponse.error },
    );
  }

  const response = await client.rpc("create_transcript_user_edit_version_v1", {
    p_session_id: input.sessionId,
    p_expected_current_version_id: input.expectedCurrentVersionId,
    p_client_version_id: input.clientVersionId,
    p_plain_text: input.plainText,
  });

  if (response.error) {
    throw normalizeTranscriptEditClientError(response.error);
  }

  const result = parseRemoteResult(response.data);
  if (result.transcriptVersionId !== input.clientVersionId.toLowerCase()) {
    throw new TranscriptEditClientError(
      "TRANSCRIPT_EDIT_RESPONSE_INVALID",
      safeMessages.TRANSCRIPT_EDIT_RESPONSE_INVALID,
      { retryable: true },
    );
  }

  return result;
};
