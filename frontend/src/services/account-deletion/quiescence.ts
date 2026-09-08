import { AppError, ErrorCode } from "@/src/domain/errors";
import { waitForMediaUploadIdle } from "@/src/services/sync/media-upload-worker";
import { waitForMetadataSyncIdle } from "@/src/services/sync/project-sync-worker";
import { waitForRecordingUploadIdle } from "@/src/services/sync/recording-upload-worker";
import { waitForSessionDeletionIdle } from "@/src/services/sync/session-deletion-worker";
import { waitForTranscriptCurrentVersionSyncIdle } from "@/src/services/sync/transcript-current-version-worker";

import {
  pauseTranscriptEditSync,
  waitForTranscriptEditSyncIdle,
} from "@/src/services/sync/transcript-edit-worker";

import {
  invalidateTranscriptEditors,
  waitForTranscriptEditorsIdle,
} from "@/src/services/transcription/editor-lifecycle";

const DEFAULT_IDLE_TIMEOUT_MS = 20_000;

const withTimeout = async (
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new AppError(
              ErrorCode.ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE,
              "Background synchronization did not stop in time.",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

/**
 * Wait until every already-running local worker has released its current
 * operation. The persistent deletion marker is written before this function is
 * called, so each worker refuses to claim another operation while we wait.
 */
export const waitForAccountDeletionBackgroundWork = async (
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<void> => {
  // Close edit admission and invalidate scheduled callbacks BEFORE taking the
  // idle snapshot. The account-deletion marker prevents lifecycle resumption.
  invalidateTranscriptEditors();
  pauseTranscriptEditSync();
  await withTimeout(
    Promise.all([
      waitForTranscriptEditorsIdle(),
      waitForMetadataSyncIdle(),
      waitForRecordingUploadIdle(),
      waitForMediaUploadIdle(),
      waitForSessionDeletionIdle(),
      waitForTranscriptCurrentVersionSyncIdle(),
      waitForTranscriptEditSyncIdle(),
    ]).then(() => undefined),
    timeoutMs,
  );
};
