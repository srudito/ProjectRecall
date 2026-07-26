import { sanitizeFileName, validateFile } from "@/src/services/files/validation";

describe("file validation", () => {
  it("accepts a valid image within limits", () => {
    const res = validateFile({
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      fileSize: 2 * 1024 * 1024,
      assetType: "image",
    });
    expect(res.ok).toBe(true);
    expect(res.sanitizedFileName).toBe("photo.jpg");
  });

  it("rejects executables outright", () => {
    const res = validateFile({
      mimeType: "application/x-msdownload",
      fileName: "malware.exe",
      fileSize: 100,
      assetType: "document",
    });
    expect(res.ok).toBe(false);
  });

  it("rejects unsupported MIME", () => {
    const res = validateFile({
      mimeType: "application/x-fake",
      fileName: "file.bin",
      fileSize: 100,
      assetType: "document",
    });
    expect(res.ok).toBe(false);
  });

  it("rejects oversized files", () => {
    const res = validateFile({
      mimeType: "image/jpeg",
      fileName: "big.jpg",
      fileSize: 100 * 1024 * 1024, // > 25 MB image limit
      assetType: "image",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("FILE_TOO_LARGE");
  });

  it("sanitizes weird file names", () => {
    // Path separators stripped, unsafe chars → underscore, spaces → underscore, collapsed.
    const cleaned = sanitizeFileName("../secret name!!.pdf");
    expect(cleaned.includes("/")).toBe(false);
    expect(cleaned.includes("..")).toBe(false);
    expect(cleaned.endsWith(".pdf")).toBe(true);
    expect(cleaned.startsWith("secret_name")).toBe(true);
    expect(sanitizeFileName("no path here")).toBe("no_path_here");
    expect(sanitizeFileName("")).toBe("file");
  });
});
