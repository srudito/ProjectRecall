import { waitForMediaUploadIdle } from "@/src/services/sync/media-upload-worker";
import { waitForMetadataSyncIdle } from "@/src/services/sync/project-sync-worker";
import { waitForRecordingUploadIdle } from "@/src/services/sync/recording-upload-worker";
import { waitForSessionDeletionIdle } from "@/src/services/sync/session-deletion-worker";
import { waitForTranscriptCurrentVersionSyncIdle } from "@/src/services/sync/transcript-current-version-worker";
import {
  pauseTranscriptEditSync,
  waitForTranscriptEditSyncIdle,
} from "@/src/services/sync/transcript-edit-worker";
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

jest.mock("@/src/services/sync/transcript-edit-worker", () => ({
  pauseTranscriptEditSync: jest.fn(),
  waitForTranscriptEditSyncIdle: jest.fn(),
}));

const waits: jest.MockedFunction<() => Promise<void>>[] = [
  waitForTranscriptEditSyncIdle as jest.MockedFunction<typeof waitForTranscriptEditSyncIdle>,
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
    const stop = pauseTranscriptEditSync as jest.Mock;
    const editWait = waitForTranscriptEditSyncIdle as jest.Mock;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(editWait.mock.invocationCallOrder[0]);
  });

  it("fails safely when a worker cannot become idle before the timeout", async () => {
    jest.useFakeTimers();
    try {
      waits[1].mockImplementation(() => new Promise(() => {}));

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
  it("holds cleanup until the in-flight edit really drains", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    (waitForTranscriptEditSyncIdle as jest.Mock).mockReturnValue(blocked);
    let finished = false;
    const pending = waitForAccountDeletionBackgroundWork().then(() => { finished = true; });
    await Promise.resolve();
    expect(pauseTranscriptEditSync).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    release(); await pending; expect(finished).toBe(true);
  });

  it("does not treat an edit drain timeout as successful quiescence", async () => {
    jest.useFakeTimers();
    try {
      (waitForTranscriptEditSyncIdle as jest.Mock).mockReturnValue(new Promise<void>(() => {}));
      const rejected = expect(waitForAccountDeletionBackgroundWork(50))
        .rejects.toMatchObject({ code: "ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE" });
      await jest.advanceTimersByTimeAsync(50);
      await rejected;
      expect(pauseTranscriptEditSync).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
});
