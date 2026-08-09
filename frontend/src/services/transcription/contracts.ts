/* eslint-disable @typescript-eslint/no-redeclare -- Intentional const/type pair provides runtime error codes and the matching TypeScript union. */
import {
  SessionStatus,
  SpokenLanguageMode,
  UploadStatus,
} from "@/src/domain/enums";
import type { Recording, Session } from "@/src/domain/models";
import { validateSpokenLanguageSelection } from "@/src/services/language/precedence";

export const TRANSCRIPTION_REQUEST_CONTRACT_VERSION = 1 as const;
export const TRANSCRIPTION_JOB_TYPE = "batch_transcription" as const;

export const TranscriptionRequestErrorCode = {
  SCOPE_MISMATCH: "TRANSCRIPTION_SCOPE_MISMATCH",
  SESSION_UNAVAILABLE: "TRANSCRIPTION_SESSION_UNAVAILABLE",
  RECORDING_NOT_SYNCHRONIZED: "TRANSCRIPTION_RECORDING_NOT_SYNCHRONIZED",
  STORAGE_PATH_MISSING: "TRANSCRIPTION_STORAGE_PATH_MISSING",
  STORAGE_SCOPE_MISMATCH: "TRANSCRIPTION_STORAGE_SCOPE_MISMATCH",
  LANGUAGE_CODE_INVALID: "TRANSCRIPTION_LANGUAGE_CODE_INVALID",
  LANGUAGE_SELECTION_INVALID: "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID",
} as const;

export type TranscriptionRequestErrorCode =
  (typeof TranscriptionRequestErrorCode)[keyof typeof TranscriptionRequestErrorCode];

export interface PreparedTranscriptionRequest {
  contractVersion: typeof TRANSCRIPTION_REQUEST_CONTRACT_VERSION;
  jobType: typeof TRANSCRIPTION_JOB_TYPE;
  workspaceId: string;
  sessionId: string;
  recordingId: string;
  privateStoragePath: string;
  spokenLanguageMode: SpokenLanguageMode;
  expectedSpokenLanguages: string[];
  idempotencyKey: string;
}

export type PrepareTranscriptionRequestResult =
  | { ok: true; value: PreparedTranscriptionRequest }
  | {
      ok: false;
      code: TranscriptionRequestErrorCode;
      reason: string;
    };

const languageCodePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

export const normalizeTranscriptionLanguageCodes = (
  values: readonly string[],
): string[] => {
  const normalized = values
    .map((value) => value.trim().replace(/_/g, "-").toLowerCase())
    .filter(Boolean);

  return [...new Set(normalized)].sort();
};

export const buildTranscriptionIdempotencyKey = (input: {
  workspaceId: string;
  sessionId: string;
  recordingId: string;
  spokenLanguageMode: SpokenLanguageMode;
  expectedSpokenLanguages: readonly string[];
}): string => {
  const normalizedLanguages = normalizeTranscriptionLanguageCodes(
    input.expectedSpokenLanguages,
  );
  const languageFingerprint =
    normalizedLanguages.length > 0 ? normalizedLanguages.join(",") : "auto";

  return [
    "batch-transcription",
    `v${TRANSCRIPTION_REQUEST_CONTRACT_VERSION}`,
    input.workspaceId,
    input.sessionId,
    input.recordingId,
    input.spokenLanguageMode,
    languageFingerprint,
  ].join(":");
};

const errorResult = (
  code: TranscriptionRequestErrorCode,
  reason: string,
): PrepareTranscriptionRequestResult => ({ ok: false, code, reason });

export const prepareTranscriptionRequest = (input: {
  session: Session;
  recording: Recording;
}): PrepareTranscriptionRequestResult => {
  const { session, recording } = input;

  if (
    session.id !== recording.session_id ||
    session.workspace_id !== recording.workspace_id
  ) {
    return errorResult(
      TranscriptionRequestErrorCode.SCOPE_MISMATCH,
      "The recording does not belong to the selected session workspace.",
    );
  }

  if (
    session.deleted_at !== null ||
    session.status === SessionStatus.DELETING ||
    session.status === SessionStatus.DELETED
  ) {
    return errorResult(
      TranscriptionRequestErrorCode.SESSION_UNAVAILABLE,
      "The session is being deleted or is no longer available.",
    );
  }

  if (recording.upload_status !== UploadStatus.SYNCHRONIZED) {
    return errorResult(
      TranscriptionRequestErrorCode.RECORDING_NOT_SYNCHRONIZED,
      "The recording must finish private Storage synchronization first.",
    );
  }

  const privateStoragePath = recording.private_storage_path ?? "";
  if (!privateStoragePath.trim()) {
    return errorResult(
      TranscriptionRequestErrorCode.STORAGE_PATH_MISSING,
      "The synchronized recording has no private Storage path.",
    );
  }

  if (privateStoragePath.trim() !== privateStoragePath) {
    return errorResult(
      TranscriptionRequestErrorCode.STORAGE_SCOPE_MISMATCH,
      "The private Storage path must not contain edge whitespace.",
    );
  }

  const expectedScopeSegments = [
    session.workspace_id,
    session.id,
    recording.id,
  ];
  const storagePathSegments = privateStoragePath.split("/");
  const objectPathSegments = storagePathSegments.slice(
    expectedScopeSegments.length,
  );
  const hasExpectedScope = expectedScopeSegments.every(
    (segment, index) => storagePathSegments[index] === segment,
  );
  const hasCanonicalObjectPath =
    objectPathSegments.length > 0 &&
    objectPathSegments.every(
      (segment) =>
        segment.length > 0 &&
        segment.trim() === segment &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\") &&
        !segment.includes("\0"),
    );

  if (!hasExpectedScope || !hasCanonicalObjectPath) {
    return errorResult(
      TranscriptionRequestErrorCode.STORAGE_SCOPE_MISMATCH,
      "The private Storage path is not a canonical object key for the recording scope.",
    );
  }

  const expectedSpokenLanguages = normalizeTranscriptionLanguageCodes(
    session.expected_spoken_languages,
  );

  if (
    expectedSpokenLanguages.some(
      (languageCode) => !languageCodePattern.test(languageCode),
    )
  ) {
    return errorResult(
      TranscriptionRequestErrorCode.LANGUAGE_CODE_INVALID,
      "One or more spoken-language codes are invalid.",
    );
  }

  const languageSelection = validateSpokenLanguageSelection(
    session.spoken_language_mode,
    expectedSpokenLanguages,
  );

  if (!languageSelection.valid) {
    return errorResult(
      TranscriptionRequestErrorCode.LANGUAGE_SELECTION_INVALID,
      languageSelection.reason,
    );
  }

  return {
    ok: true,
    value: {
      contractVersion: TRANSCRIPTION_REQUEST_CONTRACT_VERSION,
      jobType: TRANSCRIPTION_JOB_TYPE,
      workspaceId: session.workspace_id,
      sessionId: session.id,
      recordingId: recording.id,
      privateStoragePath,
      spokenLanguageMode: session.spoken_language_mode,
      expectedSpokenLanguages,
      idempotencyKey: buildTranscriptionIdempotencyKey({
        workspaceId: session.workspace_id,
        sessionId: session.id,
        recordingId: recording.id,
        spokenLanguageMode: session.spoken_language_mode,
        expectedSpokenLanguages,
      }),
    },
  };
};
