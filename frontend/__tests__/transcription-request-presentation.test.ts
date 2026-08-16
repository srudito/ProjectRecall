import { resolveTranscriptionRequestPresentation } from "@/src/services/transcription/request-presentation";

describe("transcription request progress presentation", () => {
  it("shows a neutral waiting state after the server accepts a request", () => {
    expect(
      resolveTranscriptionRequestPresentation({
        queueStatus: "submitted",
        lastErrorCode: null,
        transcriptReady: false,
      }),
    ).toEqual({
      statusKey: "recording.transcription.status.submitted",
      detailKey: "recording.transcription.progress.waiting",
      tone: "neutral",
      showSafeError: false,
    });
  });

  it.each([
    [
      "TRANSCRIPTION_RESULT_PROCESSING",
      "recording.transcription.progress.processing",
      "recording.transcription.progress.processingHint",
    ],
    [
      "TRANSCRIPTION_RESULT_COMMIT_PENDING",
      "recording.transcription.progress.finalizing",
      null,
    ],
    [
      "TRANSCRIPTION_RESULT_CLEANUP_PENDING",
      "recording.transcription.progress.cleanup",
      null,
    ],
  ])("maps %s to an ordinary progress phase", (lastErrorCode, statusKey, detailKey) => {
    expect(
      resolveTranscriptionRequestPresentation({
        queueStatus: "submitted",
        lastErrorCode,
        transcriptReady: false,
      }),
    ).toEqual({
      statusKey,
      detailKey,
      tone: "neutral",
      showSafeError: false,
    });
  });

  it.each([
    "TRANSCRIPTION_RESULT_QUERY_FAILED",
    "TRANSCRIPTION_RESULT_INVALID",
    "NETWORK_UNAVAILABLE",
    "TRANSCRIPTION_RESULT_AUTHENTICATION_REQUIRED",
  ])("keeps retryable result diagnostic %s out of the red error treatment", (lastErrorCode) => {
    expect(
      resolveTranscriptionRequestPresentation({
        queueStatus: "submitted",
        lastErrorCode,
        transcriptReady: false,
      }),
    ).toEqual({
      statusKey: "recording.transcription.status.submitted",
      detailKey: "recording.transcription.progress.retryingResult",
      tone: "warning",
      showSafeError: false,
    });
  });

  it("treats a retrying request intent as recoverable", () => {
    expect(
      resolveTranscriptionRequestPresentation({
        queueStatus: "pending",
        lastErrorCode: "NETWORK_UNAVAILABLE",
        transcriptReady: false,
      }),
    ).toEqual({
      statusKey: "recording.transcription.status.pending",
      detailKey: "recording.transcription.progress.retryingRequest",
      tone: "warning",
      showSafeError: false,
    });
  });

  it.each(["failed", "cancelled"])(
    "reserves raw safe-error treatment for terminal %s state",
    (queueStatus) => {
      expect(
        resolveTranscriptionRequestPresentation({
          queueStatus,
          lastErrorCode: "TRANSCRIPTION_REMOTE_JOB_FAILED",
          transcriptReady: false,
        }),
      ).toEqual({
        statusKey: `recording.transcription.status.${queueStatus}`,
        detailKey: null,
        tone: "error",
        showSafeError: true,
      });
    },
  );

  it("shows ready after the current transcript is persisted locally", () => {
    expect(
      resolveTranscriptionRequestPresentation({
        queueStatus: "submitted",
        lastErrorCode: "TRANSCRIPTION_RESULT_QUERY_FAILED",
        transcriptReady: true,
      }),
    ).toEqual({
      statusKey: "recording.transcription.status.ready",
      detailKey: "recording.transcription.progress.ready",
      tone: "success",
      showSafeError: false,
    });
  });
});
