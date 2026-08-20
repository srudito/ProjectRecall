import { waitForMediaUploadIdle } from "@/src/services/sync/media-upload-worker";
import { waitForMetadataSyncIdle } from "@/src/services/sync/project-sync-worker";
import { waitForRecordingUploadIdle } from "@/src/services/sync/recording-upload-worker";
import { waitForSessionDeletionIdle } from "@/src/services/sync/session-deletion-worker";
import { waitForTranscriptCurrentVersionSyncIdle } from "@/src/services/sync/transcript-current-version-worker";
import { waitForAccountDeletionBackgroundWork } from "@/src/services/account-deletion/quiescence";

jest.mock("@/src/services/sync/media-upload-worker", () => ({
  waitForMediaUploadIdle: jest.fn(),
}));
jest.mock("@/src/services/sync/project-sync-worker", () => ({
  waitForMetadataSyncIdle: jest.fn(),
}));
jest.mock("@/src/services/sync/recording-upload-worker", () => ({
  waitForRecordingUploadIdle: jest.fn(),
}));
jest.mock("@/src/services/sync/session-deletion-worker", () => ({
  waitForSessionDeletionIdle: jest.fn(),
}));
jest.mock("@/src/services/sync/transcript-current-version-worker", () => ({
  waitForTranscriptCurrentVersionSyncIdle: jest.fn(),
}));

const waits: jest.MockedFunction<() => Promise<void>>[] = [
  waitForMediaUploadIdle as jest.MockedFunction<
    typeof waitForMediaUploadIdle
  >,
  waitForMetadataSyncIdle as jest.MockedFunction<
    typeof waitForMetadataSyncIdle
  >,
  waitForRecordingUploadIdle as jest.MockedFunction<
    typeof waitForRecordingUploadIdle
  >,
  waitForSessionDeletionIdle as jest.MockedFunction<
    typeof waitForSessionDeletionIdle
  >,
  waitForTranscriptCurrentVersionSyncIdle as jest.MockedFunction<
    typeof waitForTranscriptCurrentVersionSyncIdle
  >,
];

describe("account deletion background-work quiescence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const wait of waits) wait.mockResolvedValue();
  });

  it("waits for every already-running worker to become idle", async () => {
    await expect(waitForAccountDeletionBackgroundWork()).resolves.toBeUndefined();
    for (const wait of waits) expect(wait).toHaveBeenCalledTimes(1);
  });

  it("fails safely when a worker cannot become idle before the timeout", async () => {
    jest.useFakeTimers();
    try {
      waits[0].mockImplementation(() => new Promise(() => {}));

      const rejectionExpectation = expect(
        waitForAccountDeletionBackgroundWork(50),
      ).rejects.toMatchObject({
        code: "ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE",
      });

      await jest.advanceTimersByTimeAsync(50);
      await rejectionExpectation;
    } finally {
      jest.useRealTimers();
    }
  });
});
