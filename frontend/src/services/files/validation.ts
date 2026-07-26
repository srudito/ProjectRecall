// File validation helpers. Milestone 1 rules:
//   * Validate MIME + extension + size against centralized limits.
//   * Sanitize file names.
//   * Reject executables outright.
//   * Do not trust extensions alone.

import { fileLimits, supportedMime } from "@/src/config/limits";
import { AppError, ErrorCode } from "@/src/domain/errors";

const EXECUTABLE_EXTENSIONS = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "msi",
  "sh",
  "app",
  "apk",
  "ipa",
  "dmg",
  "bin",
  "scr",
  "js",
  "vbs",
]);

export interface FileValidationInput {
  mimeType: string;
  fileName: string;
  fileSize: number;
  assetType: "image" | "video" | "document" | "audio_attachment";
}

export interface FileValidationResult {
  ok: boolean;
  code?: (typeof ErrorCode)[keyof typeof ErrorCode];
  sanitizedFileName: string;
  extension: string;
}

const getExtension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
};

export const sanitizeFileName = (name: string): string => {
  // Strip path separators; keep alnum, dash, dot, underscore, space.
  const base = name.split(/[\/\\]/).pop() ?? "file";
  const cleaned = base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length === 0 ? "file" : cleaned.slice(0, 200);
};

export const validateFile = (input: FileValidationInput): FileValidationResult => {
  const extension = getExtension(input.fileName);
  const sanitizedFileName = sanitizeFileName(input.fileName);

  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    return { ok: false, code: ErrorCode.FILE_UNSUPPORTED, sanitizedFileName, extension };
  }

  const acceptedMimes: readonly string[] = (() => {
    switch (input.assetType) {
      case "image":
        return supportedMime.image;
      case "video":
        return supportedMime.video;
      case "document":
        return supportedMime.document;
      case "audio_attachment":
        return supportedMime.audio;
    }
  })();

  if (!acceptedMimes.some((m) => m.toLowerCase() === input.mimeType.toLowerCase())) {
    return { ok: false, code: ErrorCode.FILE_UNSUPPORTED, sanitizedFileName, extension };
  }

  const maxBytes = (() => {
    switch (input.assetType) {
      case "image":
        return fileLimits.imageMaxBytes;
      case "video":
        return fileLimits.videoMaxBytes;
      case "document":
        return fileLimits.documentMaxBytes;
      case "audio_attachment":
        return fileLimits.audioMaxBytes;
    }
  })();

  if (input.fileSize > maxBytes) {
    return { ok: false, code: ErrorCode.FILE_TOO_LARGE, sanitizedFileName, extension };
  }

  return { ok: true, sanitizedFileName, extension };
};

export const throwIfInvalid = (input: FileValidationInput): FileValidationResult => {
  const result = validateFile(input);
  if (!result.ok && result.code) {
    throw new AppError(result.code);
  }
  return result;
};
