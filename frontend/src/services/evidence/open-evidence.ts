import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import * as WebBrowser from "expo-web-browser";
import { Linking, Platform } from "react-native";

export type EvidenceOpenErrorCode =
  | "EVIDENCE_NOT_AVAILABLE_OFFLINE"
  | "EVIDENCE_VIEWER_UNAVAILABLE"
  | "EVIDENCE_OPEN_FAILED";

export class EvidenceOpenError extends Error {
  constructor(
    public readonly code: EvidenceOpenErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "EvidenceOpenError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }
}

const ANDROID_ACTION_VIEW = "android.intent.action.VIEW";
const FLAG_GRANT_READ_URI_PERMISSION = 1;

const sanitizeCacheFileName = (fileName: string): string => {
  const normalized = fileName
    .replace(/[\\/]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 180);

  return normalized.length > 0 ? normalized : "evidence.bin";
};

const evidenceOpenCacheDirectory = (): string => {
  if (!FileSystem.cacheDirectory) {
    throw new EvidenceOpenError(
      "EVIDENCE_OPEN_FAILED",
      "Temporary evidence storage is unavailable.",
    );
  }

  return `${FileSystem.cacheDirectory}evidence-open/`;
};

const ensureReadableLocalFile = async (input: {
  uri: string;
  assetId: string;
  fileName: string;
}): Promise<string> => {
  if (input.uri.startsWith("file://")) {
    const info = await FileSystem.getInfoAsync(input.uri);
    if (info.exists) return input.uri;

    throw new EvidenceOpenError(
      "EVIDENCE_NOT_AVAILABLE_OFFLINE",
      "The local evidence file is no longer available.",
    );
  }

  if (input.uri.startsWith("content://")) {
    return input.uri;
  }

  if (!/^https?:/i.test(input.uri)) {
    throw new EvidenceOpenError(
      "EVIDENCE_OPEN_FAILED",
      "The evidence URI is not supported.",
    );
  }

  const directory = evidenceOpenCacheDirectory();
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });

  const targetUri = `${directory}${input.assetId}_${sanitizeCacheFileName(
    input.fileName,
  )}`;

  const existing = await FileSystem.getInfoAsync(targetUri);
  if (existing.exists) {
    return targetUri;
  }

  try {
    const result = await FileSystem.downloadAsync(input.uri, targetUri);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Download returned HTTP ${result.status}`);
    }
    return result.uri;
  } catch (cause) {
    await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(
      () => {},
    );
    throw new EvidenceOpenError(
      "EVIDENCE_NOT_AVAILABLE_OFFLINE",
      "Connect to the internet once to download this evidence file.",
      { cause },
    );
  }
};

const openOnAndroid = async (input: {
  uri: string;
  assetId: string;
  fileName: string;
  mimeType: string;
}): Promise<void> => {
  const localUri = await ensureReadableLocalFile(input);
  const contentUri = localUri.startsWith("content://")
    ? localUri
    : await FileSystem.getContentUriAsync(localUri);

  try {
    await IntentLauncher.startActivityAsync(ANDROID_ACTION_VIEW, {
      data: contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
      type: input.mimeType || "application/octet-stream",
    });
  } catch (cause) {
    throw new EvidenceOpenError(
      "EVIDENCE_VIEWER_UNAVAILABLE",
      "No compatible application could open this evidence file.",
      { cause },
    );
  }
};

export const openEvidenceAsset = async (input: {
  uri: string;
  assetId: string;
  fileName: string;
  mimeType: string;
}): Promise<void> => {
  if (Platform.OS === "android") {
    await openOnAndroid(input);
    return;
  }

  if (/^https?:/i.test(input.uri)) {
    await WebBrowser.openBrowserAsync(input.uri);
    return;
  }

  const supported = await Linking.canOpenURL(input.uri);
  if (!supported) {
    throw new EvidenceOpenError(
      "EVIDENCE_VIEWER_UNAVAILABLE",
      "No compatible application could open this evidence file.",
    );
  }

  try {
    await Linking.openURL(input.uri);
  } catch (cause) {
    throw new EvidenceOpenError(
      "EVIDENCE_OPEN_FAILED",
      "The evidence file could not be opened.",
      { cause },
    );
  }
};
