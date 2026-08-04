import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { AppError, ErrorCode } from "@/src/domain/errors";
import {
  collectLocalAccountCleanupScope,
  deleteLocalAccountData,
  type LocalAccountCleanupScope,
} from "@/src/services/sqlite/repository";
import { clearPersonalWorkspaceCache } from "@/src/services/workspace/service";

const uniqueStrings = (values: readonly string[]): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uniqueUuids = (values: readonly string[]): string[] =>
  uniqueStrings(values).filter((value) => UUID_PATTERN.test(value));

export const isSafeAppOwnedFileUri = (input: {
  uri: string;
  documentDirectory: string | null;
  cacheDirectory: string | null;
}): boolean => {
  if (!input.uri.startsWith("file://")) return false;

  let decodedUri: string;
  try {
    decodedUri = decodeURIComponent(input.uri);
  } catch {
    return false;
  }

  const pathSegments = decodedUri.slice("file://".length).split("/");
  if (pathSegments.some((segment) => segment === "." || segment === "..")) {
    return false;
  }

  return [input.documentDirectory, input.cacheDirectory]
    .filter((value): value is string => Boolean(value))
    .some((directory) => decodedUri.startsWith(directory));
};

const deleteEvidenceOpenCacheFiles = async (
  mediaAssetIds: readonly string[],
): Promise<void> => {
  if (!FileSystem.cacheDirectory || mediaAssetIds.length === 0) return;

  const directory = `${FileSystem.cacheDirectory}evidence-open/`;
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists) return;

  const names = await FileSystem.readDirectoryAsync(directory);
  const prefixes = uniqueUuids(mediaAssetIds).map((id) => `${id}_`);
  if (prefixes.length === 0) return;

  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    await FileSystem.deleteAsync(`${directory}${name}`, {
      idempotent: true,
    });
  }
};

export const deleteLocalAccountFiles = async (
  scope: LocalAccountCleanupScope,
): Promise<void> => {
  if (Platform.OS === "web") return;

  for (const uri of uniqueStrings(scope.localFileUris)) {
    if (
      !isSafeAppOwnedFileUri({
        uri,
        documentDirectory: FileSystem.documentDirectory,
        cacheDirectory: FileSystem.cacheDirectory,
      })
    ) {
      continue;
    }

    await FileSystem.deleteAsync(uri, { idempotent: true });
  }

  if (FileSystem.documentDirectory) {
    for (const sessionId of uniqueUuids(scope.sessionIds)) {
      await FileSystem.deleteAsync(
        `${FileSystem.documentDirectory}sessions/${sessionId}`,
        { idempotent: true },
      );
    }
  }

  await deleteEvidenceOpenCacheFiles(scope.mediaAssetIds);
};

export const performLocalAccountCleanup = async (input: {
  userId: string;
  workspaceIds: readonly string[];
}): Promise<LocalAccountCleanupScope> => {
  try {
    const scope = await collectLocalAccountCleanupScope(
      input.userId,
      input.workspaceIds,
    );

    // Delete durable private files before deleting the metadata that tells us
    // where they live. Every operation is idempotent so a crash can safely
    // resume from the persistent marker.
    await deleteLocalAccountFiles(scope);
    await deleteLocalAccountData({
      userId: input.userId,
      workspaceIds: scope.workspaceIds,
      sessionIds: scope.sessionIds,
    });
    await clearPersonalWorkspaceCache(input.userId);

    return scope;
  } catch (cause) {
    throw new AppError(
      ErrorCode.ACCOUNT_DELETION_LOCAL_CLEANUP_FAILED,
      "Local account data could not be fully removed.",
      cause,
    );
  }
};
