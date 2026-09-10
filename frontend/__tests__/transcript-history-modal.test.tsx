import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "react";

import {
  TranscriptHistoryModal,
  mergeTranscriptHistoryItems,
} from "@/src/components/TranscriptHistoryModal";
import { fetchTranscriptHistoryPage } from "@/src/services/transcription/history-client";
import type {
  TranscriptHistoryCloudPage,
  TranscriptHistoryCloudSummary,
} from "@/src/services/transcription/history-cloud-types";
import { createLocalTranscriptHistoryReader } from "@/src/services/transcription/history-read-model";
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
let listPage: jest.Mock;
let hydrateVersion: jest.Mock;
let dispose: jest.Mock;
let tree: Tree | null = null;
let closed: jest.Mock;

const mount = async (): Promise<void> => {
  await act(async () => {
    tree = create(<TranscriptHistoryModal scope={scope} onClosed={closed} />);
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

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  closed = jest.fn();
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
});
afterEach(async () => {
  await act(async () => {
    tree?.unmount();
    tree = null;
    await flush();
  });
});

describe("C2E explicit transcript history viewer", () => {
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
    expect(has("transcript-history-restore")).toBe(false);
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

  it("keeps activation explicit and leaves coordinator, restore, and current ownership untouched", () => {
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
    expect(component).not.toContain("persistPreparedTranscriptHistoryCache");
    expect(component).not.toContain("is_current = 1");
    expect(component).not.toContain("requestAllSync");
    expect(coordinator).not.toContain("TranscriptHistoryModal");
    expect(coordinator).not.toContain("hydrateVersion");
  });
});
