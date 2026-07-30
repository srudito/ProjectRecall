import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { AppError, ErrorCode } from "@/src/domain/errors";
import { throwIfInvalid } from "@/src/services/files/validation";

export type EvidenceAssetType = "image" | "video" | "document" | "audio_attachment";

export interface PreparedMediaAssetFile {
  localFileUri: string;
  fileSize: number;
  mimeType: string;
  originalFileName: string;
  sanitizedFileName: string;
}

const persistentAssetDirectory = (sessionId: string): string => {
  if (!FileSystem.documentDirectory) {
    throw new AppError(
      ErrorCode.LOCAL_FILE_MISSING,
      "Persistent application storage is unavailable.",
    );
  }
  return `${FileSystem.documentDirectory}sessions/${sessionId}/assets/`;
};

const actualWebFileSize = async (uri: string): Promise<number> => {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new AppError(
      ErrorCode.FILE_READ_FAILED,
      "The selected browser file could not be read.",
    );
  }
  const blob = await response.blob();
  return blob.size;
};

/**
 * Preserve selected evidence in the application document directory on native.
 * Web picker blob URLs are intentionally short-lived and are returned only for
 * the immediate cloud upload path.
 */
export const prepareMediaAssetFile = async (input: {
  assetId: string;
  sessionId: string;
  sourceUri: string;
  mimeType: string;
  originalFileName: string;
  reportedFileSize: number;
  assetType: EvidenceAssetType;
}): Promise<PreparedMediaAssetFile> => {
  const initialValidation = throwIfInvalid({
    mimeType: input.mimeType,
    fileName: input.originalFileName,
    fileSize: Math.max(0, input.reportedFileSize),
    assetType: input.assetType,
  });

  if (Platform.OS === "web") {
    const actualSize = await actualWebFileSize(input.sourceUri);
    throwIfInvalid({
      mimeType: input.mimeType,
      fileName: input.originalFileName,
      fileSize: actualSize,
      assetType: input.assetType,
    });
    return {
      localFileUri: input.sourceUri,
      fileSize: actualSize,
      mimeType: input.mimeType,
      originalFileName: input.originalFileName,
      sanitizedFileName: initialValidation.sanitizedFileName,
    };
  }

  const sourceInfo = await FileSystem.getInfoAsync(input.sourceUri);
  if (!sourceInfo.exists) {
    throw new AppError(ErrorCode.LOCAL_FILE_MISSING);
  }

  const directory = persistentAssetDirectory(input.sessionId);
  const targetUri = `${directory}${input.assetId}_${initialValidation.sanitizedFileName}`;
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
  const fileSize = persistedSize || Math.max(0, input.reportedFileSize);

  throwIfInvalid({
    mimeType: input.mimeType,
    fileName: input.originalFileName,
    fileSize,
    assetType: input.assetType,
  });

  if (
    input.sourceUri !== targetUri &&
    FileSystem.cacheDirectory &&
    input.sourceUri.startsWith(FileSystem.cacheDirectory)
  ) {
    void FileSystem.deleteAsync(input.sourceUri, { idempotent: true }).catch(
      () => {},
    );
  }

  return {
    localFileUri: targetUri,
    fileSize,
    mimeType: input.mimeType,
    originalFileName: input.originalFileName,
    sanitizedFileName: initialValidation.sanitizedFileName,
  };
};
