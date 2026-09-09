import { invalidateTranscriptHistoryCache, waitForTranscriptHistoryCacheIdle } from "@/src/services/transcription/history-cache-service";
import { invalidateLocalReadSnapshots, waitForLocalReadSnapshotsIdle } from "@/src/services/sqlite/read-snapshot";
import { waitForMediaUploadIdle } from "@/src/services/sync/media-upload-worker";
import { waitForMetadataSyncIdle } from "@/src/services/sync/project-sync-worker";
import { waitForRecordingUploadIdle } from "@/src/services/sync/recording-upload-worker";
import { waitForSessionDeletionIdle } from "@/src/services/sync/session-deletion-worker";
import { waitForTranscriptCurrentVersionSyncIdle } from "@/src/services/sync/transcript-current-version-worker";
import {
  pauseTranscriptEditSync,
  waitForTranscriptEditSyncIdle,
} from "@/src/services/sync/transcript-edit-worker";
import { invalidateTranscriptEditors, waitForTranscriptEditorsIdle } from "@/src/services/transcription/editor-lifecycle";
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

jest.mock("@/src/services/transcription/editor-lifecycle", () => ({
  invalidateTranscriptEditors: jest.fn(),
  waitForTranscriptEditorsIdle: jest.fn(),
}));

jest.mock("@/src/services/sqlite/read-snapshot", () => ({
  invalidateLocalReadSnapshots: jest.fn(),
  waitForLocalReadSnapshotsIdle: jest.fn(),
}));

jest.mock("@/src/services/transcription/history-cache-service", () => ({
  invalidateTranscriptHistoryCache: jest.fn(),
  waitForTranscriptHistoryCacheIdle: jest.fn(),
}));

const waits: jest.MockedFunction<() => Promise<void>>[] = [
  waitForTranscriptEditorsIdle as jest.MockedFunction<typeof waitForTranscriptEditorsIdle>,
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
  waitForLocalReadSnapshotsIdle as jest.MockedFunction<typeof waitForLocalReadSnapshotsIdle>,
  waitForTranscriptHistoryCacheIdle as jest.MockedFunction<() => Promise<void>>,
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
    expect(invalidateTranscriptEditors).toHaveBeenCalledTimes(1);
    expect((invalidateTranscriptEditors as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((waitForTranscriptEditorsIdle as jest.Mock).mock.invocationCallOrder[0]);
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
  it("holds cleanup for a retired controller with SQL still queued", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    (waitForTranscriptEditorsIdle as jest.Mock).mockReturnValue(blocked);
    let finished = false;
    const pending = waitForAccountDeletionBackgroundWork().then(() => { finished = true; });
    await Promise.resolve();
    expect(invalidateTranscriptEditors).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    release(); await pending; expect(finished).toBe(true);
  });

  it("does not treat a controller timeout as a successful drain", async () => {
    jest.useFakeTimers();
    try {
      (waitForTranscriptEditorsIdle as jest.Mock).mockReturnValue(new Promise<void>(() => {}));
      const rejected = expect(waitForAccountDeletionBackgroundWork(50))
        .rejects.toMatchObject({ code: "ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE" });
      await jest.advanceTimersByTimeAsync(50); await rejected;
    } finally { jest.useRealTimers(); }
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

describe("read snapshot deletion quiescence", () => {
  beforeEach(() => { jest.clearAllMocks(); for (const wait of waits) wait.mockResolvedValue(); });
  it("invalidates read delivery before collecting idle promises", async () => {
    await waitForAccountDeletionBackgroundWork();
    expect(invalidateLocalReadSnapshots).toHaveBeenCalledTimes(1);
    expect((invalidateLocalReadSnapshots as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((waitForLocalReadSnapshotsIdle as jest.Mock).mock.invocationCallOrder[0]);
  });
  it("holds cleanup while a cancelled read still owns its native handle", async () => {
    let release!: () => void;
    (waitForLocalReadSnapshotsIdle as jest.Mock).mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    let complete = false; const pending = waitForAccountDeletionBackgroundWork().then(() => { complete = true; });
    await Promise.resolve(); expect(complete).toBe(false); release(); await pending; expect(complete).toBe(true);
  });
  it("does not treat an unclosed read as successful cleanup or expose native errors", async () => {
    (waitForLocalReadSnapshotsIdle as jest.Mock).mockRejectedValue(new Error("PRIVATE CLOSE ERROR"));
    await expect(waitForAccountDeletionBackgroundWork()).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE", message: "Local read resources have not been released.",
    });
  });
  it("does not turn a native read drain timeout into idle", async () => {
    jest.useFakeTimers();
    try {
      (waitForLocalReadSnapshotsIdle as jest.Mock).mockReturnValue(new Promise<void>(() => {}));
      const rejected = expect(waitForAccountDeletionBackgroundWork(50))
        .rejects.toMatchObject({ code: "ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE" });
      await jest.advanceTimersByTimeAsync(50); await rejected;
    } finally { jest.useRealTimers(); }
  });
});

describe("history writer deletion quiescence", () => {
  beforeEach(() => { jest.clearAllMocks(); for (const wait of waits) wait.mockResolvedValue(); });
  it("invalidates history admission before waiting for native writes and close", async () => {
    await waitForAccountDeletionBackgroundWork();
    expect(invalidateTranscriptHistoryCache).toHaveBeenCalledTimes(1);
    expect((invalidateTranscriptHistoryCache as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((waitForTranscriptHistoryCacheIdle as jest.Mock).mock.invocationCallOrder[0]);
  });
  it("does not start cleanup while a retired writer still owns native work", async () => {
    let release!: () => void;
    (waitForTranscriptHistoryCacheIdle as jest.Mock).mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    let idle = false; const pending = waitForAccountDeletionBackgroundWork().then(() => { idle = true; });
    await Promise.resolve(); expect(idle).toBe(false); release(); await pending; expect(idle).toBe(true);
  });
  it("fails closed and redacts writer drain failures", async () => {
    (waitForTranscriptHistoryCacheIdle as jest.Mock).mockRejectedValue(new Error("PRIVATE NATIVE WRITE"));
    await expect(waitForAccountDeletionBackgroundWork()).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE", message: "Local history write resources have not been released.",
    });
  });
});
