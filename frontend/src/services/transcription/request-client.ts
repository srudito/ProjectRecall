import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabase } from "@/src/services/supabase/client";

export type TranscriptionRequestClientErrorCode =
  | "SUPABASE_NOT_CONFIGURED"
  | "TRANSCRIPTION_AUTHENTICATION_REQUIRED"
  | "TRANSCRIPTION_FEATURE_DISABLED"
  | "TRANSCRIPTION_RECORDING_NOT_FOUND"
  | "TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED"
  | "TRANSCRIPTION_SESSION_UNAVAILABLE"
  | "TRANSCRIPTION_LANGUAGE_UNSUPPORTED"
  | "TRANSCRIPTION_REQUEST_INVALID"
  | "TRANSCRIPTION_REQUEST_FAILED"
  | "TRANSCRIPTION_RESPONSE_INVALID"
  | "NETWORK_UNAVAILABLE";

export class TranscriptionRequestClientError extends Error {
  readonly code: TranscriptionRequestClientErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly cause?: unknown;

  constructor(
    code: TranscriptionRequestClientErrorCode,
    message: string,
    options: {
      retryable: boolean;
      status?: number | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "TranscriptionRequestClientError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.cause = options.cause;
  }
}

export interface RemoteTranscriptionRequestResult {
  jobId: string;
  status: "queued" | "leased" | "processing" | "succeeded" | "failed" | "cancelled";
  workspaceId: string;
  sessionId: string;
  recordingId: string;
  created: boolean;
  requestId: string;
}

interface FunctionErrorPayload {
  error?: {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    requestId?: unknown;
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const safeMessages: Readonly<Record<TranscriptionRequestClientErrorCode, string>> = {
  SUPABASE_NOT_CONFIGURED: "Cloud transcription is not configured.",
  TRANSCRIPTION_AUTHENTICATION_REQUIRED:
    "Sign in again before requesting a transcript.",
  TRANSCRIPTION_FEATURE_DISABLED: "Transcription is temporarily unavailable.",
  TRANSCRIPTION_RECORDING_NOT_FOUND:
    "The synchronized recording could not be found.",
  TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED:
    "Finish uploading the recording before requesting a transcript.",
  TRANSCRIPTION_SESSION_UNAVAILABLE:
    "This session is not available for transcription.",
  TRANSCRIPTION_LANGUAGE_UNSUPPORTED:
    "The selected language configuration is not supported yet.",
  TRANSCRIPTION_REQUEST_INVALID:
    "The transcription request is not valid.",
  TRANSCRIPTION_REQUEST_FAILED:
    "The transcription request could not be created. It will retry automatically.",
  TRANSCRIPTION_RESPONSE_INVALID:
    "The transcription service returned an invalid response.",
  NETWORK_UNAVAILABLE:
    "The transcription request is saved locally and will retry when the network is available.",
};

const knownServerCodes = new Set<TranscriptionRequestClientErrorCode>([
  "TRANSCRIPTION_AUTHENTICATION_REQUIRED",
  "TRANSCRIPTION_FEATURE_DISABLED",
  "TRANSCRIPTION_RECORDING_NOT_FOUND",
  "TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED",
  "TRANSCRIPTION_SESSION_UNAVAILABLE",
  "TRANSCRIPTION_LANGUAGE_UNSUPPORTED",
  "TRANSCRIPTION_REQUEST_INVALID",
  "TRANSCRIPTION_REQUEST_FAILED",
]);

const readFunctionErrorPayload = async (
  error: unknown,
): Promise<{ payload: FunctionErrorPayload | null; status: number | null }> => {
  if (!error || typeof error !== "object") {
    return { payload: null, status: null };
  }

  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== "object") {
    return { payload: null, status: null };
  }

  const response = context as {
    status?: unknown;
    clone?: () => { json?: () => Promise<unknown> };
    json?: () => Promise<unknown>;
  };
  const status = typeof response.status === "number" ? response.status : null;

  try {
    const readable = response.clone?.() ?? response;
    if (typeof readable.json !== "function") {
      return { payload: null, status };
    }
    const value = await readable.json();
    return {
      payload:
        value && typeof value === "object"
          ? (value as FunctionErrorPayload)
          : null,
      status,
    };
  } catch {
    return { payload: null, status };
  }
};

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

export const normalizeTranscriptionRequestClientError = async (
  error: unknown,
): Promise<TranscriptionRequestClientError> => {
  if (error instanceof TranscriptionRequestClientError) return error;
  if (looksLikeNetworkFailure(error)) {
    return new TranscriptionRequestClientError(
      "NETWORK_UNAVAILABLE",
      safeMessages.NETWORK_UNAVAILABLE,
      { retryable: true, cause: error },
    );
  }

  const { payload, status } = await readFunctionErrorPayload(error);
  const rawCode = payload?.error?.code;
  if (
    typeof rawCode === "string" &&
    knownServerCodes.has(rawCode as TranscriptionRequestClientErrorCode)
  ) {
    const code = rawCode as TranscriptionRequestClientErrorCode;
    const defaultRetryable =
      code === "TRANSCRIPTION_AUTHENTICATION_REQUIRED" ||
      code === "TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED" ||
      code === "TRANSCRIPTION_REQUEST_FAILED";
    return new TranscriptionRequestClientError(code, safeMessages[code], {
      retryable:
        typeof payload?.error?.retryable === "boolean"
          ? payload.error.retryable
          : defaultRetryable,
      status,
      cause: error,
    });
  }

  if (status === 401) {
    return new TranscriptionRequestClientError(
      "TRANSCRIPTION_AUTHENTICATION_REQUIRED",
      safeMessages.TRANSCRIPTION_AUTHENTICATION_REQUIRED,
      { retryable: true, status, cause: error },
    );
  }

  return new TranscriptionRequestClientError(
    "TRANSCRIPTION_REQUEST_FAILED",
    safeMessages.TRANSCRIPTION_REQUEST_FAILED,
    { retryable: true, status, cause: error },
  );
};

const parseRemoteResult = (value: unknown): RemoteTranscriptionRequestResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TranscriptionRequestClientError(
      "TRANSCRIPTION_RESPONSE_INVALID",
      safeMessages.TRANSCRIPTION_RESPONSE_INVALID,
      { retryable: true },
    );
  }

