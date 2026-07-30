import * as FileSystem from "expo-file-system/legacy";

import { fileLimits } from "@/src/config/limits";
import { prepareStoppedRecordingFile } from "@/src/services/recording/file-persistence";

const recordingId = "77777777-7777-4777-8777-777777777777";
const sessionId = "55555555-5555-4555-8555-555555555555";

describe("recording file persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri: string) => ({
      exists: true,
      isDirectory: false,
      uri,
      size: uri.includes("documents") ? 2048 : 1024,
      modificationTime: 0,
      md5: undefined,
    }));
  });

  it("copies a native cache recording to durable document storage", async () => {
    const result = await prepareStoppedRecordingFile({
      recordingId,
      sessionId,
      sourceUri: `${FileSystem.cacheDirectory}recording.m4a`,
      reportedFileSize: 1024,
    });

    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith(
      `${FileSystem.documentDirectory}sessions/${sessionId}/recordings/`,
      { intermediates: true },
    );
    expect(FileSystem.copyAsync).toHaveBeenCalledWith({
      from: `${FileSystem.cacheDirectory}recording.m4a`,
      to: result.localFileUri,
    });
    expect(result.localFileUri).toContain("/sessions/");
    expect(result.fileSize).toBe(2048);
    expect(result.mimeType).toBe("audio/mp4");
  });

  it("rejects a recording that exceeds the configured limit", async () => {
    jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri: string) => ({
      exists: true,
      isDirectory: false,
      uri,
      size: fileLimits.audioMaxBytes + 1,
      modificationTime: 0,
      md5: undefined,
    }));

    await expect(
      prepareStoppedRecordingFile({
        recordingId,
        sessionId,
        sourceUri: `${FileSystem.cacheDirectory}large.m4a`,
        reportedFileSize: fileLimits.audioMaxBytes + 1,
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
