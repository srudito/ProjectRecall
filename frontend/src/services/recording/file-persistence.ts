import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { fileLimits } from "@/src/config/limits";
import { AppError, ErrorCode } from "@/src/domain/errors";

export interface PreparedRecordingFile {
  localFileUri: string;
  fileSize: number;
  mimeType: string;
  extension: string;
  recordingFormat: string;
  originalFileName: string;
}

const extensionToMime: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  webm: "audio/webm",
  "3gp": "audio/3gpp",
};

const mimeToExtension: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/3gpp": "3gp",
};

const extensionFromUri = (uri: string): string | null => {
  const clean = uri.split(/[?#]/, 1)[0];
  const match = clean.match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1]?.toLowerCase() ?? null;
};

const normalizeMime = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  return normalized.startsWith("audio/") ? normalized : null;
};

const determineAudioIdentity = (input: {
  sourceUri: string;
  blobMimeType?: string | null;
}): { extension: string; mimeType: string } => {
  const mimeType = normalizeMime(input.blobMimeType);
  const extensionFromMime = mimeType ? mimeToExtension[mimeType] : undefined;
  const uriExtension = extensionFromUri(input.sourceUri);
  const extension = extensionFromMime ?? uriExtension ?? (Platform.OS === "web" ? "webm" : "m4a");
  return {
    extension,
    mimeType: mimeType ?? extensionToMime[extension] ?? "audio/mp4",
  };
};

const ensureAudioSizeAllowed = (fileSize: number): void => {
  if (fileSize > fileLimits.audioMaxBytes) {
    throw new AppError(ErrorCode.FILE_TOO_LARGE);
  }
};

const persistentRecordingDirectory = (sessionId: string): string => {
  if (!FileSystem.documentDirectory) {
    throw new AppError(
      ErrorCode.LOCAL_FILE_MISSING,
      "Persistent application storage is unavailable.",
    );
  }
  return `${FileSystem.documentDirectory}sessions/${sessionId}/recordings/`;
};

/**
 * Move/copy the recorder output into the document directory on native so the
 * system cannot purge it as a cache file. Web MediaRecorder returns a blob URL;
 * that URL is used only long enough for the immediate cloud upload.
 */
export const prepareStoppedRecordingFile = async (input: {
  recordingId: string;
  sessionId: string;
  sourceUri: string;
  reportedFileSize: number;
}): Promise<PreparedRecordingFile> => {
  if (Platform.OS === "web") {
    const response = await fetch(input.sourceUri);
    if (!response.ok) {
      throw new AppError(
        ErrorCode.FILE_READ_FAILED,
        "The browser recording could not be read.",
      );
    }
    const blob = await response.blob();
    const identity = determineAudioIdentity({
      sourceUri: input.sourceUri,
      blobMimeType: blob.type,
    });
    const fileSize = blob.size || input.reportedFileSize;
    ensureAudioSizeAllowed(fileSize);
    const originalFileName = `recording-${input.recordingId}.${identity.extension}`;
    return {
      localFileUri: input.sourceUri,
      fileSize,
      mimeType: identity.mimeType,
      extension: identity.extension,
      recordingFormat: identity.extension,
      originalFileName,
    };
  }

  const sourceInfo = await FileSystem.getInfoAsync(input.sourceUri);
  if (!sourceInfo.exists) {
    throw new AppError(ErrorCode.LOCAL_FILE_MISSING);
  }

  const identity = determineAudioIdentity({ sourceUri: input.sourceUri });
  const originalFileName = `recording-${input.recordingId}.${identity.extension}`;
  const directory = persistentRecordingDirectory(input.sessionId);
  const targetUri = `${directory}${originalFileName}`;

  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });

  if (input.sourceUri !== targetUri) {
    const targetInfo = await FileSystem.getInfoAsync(targetUri);
    if (targetInfo.exists) {
      await FileSystem.deleteAsync(targetUri, { idempotent: true });
    }
    await FileSystem.copyAsync({ from: input.sourceUri, to: targetUri });
  }

  const persistedInfo = await FileSystem.getInfoAsync(targetUri);
  if (!persistedInfo.exists) {
    throw new AppError(ErrorCode.LOCAL_FILE_MISSING);
  }

  const persistedSize =
    "size" in persistedInfo && typeof persistedInfo.size === "number"
      ? persistedInfo.size
      : 0;
  const fileSize = persistedSize || input.reportedFileSize;
  ensureAudioSizeAllowed(fileSize);

  // The durable copy is now the canonical local source. Cache cleanup is best
  // effort and must never invalidate the new recording.
  if (
    input.sourceUri !== targetUri &&
    FileSystem.cacheDirectory &&
    input.sourceUri.startsWith(FileSystem.cacheDirectory)
  ) {
    void FileSystem.deleteAsync(input.sourceUri, { idempotent: true }).catch(() => {});
  }

  return {
    localFileUri: targetUri,
    fileSize,
    mimeType: identity.mimeType,
    extension: identity.extension,
    recordingFormat: identity.extension,
    originalFileName,
  };
};