  const candidate = value as Record<string, unknown>;
  const statuses = new Set([
    "queued",
    "leased",
    "processing",
    "succeeded",
    "failed",
    "cancelled",
  ]);
  const uuidFields = ["jobId", "workspaceId", "sessionId", "recordingId"] as const;

  if (
    uuidFields.some(
      (field) =>
        typeof candidate[field] !== "string" ||
        !UUID_PATTERN.test(candidate[field] as string),
    ) ||
    typeof candidate.status !== "string" ||
    !statuses.has(candidate.status) ||
    typeof candidate.created !== "boolean" ||
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length === 0
  ) {
    throw new TranscriptionRequestClientError(
      "TRANSCRIPTION_RESPONSE_INVALID",
      safeMessages.TRANSCRIPTION_RESPONSE_INVALID,
      { retryable: true },
    );
  }

  return {
    jobId: (candidate.jobId as string).toLowerCase(),
    status: candidate.status as RemoteTranscriptionRequestResult["status"],
    workspaceId: (candidate.workspaceId as string).toLowerCase(),
    sessionId: (candidate.sessionId as string).toLowerCase(),
    recordingId: (candidate.recordingId as string).toLowerCase(),
    created: candidate.created,
    requestId: candidate.requestId,
  };
};

export const invokeRemoteTranscriptionRequest = async (
  input: {
    recordingId: string;
    expectedUserId: string;
  },
  clientOverride?: SupabaseClient,
): Promise<RemoteTranscriptionRequestResult> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new TranscriptionRequestClientError(
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
    throw new TranscriptionRequestClientError(
      "TRANSCRIPTION_AUTHENTICATION_REQUIRED",
      safeMessages.TRANSCRIPTION_AUTHENTICATION_REQUIRED,
      { retryable: true, status: 401, cause: sessionResponse.error },
    );
  }

  const response = await client.functions.invoke("transcription-request", {
    body: { recordingId: input.recordingId },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (response.error) {
    throw await normalizeTranscriptionRequestClientError(response.error);
  }

  return parseRemoteResult(response.data);
};
