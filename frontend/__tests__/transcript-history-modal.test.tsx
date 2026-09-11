import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "react";
import { Alert } from "react-native";

import {
  TranscriptHistoryModal,
  historyRestoreErrorKey,
  mergeTranscriptHistoryItems,
} from "@/src/components/TranscriptHistoryModal";
import { fetchTranscriptHistoryPage } from "@/src/services/transcription/history-client";
import type {
  TranscriptHistoryCloudPage,
  TranscriptHistoryCloudSummary,
} from "@/src/services/transcription/history-cloud-types";
import { createLocalTranscriptHistoryReader } from "@/src/services/transcription/history-read-model";
import { prepareTranscriptHistoryRestoreDraft } from "@/src/services/transcription/history-restore-service";
import {
  TranscriptHistoryRestoreError,
  type TranscriptHistoryRestoreDraftResult,
} from "@/src/services/transcription/history-restore-types";
import { historyCacheResult } from "@/src/services/transcription/history-cache-types";
import type {
  LocalTranscriptHistoryPage,
  LocalTranscriptHistoryVersion,
  TranscriptHistoryVersionSummary,
} from "@/src/services/transcription/history-types";

type TestNode = {
  props: {
    [key: string]: unknown;
    onPress: () => void;
    onRequestClose: () => void;
  };
  findByProps: (props: object) => TestNode;
  findAllByProps: (props: object) => TestNode[];
};
type Tree = { root: TestNode; unmount: () => void };
const { create } = jest.requireActual<{
  create: (node: React.ReactNode) => Tree;
}>("react-test-renderer");

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: jest.fn(),
}));
jest.mock("react-native", () => ({
  Alert: { alert: jest.fn() },
  Modal: "Modal",
  ScrollView: "ScrollView",
  Text: "Text",
  TouchableOpacity: "TouchableOpacity",
  View: "View",
}));
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: "SafeAreaView",
}));
jest.mock("@/src/components/Button", () => ({ Button: "Button" }));
jest.mock("@/src/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (_namespace: string, key: string, options?: object) =>
      key + (options ? ` ${JSON.stringify(options)}` : ""),
  }),
}));
jest.mock("@/src/theme/ThemeProvider", () => ({
  useTheme: () => ({
    colors: {
      accent: "accent",
      background: "background",
      border: "border",
      recording: "recording",
      surface: "surface",
      textPrimary: "textPrimary",
      textSecondary: "textSecondary",
      warning: "warning",
    },
    spacing: { md: 16, sm: 8, xs: 4 },
    radii: { md: 8 },
    typography: { body: {}, bodyMedium: {}, caption: {}, headline: {}, title: {} },
    layout: { minTouchTarget: 44 },
  }),
}));
jest.mock("@/src/services/transcription/history-client", () => ({
  fetchTranscriptHistoryPage: jest.fn(),
}));
jest.mock("@/src/services/transcription/history-read-model", () => ({
  createLocalTranscriptHistoryReader: jest.fn(),
}));
jest.mock("@/src/services/transcription/history-restore-service", () => ({
  prepareTranscriptHistoryRestoreDraft: jest.fn(),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_1 = "44444444-4444-4444-8444-444444444441";
const VERSION_2 = "44444444-4444-4444-8444-444444444442";
const VERSION_3 = "44444444-4444-4444-8444-444444444443";
const scope = {
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
};
const idFor = (version: number): string =>
  ({ 1: VERSION_1, 2: VERSION_2, 3: VERSION_3 })[version as 1 | 2 | 3];
const localSummary = (version: number): TranscriptHistoryVersionSummary => ({
  id: idFor(version),
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  version,
  version_origin: version === 1 ? "provider" : "user_edit",
  version_status: "final",
  parent_version_id: version === 1 ? null : idFor(version - 1),
  created_by: USER_ID,
  transcription_run_id: version === 1 ? VERSION_3 : null,
  content_checksum_sha256: "a".repeat(64),
  created_at: "2026-09-10T00:00:00.000Z",
  is_current: version === 3,
});
const cloudSummary = (version: number): TranscriptHistoryCloudSummary => ({
  ...localSummary(version),
  updated_at: "2026-09-10T00:00:01.000Z",
});
const localPage = (
  versions: TranscriptHistoryVersionSummary[],
  beforeVersion: number | null = null,
): LocalTranscriptHistoryPage => ({
  scope: { ...scope },
  availability: "local_cache_only",
  versions,
  windowUpperVersion: versions[0]?.version ?? null,
  nextCursor: beforeVersion === null
    ? null
    : { scope: { ...scope }, upperVersion: 3, beforeVersion },
});
const cloudPage = (
  versions: TranscriptHistoryCloudSummary[],
  beforeVersion: number | null = null,
  exhausted = false,
): TranscriptHistoryCloudPage => ({
  source: "supabase_history_v1",
  scope: { ...scope },
  versions,
  windowUpperVersion: versions[0]?.version ?? null,
  nextCursor: beforeVersion === null
    ? null
    : {
        source: "supabase_history_v1",
        scope: { ...scope },
        upperVersion: 3,
        beforeVersion,
      },
  visibleWindowExhausted: exhausted,
});
const ready = (version = 2): LocalTranscriptHistoryVersion => ({
  kind: "ready",
  availability: "local_cache_only",
  scope: { ...scope },
  version: localSummary(version),
  rawPlainText: "  exact historical text  ",
});
const missing = (version = 2): LocalTranscriptHistoryVersion => ({
  kind: "not_cached",
  availability: "local_cache_only",
  scope: { ...scope },
  versionId: idFor(version),
});
const restoreResult = (): TranscriptHistoryRestoreDraftResult => ({
  kind: "draft_created",
  sourceVersionId: VERSION_2,
  baseVersionId: VERSION_3,
  draft: {
    user_id: USER_ID,
    workspace_id: WORKSPACE_ID,
    session_id: SESSION_ID,
    base_version_id: VERSION_3,
    plain_text: "  exact historical text  ",
    created_at: "2026-09-10T00:00:02.000Z",
    updated_at: "2026-09-10T00:00:02.000Z",
  },
});
const flush = async (): Promise<void> => {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const cloud = fetchTranscriptHistoryPage as jest.MockedFunction<
  typeof fetchTranscriptHistoryPage
>;
const createReader = createLocalTranscriptHistoryReader as jest.MockedFunction<
  typeof createLocalTranscriptHistoryReader
>;
const prepareRestore = prepareTranscriptHistoryRestoreDraft as jest.MockedFunction<
  typeof prepareTranscriptHistoryRestoreDraft
>;
const nativeAlert = Alert.alert as jest.MockedFunction<typeof Alert.alert>;
let listPage: jest.Mock;
let hydrateVersion: jest.Mock;
let dispose: jest.Mock;
let tree: Tree | null = null;
let closed: jest.Mock;
let restored: jest.Mock;

const mount = async (restoreEnabled = true): Promise<void> => {
  await act(async () => {
    tree = create(
      <TranscriptHistoryModal
        scope={scope}
        onClosed={closed}
        onRestoreDraftPrepared={restoreEnabled ? restored : undefined}
      />,
    );
    await flush();
  });
};
const node = (testID: string): TestNode => tree!.root.findByProps({ testID });
const has = (testID: string): boolean =>
  tree!.root.findAllByProps({ testID }).length > 0;
const press = async (testID: string): Promise<void> => {
  await act(async () => {
    node(testID).props.onPress();
    await flush();
  });
};
const confirmRestore = async (): Promise<void> => {
  const buttons = nativeAlert.mock.calls.at(-1)?.[2];
  const confirm = Array.isArray(buttons) ? buttons[1] : undefined;
  if (!confirm?.onPress) throw new Error("Missing restore confirmation action");
  await act(async () => {
    confirm.onPress?.();
    await flush();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  closed = jest.fn();
  restored = jest.fn();
  dispose = jest.fn();
  listPage = jest.fn(async () => localPage([localSummary(2)]));
  hydrateVersion = jest.fn(async () => ({ detail: ready(2), cacheResult: null }));
  createReader.mockReturnValue({
    scope,
    dispose,
    listPage,
    loadVersion: jest.fn(),
    hydrateVersion,
  } as never);
  cloud.mockResolvedValue(cloudPage([cloudSummary(3), cloudSummary(2)]));
  prepareRestore.mockResolvedValue(restoreResult());
});
afterEach(async () => {
  await act(async () => {
    tree?.unmount();
    tree = null;
    await flush();
  });
});

describe("C2E/C2F.2 explicit transcript history viewer", () => {
  it("prefers the local current observation and rejects conflicting version identities", () => {
    const cloudItems = mergeTranscriptHistoryItems(
      [],
      [cloudSummary(3)],
      "cloud",
      scope,
    );
    const localItems = mergeTranscriptHistoryItems(
      cloudItems,
      [{ ...localSummary(2), is_current: true }],
      "local",
      scope,
    );

    expect(localItems.filter((item) => item.isCurrent).map((item) => item.id))
      .toEqual([VERSION_2]);
    expect(() => mergeTranscriptHistoryItems(
      localItems,
      [{ ...cloudSummary(2), id: VERSION_3 }],
      "cloud",
      scope,
    )).toThrow();
  });

  it("merges local and cloud metadata without hydrating until selection", async () => {
    await mount();

    expect(has(`transcript-history-version-${VERSION_3}`)).toBe(true);
    expect(has(`transcript-history-version-${VERSION_2}`)).toBe(true);
    expect(
      node(`transcript-history-version-availability-${VERSION_3}`).props.children,
    ).toContain("history.availableCloud");
    expect(
      node(`transcript-history-version-availability-${VERSION_2}`).props.children,
    ).toContain("history.availableLocal");
    expect(hydrateVersion).not.toHaveBeenCalled();
    expect(cloud).toHaveBeenCalledTimes(1);
  });

  it("opens exact read-only Full Text through the on-demand hydration port", async () => {
    await mount();
    await press(`transcript-history-version-${VERSION_2}`);

    expect(hydrateVersion).toHaveBeenCalledWith(expect.objectContaining({
      versionId: VERSION_2,
      expectedVersion: 2,
      signal: expect.any(AbortSignal),
    }));
    expect(node("transcript-history-detail-text").props.children)
      .toBe("  exact historical text  ");
    expect(node("transcript-history-detail-text").props.selectable).toBe(true);
    expect(has("transcript-history-restore-draft")).toBe(true);
  });

  it("prepares one exact restore draft only after confirmation", async () => {
    const expected = restoreResult();
    prepareRestore.mockResolvedValueOnce(expected);
    await mount();
    await press(`transcript-history-version-${VERSION_2}`);

    await press("transcript-history-restore-draft");
    expect(prepareRestore).not.toHaveBeenCalled();
    expect(nativeAlert).toHaveBeenCalledTimes(1);

    await confirmRestore();

    expect(prepareRestore).toHaveBeenCalledTimes(1);
    expect(prepareRestore).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      sourceVersionId: VERSION_2,
      sourceVersionNumber: 2,
      sourcePlainText: "  exact historical text  ",
      sourceContentChecksumSha256: "a".repeat(64),
      assertActive: expect.any(Function),
    }));
    const guard = prepareRestore.mock.calls[0][0].assertActive;
    expect(restored).toHaveBeenCalledWith(expected);
    expect(closed).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => guard()).toThrow();
  });

  it("never offers restore for the current version or without an editor handoff", async () => {
    hydrateVersion.mockResolvedValueOnce({
      detail: ready(3),
      cacheResult: null,
    });
    await mount();
    await press(`transcript-history-version-${VERSION_3}`);
    expect(has("transcript-history-restore-draft")).toBe(false);

    await act(async () => {
      tree?.unmount();
      tree = null;
      await flush();
    });
    hydrateVersion.mockResolvedValueOnce({ detail: ready(2), cacheResult: null });
    await mount(false);
    await press(`transcript-history-version-${VERSION_2}`);
    expect(has("transcript-history-restore-draft")).toBe(false);
  });

  it("ignores a confirmation callback after the modal closes", async () => {
    await mount();
    await press(`transcript-history-version-${VERSION_2}`);
    await press("transcript-history-restore-draft");
    const buttons = nativeAlert.mock.calls.at(-1)?.[2];
    const confirm = Array.isArray(buttons) ? buttons[1] : undefined;
    if (!confirm?.onPress) throw new Error("Missing restore confirmation action");

    await press("transcript-history-close");
    await act(async () => {
      confirm.onPress?.();
      await flush();
    });

    expect(prepareRestore).not.toHaveBeenCalled();
    expect(restored).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("shows only a localized safe restore error and never retries automatically", async () => {
    prepareRestore.mockRejectedValueOnce(
      new TranscriptHistoryRestoreError("HISTORY_RESTORE_DRAFT_EXISTS"),
    );
    await mount();
    await press(`transcript-history-version-${VERSION_2}`);
    await press("transcript-history-restore-draft");
    await confirmRestore();

    expect(node("transcript-history-restore-error").props.children)
      .toBe("history.restore.errors.draftExists");
    expect(String(node("transcript-history-restore-error").props.children))
      .not.toContain("draft already exists");
    expect(prepareRestore).toHaveBeenCalledTimes(1);
    expect(restored).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(historyRestoreErrorKey("PRIVATE_CODE"))
      .toBe("history.restore.errors.unknown");
  });

  it("invalidates an in-flight restore when the modal closes", async () => {
    const gate = deferred<TranscriptHistoryRestoreDraftResult>();
    prepareRestore.mockImplementationOnce(async (input) => {
      input.assertActive();
      const value = await gate.promise;
      input.assertActive();
      return value;
    });
    await mount();
    await press(`transcript-history-version-${VERSION_2}`);
    await press("transcript-history-restore-draft");
    await confirmRestore();
    expect(prepareRestore).toHaveBeenCalledTimes(1);

    await press("transcript-history-close");
    gate.resolve(restoreResult());
    await act(async () => {
      await flush();
    });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(restored).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("shows one retryable miss and retries only after an explicit button press", async () => {
    hydrateVersion
      .mockResolvedValueOnce({
        detail: missing(3),
        cacheResult: historyCacheResult(
          "retryable",
          "HISTORY_CACHE_FETCH_RETRYABLE",
        ),
      })
      .mockResolvedValueOnce({
        detail: ready(3),
        cacheResult: historyCacheResult("committed"),
      });
    await mount();
    await press(`transcript-history-version-${VERSION_3}`);

    expect(node("transcript-history-detail-status").props.children)
      .toBe("history.retryable");
    expect(hydrateVersion).toHaveBeenCalledTimes(1);

    await press("transcript-history-retry-version");
    expect(hydrateVersion).toHaveBeenCalledTimes(2);
    expect(node("transcript-history-detail-text").props.children)
      .toBe("  exact historical text  ");
  });

  it("paginates local and cloud windows only after Show more", async () => {
    listPage
      .mockResolvedValueOnce(localPage([localSummary(3)], 3))
      .mockResolvedValueOnce(localPage([localSummary(1)]));
    cloud
      .mockResolvedValueOnce(cloudPage([cloudSummary(3), cloudSummary(2)], 2))
      .mockResolvedValueOnce(cloudPage([], null, true));
    await mount();

    expect(has(`transcript-history-version-${VERSION_1}`)).toBe(false);
    expect(listPage).toHaveBeenCalledTimes(1);
    expect(cloud).toHaveBeenCalledTimes(1);

    await press("transcript-history-load-more");
    expect(listPage).toHaveBeenCalledTimes(2);
    expect(cloud).toHaveBeenCalledTimes(2);
    expect(has(`transcript-history-version-${VERSION_1}`)).toBe(true);
  });

  it("keeps local versions visible when cloud metadata fails and retries explicitly", async () => {
    cloud.mockRejectedValueOnce(new Error("PRIVATE NETWORK DIAGNOSTIC"));
    await mount();

    expect(has(`transcript-history-version-${VERSION_2}`)).toBe(true);
    expect(node("transcript-history-cloud-error").props.children)
      .toBe("history.cloudUnavailable");
    expect(node("transcript-history-cloud-error").props.children)
      .not.toContain("PRIVATE NETWORK DIAGNOSTIC");

    cloud.mockResolvedValueOnce(cloudPage([cloudSummary(3)]));
    await press("transcript-history-retry-cloud");
    expect(cloud).toHaveBeenCalledTimes(2);
    expect(has(`transcript-history-version-${VERSION_3}`)).toBe(true);
  });

  it("aborts late work, disposes the reader, and closes once", async () => {
    const gate = deferred<TranscriptHistoryCloudPage>();
    cloud.mockReturnValueOnce(gate.promise);
    await mount();
    const signal = cloud.mock.calls[0][0].signal!;

    await press("transcript-history-close");

    expect(signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    gate.resolve(cloudPage([cloudSummary(3)]));
    await act(async () => {
      await flush();
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("keeps restore explicit and leaves coordinator and current ownership untouched", () => {
    const component = readFileSync(
      resolve(process.cwd(), "src/components/TranscriptHistoryModal.tsx"),
      "utf8",
    );
    const panel = readFileSync(
      resolve(process.cwd(), "src/components/SessionTranscriptPanel.tsx"),
      "utf8",
    );
    const coordinator = readFileSync(
      resolve(process.cwd(), "src/services/sync/ProjectSyncCoordinator.tsx"),
      "utf8",
    );

    expect(panel).toContain('testID="session-transcript-history"');
    expect(panel).toContain("<TranscriptHistoryModal");
    expect(component).toContain("reader.hydrateVersion(");
    expect(component).toContain("prepareTranscriptHistoryRestoreDraft({");
    expect(component).not.toContain("prepareGuardedTranscriptHistoryRestoreDraft");
    expect(component).not.toContain("persistPreparedTranscriptHistoryCache");
    expect(component).not.toContain("is_current = 1");
    expect(component).not.toContain("requestAllSync");
    expect(component).not.toContain("requestTranscriptEditSync");
    expect(coordinator).not.toContain("TranscriptHistoryModal");
    expect(coordinator).not.toContain("hydrateVersion");
  });
});
