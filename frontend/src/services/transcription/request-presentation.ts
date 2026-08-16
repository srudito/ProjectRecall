export type TranscriptionRequestPresentationTone =
  | "neutral"
  | "warning"
  | "error"
  | "success";

export interface TranscriptionRequestPresentationInput {
  queueStatus: string;
  lastErrorCode: string | null;
  transcriptReady: boolean;
}

export interface TranscriptionRequestPresentation {
  statusKey: string;
  detailKey: string | null;
  tone: TranscriptionRequestPresentationTone;
  showSafeError: boolean;
}

const statusKey = (status: string): string =>
  `recording.transcription.status.${status}`;

export const resolveTranscriptionRequestPresentation = (
  input: TranscriptionRequestPresentationInput,
): TranscriptionRequestPresentation => {
  if (input.queueStatus === "failed" || input.queueStatus === "cancelled") {
    return {
      statusKey: statusKey(input.queueStatus),
      detailKey: null,
      tone: "error",
      showSafeError: true,
    };
  }

  if (input.queueStatus === "submitted" && input.transcriptReady) {
    return {
      statusKey: statusKey("ready"),
      detailKey: "recording.transcription.progress.ready",
      tone: "success",
      showSafeError: false,
    };
  }

  if (input.queueStatus === "submitted") {
    switch (input.lastErrorCode) {
      case "TRANSCRIPTION_RESULT_PROCESSING":
        return {
          statusKey: "recording.transcription.progress.processing",
          detailKey: "recording.transcription.progress.processingHint",
          tone: "neutral",
          showSafeError: false,
        };
      case "TRANSCRIPTION_RESULT_COMMIT_PENDING":
        return {
          statusKey: "recording.transcription.progress.finalizing",
          detailKey: null,
          tone: "neutral",
          showSafeError: false,
        };
      case "TRANSCRIPTION_RESULT_CLEANUP_PENDING":
        return {
          statusKey: "recording.transcription.progress.cleanup",
          detailKey: null,
          tone: "neutral",
          showSafeError: false,
        };
      default:
        if (input.lastErrorCode) {
          return {
            statusKey: statusKey("submitted"),
            detailKey: "recording.transcription.progress.retryingResult",
            tone: "warning",
            showSafeError: false,
          };
        }
        return {
          statusKey: statusKey("submitted"),
          detailKey: "recording.transcription.progress.waiting",
          tone: "neutral",
          showSafeError: false,
        };
    }
  }

  if (
    (input.queueStatus === "pending" || input.queueStatus === "submitting") &&
    input.lastErrorCode
  ) {
    return {
      statusKey: statusKey(input.queueStatus),
      detailKey: "recording.transcription.progress.retryingRequest",
      tone: "warning",
      showSafeError: false,
    };
  }

  return {
    statusKey: statusKey(input.queueStatus),
    detailKey: null,
    tone: "neutral",
    showSafeError: false,
  };
};
