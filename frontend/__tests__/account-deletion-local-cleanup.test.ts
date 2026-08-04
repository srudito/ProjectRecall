import * as FileSystem from "expo-file-system/legacy";

import {
  deleteLocalAccountFiles,
  isSafeAppOwnedFileUri,
  performLocalAccountCleanup,
} from "@/src/services/account-deletion/local-cleanup";
import {
  collectLocalAccountCleanupScope,
  deleteLocalAccountData,
} from "@/src/services/sqlite/repository";
import { clearPersonalWorkspaceCache } from "@/src/services/workspace/service";

jest.mock("@/src/services/sqlite/repository", () => ({
  collectLocalAccountCleanupScope: jest.fn(),
  deleteLocalAccountData: jest.fn(),
}));

jest.mock("@/src/services/workspace/service", () => ({
  clearPersonalWorkspaceCache: jest.fn(),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const MEDIA_ID = "44444444-4444-4444-8444-444444444444";

const mockedCollect = collectLocalAccountCleanupScope as jest.MockedFunction<
  typeof collectLocalAccountCleanupScope
>;
const mockedDeleteData = deleteLocalAccountData as jest.MockedFunction<
  typeof deleteLocalAccountData
>;
const mockedClearWorkspace =
  clearPersonalWorkspaceCache as jest.MockedFunction<
    typeof clearPersonalWorkspaceCache
  >;
const mockedDeleteAsync = FileSystem.deleteAsync as jest.MockedFunction<
  typeof FileSystem.deleteAsync
>;
const mockedGetInfoAsync = FileSystem.getInfoAsync as jest.MockedFunction<
  typeof FileSystem.getInfoAsync
>;
const mockedReadDirectoryAsync =
  FileSystem.readDirectoryAsync as jest.MockedFunction<
    typeof FileSystem.readDirectoryAsync
  >;

describe("local account cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetInfoAsync.mockResolvedValue({ exists: true } as never);
    mockedReadDirectoryAsync.mockResolvedValue([
      `${MEDIA_ID}_document.pdf`,
      "other-asset_document.pdf",
    ]);
  });

  it("accepts only app-owned file URIs", () => {
    expect(
      isSafeAppOwnedFileUri({
        uri: "file:///tmp/documents/sessions/file.m4a",
        documentDirectory: "file:///tmp/documents/",
        cacheDirectory: "file:///tmp/cache/",
      }),
    ).toBe(true);
    expect(
      isSafeAppOwnedFileUri({
        uri: "content://downloads/private-document.pdf",
        documentDirectory: "file:///tmp/documents/",
        cacheDirectory: "file:///tmp/cache/",
      }),
    ).toBe(false);
    expect(
      isSafeAppOwnedFileUri({
        uri: "file:///outside-app/private.m4a",
        documentDirectory: "file:///tmp/documents/",
        cacheDirectory: "file:///tmp/cache/",
      }),
    ).toBe(false);
    expect(
      isSafeAppOwnedFileUri({
        uri: "file:///tmp/documents/sessions/%2e%2e/private.m4a",
        documentDirectory: "file:///tmp/documents/",
        cacheDirectory: "file:///tmp/cache/",
      }),
    ).toBe(false);
  });

  it("removes durable files, session directories, and matching evidence cache only", async () => {
    await deleteLocalAccountFiles({
      workspaceIds: [WORKSPACE_ID],
      sessionIds: [SESSION_ID],
      mediaAssetIds: [MEDIA_ID],
      localFileUris: [
        "file:///tmp/documents/sessions/original.m4a",
        "file:///tmp/cache/staged-upload.bin",
        "content://downloads/do-not-delete.pdf",
        "file:///outside-app/do-not-delete.m4a",
      ],
    });

    expect(mockedDeleteAsync).toHaveBeenCalledWith(
      "file:///tmp/documents/sessions/original.m4a",
      { idempotent: true },
    );
    expect(mockedDeleteAsync).toHaveBeenCalledWith(
      "file:///tmp/cache/staged-upload.bin",
      { idempotent: true },
    );
    expect(mockedDeleteAsync).toHaveBeenCalledWith(
      `file:///tmp/documents/sessions/${SESSION_ID}`,
      { idempotent: true },
    );
    expect(mockedDeleteAsync).toHaveBeenCalledWith(
      `file:///tmp/cache/evidence-open/${MEDIA_ID}_document.pdf`,
      { idempotent: true },
    );
    expect(mockedDeleteAsync).not.toHaveBeenCalledWith(
      "content://downloads/do-not-delete.pdf",
      expect.anything(),
    );
    expect(mockedDeleteAsync).not.toHaveBeenCalledWith(
      "file:///outside-app/do-not-delete.m4a",
      expect.anything(),
    );
    expect(mockedDeleteAsync).not.toHaveBeenCalledWith(
      "file:///tmp/cache/evidence-open/other-asset_document.pdf",
      expect.anything(),
    );
  });

  it("ignores corrupt session and media identifiers before constructing deletion paths", async () => {
    mockedReadDirectoryAsync.mockResolvedValue([
      "other-asset_document.pdf",
    ]);

    await deleteLocalAccountFiles({
      workspaceIds: [WORKSPACE_ID],
      sessionIds: ["../outside", "%2e%2e", SESSION_ID],
      mediaAssetIds: ["", "other", MEDIA_ID],
      localFileUris: [],
    });

    expect(mockedDeleteAsync).toHaveBeenCalledWith(
      `file:///tmp/documents/sessions/${SESSION_ID}`,
      { idempotent: true },
    );
    expect(mockedDeleteAsync).not.toHaveBeenCalledWith(
      "file:///tmp/documents/sessions/../outside",
      expect.anything(),
    );
    expect(mockedDeleteAsync).not.toHaveBeenCalledWith(
      "file:///tmp/cache/evidence-open/other-asset_document.pdf",
      expect.anything(),
    );
  });

  it("deletes files before their SQLite metadata and clears only the matching workspace cache", async () => {
    mockedCollect.mockResolvedValue({
      workspaceIds: [WORKSPACE_ID],
      sessionIds: [SESSION_ID],
      mediaAssetIds: [MEDIA_ID],
      localFileUris: ["file:///tmp/documents/sessions/original.m4a"],
    });
    mockedDeleteData.mockResolvedValue();
    mockedClearWorkspace.mockResolvedValue();

    await expect(
      performLocalAccountCleanup({
        userId: USER_ID,
        workspaceIds: [WORKSPACE_ID],
      }),
    ).resolves.toMatchObject({
      workspaceIds: [WORKSPACE_ID],
      sessionIds: [SESSION_ID],
    });

    expect(mockedCollect).toHaveBeenCalledWith(USER_ID, [WORKSPACE_ID]);
    expect(mockedDeleteData).toHaveBeenCalledWith({
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID],
      sessionIds: [SESSION_ID],
    });
    expect(mockedClearWorkspace).toHaveBeenCalledWith(USER_ID);
    expect(mockedDeleteAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mockedDeleteData.mock.invocationCallOrder[0],
    );
  });

  it("maps partial local cleanup failures to a safe application error", async () => {
    mockedCollect.mockRejectedValue(new Error("raw sqlite path"));

    await expect(
      performLocalAccountCleanup({
        userId: USER_ID,
        workspaceIds: [WORKSPACE_ID],
      }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_LOCAL_CLEANUP_FAILED",
    });
  });
});
