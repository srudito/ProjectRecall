import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

import { UploadStatus } from "@/src/domain/enums";
import { recordingSchema, sessionSchema } from "@/src/domain/models";
import {
  getTranscriptionRequestByIdempotencyKey,
  upsertTranscriptionRequestIntent,
  type RecordingRecord,
  type SessionRecord,
  type TranscriptionRequestQueueRow,
} from "@/src/services/sqlite/repository";
import { requestTranscriptionRequestSync } from "@/src/services/sync/transcription-request-worker";
import { notifyTranscriptionSyncChanges } from "@/src/services/sync/transcription-sync-events";

import {
  prepareTranscriptionRequest,
  type PreparedTranscriptionRequest,
  type TranscriptionRequestErrorCode,
} from "./contracts";

export class LocalTranscriptionRequestError extends Error {
  readonly code: TranscriptionRequestErrorCode | "TRANSCRIPTION_LOCAL_STATE_INVALID";

  constructor(
    code: TranscriptionRequestErrorCode | "TRANSCRIPTION_LOCAL_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LocalTranscriptionRequestError";
    this.code = code;
  }
}

export const prepareLocalTranscriptionRequest = (input: {
  session: SessionRecord;
  recording: RecordingRecord;
}): PreparedTranscriptionRequest => {
  const parsedSession = sessionSchema.safeParse(input.session);
  const parsedRecording = recordingSchema.safeParse(input.recording);
  if (!parsedSession.success || !parsedRecording.success) {
    throw new LocalTranscriptionRequestError(
      "TRANSCRIPTION_LOCAL_STATE_INVALID",
      "The local recording metadata is not valid for transcription.",
    );
  }

  if (
    !Number.isSafeInteger(parsedRecording.data.duration_ms) ||
    parsedRecording.data.duration_ms <= 0 ||
    !/^(audio|video)\/[A-Za-z0-9.+-]+$/.test(parsedRecording.data.mime_type)
  ) {
    throw new LocalTranscriptionRequestError(
      "TRANSCRIPTION_LOCAL_STATE_INVALID",
      "The local recording media metadata is not valid for transcription.",
    );
  }

  if (
    parsedRecording.data.upload_status === UploadStatus.FAILED ||
    parsedRecording.data.upload_status === UploadStatus.CANCELLED
  ) {
    throw new LocalTranscriptionRequestError(
      "TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED",
      "Retry the recording upload before requesting transcription.",
    );
  }

  // Queue intent is local-first: native recordings already have their canonical
  // private Storage object path before upload. Reuse the provider-neutral
  // contract validation while deferring the actual synchronized-state gate to
  // the background request worker. The server repeats that gate under RLS.
  const validationRecording =
    parsedRecording.data.upload_status === UploadStatus.SYNCHRONIZED
      ? parsedRecording.data
      : {
          ...parsedRecording.data,
          upload_status: UploadStatus.SYNCHRONIZED,
        };

  const prepared = prepareTranscriptionRequest({
    session: parsedSession.data,
    recording: validationRecording,
  });
  if (!prepared.ok) {
    throw new LocalTranscriptionRequestError(prepared.code, prepared.reason);
  }
  return prepared.value;
};

const buildQueueRow = (input: {
  prepared: PreparedTranscriptionRequest;
  userId: string;
  now: string;
  id: string;
}): TranscriptionRequestQueueRow => ({
  id: input.id,
  user_id: input.userId,
  workspace_id: input.prepared.workspaceId,
  session_id: input.prepared.sessionId,
  recording_id: input.prepared.recordingId,
  spoken_language_mode: input.prepared.spokenLanguageMode,
  expected_spoken_languages: input.prepared.expectedSpokenLanguages,
  queue_status: "pending",
  attempt_count: 0,
  max_attempts: 5,
  next_retry_at: null,
  server_job_id: null,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: input.prepared.idempotencyKey,
  created_at: input.now,
  updated_at: input.now,
});

export const buildTranscriptionRequestQueueRow = buildQueueRow;

export const queueRecordingTranscription = async (input: {
  session: SessionRecord;
  recording: RecordingRecord;
  userId: string;
}): Promise<TranscriptionRequestQueueRow> => {
  if (Platform.OS === "web") {
    throw new LocalTranscriptionRequestError(
      "TRANSCRIPTION_LOCAL_STATE_INVALID",
      "Mobile transcription queueing is not available on web.",
    );
  }

  const prepared = prepareLocalTranscriptionRequest(input);
  const now = new Date().toISOString();
  const saved = await upsertTranscriptionRequestIntent(
    buildQueueRow({
      prepared,
      userId: input.userId,
      now,
      id: Crypto.randomUUID(),
    }),
  );

  notifyTranscriptionSyncChanges();
  requestTranscriptionRequestSync();
  return saved;
};

export const getRecordingTranscriptionRequest = async (input: {
  session: SessionRecord;
  recording: RecordingRecord;
  userId: string;
}): Promise<TranscriptionRequestQueueRow | null> => {
  if (Platform.OS === "web") return null;

  let prepared: PreparedTranscriptionRequest;
  try {
    prepared = prepareLocalTranscriptionRequest(input);
  } catch {
    return null;
  }

  return getTranscriptionRequestByIdempotencyKey(
    input.userId,
    prepared.workspaceId,
    prepared.idempotencyKey,
  );
};
