export type TranscriptionRequestErrorCode =
  | "TRANSCRIPTION_REQUEST_INVALID"
  | "TRANSCRIPTION_AUTHENTICATION_REQUIRED"
  | "TRANSCRIPTION_FEATURE_DISABLED"
  | "TRANSCRIPTION_RECORDING_NOT_FOUND"
  | "TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED"
  | "TRANSCRIPTION_SESSION_UNAVAILABLE"
  | "TRANSCRIPTION_LANGUAGE_UNSUPPORTED"
  | "TRANSCRIPTION_REQUEST_FAILED";

export class TranscriptionRequestError extends Error {
  readonly code: TranscriptionRequestErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: TranscriptionRequestErrorCode,
    message: string,
    options: { status: number; retryable?: boolean },
  ) {
    super(message);
    this.name = "TranscriptionRequestError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TranscriptionRequestBody {
  recordingId: string;
}

export interface TranscriptionRequestResult {
  jobId: string;
  status: string;
  workspaceId: string;
  sessionId: string;
  recordingId: string;
  created: boolean;
}

export const parseTranscriptionRequestBody = (
  value: unknown,
): TranscriptionRequestBody => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TranscriptionRequestError(
      "TRANSCRIPTION_REQUEST_INVALID",
      "Provide one synchronized recording to transcribe.",
      { status: 400 },
    );
  }

  const keys = Object.keys(value as Record<string, unknown>);
  const recordingId = (value as { recordingId?: unknown }).recordingId;
  if (
    keys.length !== 1 ||
    keys[0] !== "recordingId" ||
    typeof recordingId !== "string" ||
    recordingId.trim() !== recordingId ||
    !UUID_PATTERN.test(recordingId)
  ) {
    throw new TranscriptionRequestError(
      "TRANSCRIPTION_REQUEST_INVALID",
      "Provide one synchronized recording to transcribe.",
      { status: 400 },
    );
  }

  return { recordingId: recordingId.toLowerCase() };
};

const safeMessages: Readonly<
  Record<TranscriptionRequestErrorCode, string>
> = {
  TRANSCRIPTION_REQUEST_INVALID:
    "Provide one synchronized recording to transcribe.",
  TRANSCRIPTION_AUTHENTICATION_REQUIRED:
    "Sign in again before requesting a transcript.",
  TRANSCRIPTION_FEATURE_DISABLED:
    "Transcription is not available yet.",
  TRANSCRIPTION_RECORDING_NOT_FOUND:
    "The synchronized recording could not be found.",
  TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED:
    "Finish uploading the recording before requesting a transcript.",
  TRANSCRIPTION_SESSION_UNAVAILABLE:
    "This session is not available for transcription.",
  TRANSCRIPTION_LANGUAGE_UNSUPPORTED:
    "The selected language configuration is not supported yet.",
  TRANSCRIPTION_REQUEST_FAILED:
    "The transcription request could not be created. Try again later.",
};

interface RemoteErrorShape {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

export const normalizeTranscriptionRequestError = (
  error: unknown,
): TranscriptionRequestError => {
  if (error instanceof TranscriptionRequestError) return error;
  const shape = (error ?? {}) as RemoteErrorShape;
  const rawMessage = typeof shape.message === "string" ? shape.message : "";
  const rawCode = typeof shape.code === "string" ? shape.code : "";
  const status = typeof shape.status === "number" ? shape.status : null;

  const mappings: readonly [
    string,
    TranscriptionRequestErrorCode,
    number,
    boolean,
  ][] = [
    ["AUTHENTICATION_REQUIRED", "TRANSCRIPTION_AUTHENTICATION_REQUIRED", 401, true],
    ["TRANSCRIPTION_FEATURE_DISABLED", "TRANSCRIPTION_FEATURE_DISABLED", 403, false],
    ["TRANSCRIPTION_RECORDING_NOT_FOUND", "TRANSCRIPTION_RECORDING_NOT_FOUND", 404, false],
    ["TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED", "TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED", 409, true],
    ["TRANSCRIPTION_SESSION_UNAVAILABLE", "TRANSCRIPTION_SESSION_UNAVAILABLE", 409, false],
    ["TRANSCRIPTION_LANGUAGE_UNSUPPORTED", "TRANSCRIPTION_LANGUAGE_UNSUPPORTED", 400, false],
    ["TRANSCRIPTION_REQUEST_INVALID", "TRANSCRIPTION_REQUEST_INVALID", 400, false],
  ];

  for (const [marker, code, mappedStatus, retryable] of mappings) {
    if (rawMessage.includes(marker) || rawCode === marker) {
      return new TranscriptionRequestError(code, safeMessages[code], {
        status: mappedStatus,
        retryable,
      });
    }
  }

  if (status === 401 || rawCode === "PGRST301") {
    return new TranscriptionRequestError(
      "TRANSCRIPTION_AUTHENTICATION_REQUIRED",
      safeMessages.TRANSCRIPTION_AUTHENTICATION_REQUIRED,
      { status: 401, retryable: true },
    );
  }

  return new TranscriptionRequestError(
    "TRANSCRIPTION_REQUEST_FAILED",
    safeMessages.TRANSCRIPTION_REQUEST_FAILED,
    { status: 503, retryable: true },
  );
};

export const parseTranscriptionRequestResult = (
  value: unknown,
): TranscriptionRequestResult => {
  if (Array.isArray(value) && value.length !== 1) {
    throw normalizeTranscriptionRequestError(null);
  }
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw normalizeTranscriptionRequestError(null);
  }

  const candidate = row as Record<string, unknown>;
  const expectedKeys = [
    "created",
    "job_id",
    "job_status",
    "recording_id",
    "session_id",
    "workspace_id",
  ];
  const uuidFields = [
    "job_id",
    "workspace_id",
    "session_id",
    "recording_id",
  ] as const;
  if (
    Object.keys(candidate).sort().join(",") !== expectedKeys.join(",") ||
    uuidFields.some(
      (field) =>
        typeof candidate[field] !== "string" ||
        !UUID_PATTERN.test(candidate[field] as string),
    ) ||
    typeof candidate.job_status !== "string" ||
    !["queued", "leased", "processing", "succeeded", "failed", "cancelled"].includes(
      candidate.job_status,
    ) ||
    typeof candidate.created !== "boolean"
  ) {
    throw normalizeTranscriptionRequestError(null);
  }

  return {
    jobId: (candidate.job_id as string).toLowerCase(),
    status: candidate.job_status,
    workspaceId: (candidate.workspace_id as string).toLowerCase(),
    sessionId: (candidate.session_id as string).toLowerCase(),
    recordingId: (candidate.recording_id as string).toLowerCase(),
    created: candidate.created,
  };
};
