// Centralized configurable limits. Do not hard-code these inside components.

const MB = 1024 * 1024;

export const fileLimits = {
  audioMaxBytes: 500 * MB,
  imageMaxBytes: 25 * MB,
  videoMaxBytes: 500 * MB,
  documentMaxBytes: 100 * MB,
} as const;

export const uploadRetry = {
  // Exponential backoff parameters used by the upload queue.
  initialDelayMs: 2_000,
  maxDelayMs: 5 * 60 * 1000, // 5 minutes
  backoffFactor: 2,
  jitterRatio: 0.25,
  maxAttempts: 8,
} as const;

export const recordingLimits = {
  // Low-storage warning trigger.
  minFreeBytesWarning: 200 * MB,
  // Maximum recording length displayed as guidance; not enforced hard.
  softMaxDurationMs: 12 * 60 * 60 * 1000,
} as const;

export const supportedMime = {
  image: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4", "video/quicktime"],
  document: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
  ],
  audio: ["audio/mp4", "audio/aac", "audio/m4a", "audio/mpeg", "audio/wav"],
} as const;
