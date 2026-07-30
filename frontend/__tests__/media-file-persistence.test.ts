import * as FileSystem from "expo-file-system/legacy";

import { fileLimits } from "@/src/config/limits";
import { prepareMediaAssetFile } from "@/src/services/media-file-persistence";

const assetId = "77777777-7777-4777-8777-777777777777";
const sessionId = "55555555-5555-4555-8555-555555555555";

describe("media asset file persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri: string) => ({
      exists: true,
      isDirectory: false,
      uri,
      size: uri.includes("documents") ? 4096 : 2048,
      modificationTime: 0,
      md5: undefined,
    }));
  });

  it("copies a selected image to durable document storage", async () => {
    const result = await prepareMediaAssetFile({
      assetId,
      sessionId,
      sourceUri: `${FileSystem.cacheDirectory}pump photo.jpg`,
      mimeType: "image/jpeg",
      originalFileName: "pump photo.jpg",
      reportedFileSize: 2048,
      assetType: "image",
    });

    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith(
      `${FileSystem.documentDirectory}sessions/${sessionId}/assets/`,
      { intermediates: true },
    );
    expect(FileSystem.copyAsync).toHaveBeenCalledWith({
      from: `${FileSystem.cacheDirectory}pump photo.jpg`,
      to: result.localFileUri,
    });
    expect(result.localFileUri).toContain(`/sessions/${sessionId}/assets/`);
    expect(result.sanitizedFileName).toBe("pump_photo.jpg");
    expect(result.fileSize).toBe(4096);
  });

  it("rejects evidence that exceeds its configured size limit", async () => {
    jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri: string) => ({
      exists: true,
      isDirectory: false,
      uri,
      size: fileLimits.documentMaxBytes + 1,
      modificationTime: 0,
      md5: undefined,
    }));

    await expect(
      prepareMediaAssetFile({
        assetId,
        sessionId,
        sourceUri: `${FileSystem.cacheDirectory}large.pdf`,
        mimeType: "application/pdf",
        originalFileName: "large.pdf",
        reportedFileSize: fileLimits.documentMaxBytes + 1,
        assetType: "document",
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
