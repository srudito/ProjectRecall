import React, { act } from "react";
import { SessionTranscriptPanel } from "@/src/components/SessionTranscriptPanel";
import { loadLocalTranscriptReadModelWithEvidence, type LocalTranscriptReadModelWithEvidence } from "@/src/services/transcription/read-model";

type TestNode = {
  props: { [key: string]: unknown; onPress: () => void };
  findByProps: (props: object) => TestNode;
  findAllByProps: (props: object) => TestNode[];
};
type Tree = { root: TestNode; update: (node: React.ReactNode) => void; unmount: () => void };
const { create } = jest.requireActual<{ create: (node: React.ReactNode) => Tree }>("react-test-renderer");
jest.mock("react-native", () => ({ Text: "Text", View: "View", TouchableOpacity: "TouchableOpacity" }));
jest.mock("@/src/components/Button", () => ({ Button: "Button" }));
jest.mock("@/src/components/Card", () => ({ Card: "Card" }));
const mockTranslate = (_ns: string, key: string, options?: object) => key + (options ? ` ${JSON.stringify(options)}` : "");
jest.mock("@/src/i18n/I18nProvider", () => ({ useI18n: () => ({ t: mockTranslate }) }));
jest.mock("@/src/theme/ThemeProvider", () => ({ useTheme: () => ({
  colors: {}, spacing: { md: 16, sm: 8, xs: 4, xxs: 2 }, radii: { md: 8 }, typography: { body: {}, caption: {} }, layout: { minTouchTarget: 44 },
}) }));
const mockListeners = new Set<() => void>();
jest.mock("@/src/services/sync/transcription-sync-events", () => ({ subscribeTranscriptionSyncChanges: (listener: () => void) => {
  mockListeners.add(listener); return () => { mockListeners.delete(listener); };
} }));
jest.mock("@/src/services/transcription/read-model", () => ({ loadLocalTranscriptReadModelWithEvidence: jest.fn() }));
const loader = loadLocalTranscriptReadModelWithEvidence as jest.MockedFunction<typeof loadLocalTranscriptReadModelWithEvidence>;
type Ready = Extract<LocalTranscriptReadModelWithEvidence, { kind: "ready" }>;
const ready = (count = 2): Ready => {
  const version: Ready["version"] = { id: "provider", workspace_id: "workspace", session_id: "session", transcription_run_id: "run",
    created_by: null, version: 1, version_origin: "provider", version_status: "final", is_current: true,
    parent_version_id: null, plain_text: "Full text", language_summary: {}, content_checksum_sha256: null, created_at: "now", updated_at: "now" };
  const segmentRows = Array.from({ length: count }, (_, segmentIndex) => ({ id: `segment-${segmentIndex}`, segmentIndex,
    startMs: segmentIndex * 1000, endMs: (segmentIndex + 1) * 1000, timestampLabel: `Time ${segmentIndex}`, text: `Original segment ${segmentIndex}`,
    languageCode: "id", speakerLabel: "A" }));
  return { kind: "ready", version, plainText: "Full text", rawPlainText: "Full text", segmentRows, segmentCount: count,
    evidence: { kind: "available", source: "current", version, segmentRows, segmentCount: count } };
};
const edited = (): Ready => {
  const model = ready();
  return { ...model, version: { ...model.version, id: "edit", version: 3, version_origin: "user_edit", parent_version_id: "parent" },
    plainText: "Edited full text", rawPlainText: "Edited full text", segmentRows: [], segmentCount: 0,
    evidence: { kind: "available", source: "ancestor", version: { ...model.version, is_current: false },
      segmentRows: model.segmentRows, segmentCount: model.segmentCount } };
};
let tree: Tree | null = null;
const node = (testID: string) => tree!.root.findByProps({ testID });
const has = (testID: string) => tree!.root.findAllByProps({ testID }).length > 0;
const mount = async (onEdit?: () => void) => { await act(async () => {
  tree = create(<SessionTranscriptPanel sessionId="session" workspaceId="workspace" onEdit={onEdit} />);
}); };
const event = async () => { await act(async () => { for (const listener of mockListeners) listener(); }); };
const press = async (testID: string) => { await act(async () => { node(testID).props.onPress(); }); };
beforeEach(() => {
  jest.clearAllMocks(); mockListeners.clear(); loader.mockResolvedValue(ready());
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => { await act(async () => { tree?.unmount(); tree = null; }); });

describe("3D.3 rendered evidence-aware transcript reader", () => {
  it("retains selectable full text, original timestamps and reader controls for provider current", async () => {
    await mount(); expect(node("session-transcript-text").props.children).toBe("Full text");
    expect(node("session-transcript-text").props.selectable).toBe(true);
    await press("session-transcript-view-segments");
    expect(node("session-transcript-segment-time-0").props.children).toBe("Time 0");
    expect(node("session-transcript-segment-text-0").props.children).toBe("Original segment 0");
  });
  it("shows edited full text but explicitly labelled provider evidence and its own count", async () => {
    loader.mockResolvedValue(edited()); await mount();
    expect(node("session-transcript-text").props.children).toBe("Edited full text");
    expect(String(node("session-transcript-metadata").props.children)).toContain('"count":2');
    expect(String(node("session-transcript-evidence-provenance").props.children)).toContain('"sourceVersion":1');
    await press("session-transcript-view-segments"); expect(node("session-transcript-segment-text-1").props.children).toBe("Original segment 1");
  });
  it.each(["parent_missing", "invalid_cache", "depth_limit", "read_failed"] as const)("keeps Full Text readable while %s evidence fails closed", async (reason) => {
    loader.mockResolvedValue({ ...edited(), evidence: { kind: "unavailable", reason } }); await mount();
    expect(node("session-transcript-text").props.children).toBe("Edited full text");
    await press("session-transcript-view-segments");
    expect(node("session-transcript-segments-empty").props.children).toBe("transcript.evidenceUnavailable");
    expect(has("session-transcript-segment-list")).toBe(false);
  });
  it("distinguishes no evidence from verified evidence with zero segments", async () => {
    loader.mockResolvedValue({ ...edited(), evidence: { kind: "none" } }); await mount(); await press("session-transcript-view-segments");
    expect(node("session-transcript-segments-empty").props.children).toBe("transcript.evidenceNone");
    loader.mockResolvedValue(ready(0)); await event();
    expect(node("session-transcript-segments-empty").props.children).toBe("transcript.noTimestampedSegments");
  });
  it("preserves batch-100 rendering and Show more", async () => {
    loader.mockResolvedValue(ready(101)); await mount(); await press("session-transcript-view-segments");
    expect(has("session-transcript-segment-99")).toBe(true); expect(has("session-transcript-segment-100")).toBe(false);
    await press("session-transcript-show-more"); expect(has("session-transcript-segment-100")).toBe(true);
    expect(has("session-transcript-show-more")).toBe(false);
  });
  it("offers explicit draft recovery even if the reader is empty", async () => {
    loader.mockResolvedValue({ kind: "empty" }); const edit = jest.fn(); await mount(edit);
    await press("session-transcript-edit"); expect(edit).toHaveBeenCalledTimes(1); expect(loader).toHaveBeenCalledTimes(1);
  });
  it("retains cached text on refresh failure", async () => {
    await mount(); loader.mockRejectedValue(new Error("Private database diagnostic")); await event();
    expect(node("session-transcript-text").props.children).toBe("Full text");
    expect(node("session-transcript-refresh-error").props.children).toBe("transcript.loadFailed");
  });
  it("rejects another workspace before showing private text", async () => {
    const model = ready(); loader.mockResolvedValue({ ...model, version: { ...model.version, workspace_id: "other" } });
    await mount(); expect(has("session-transcript-text")).toBe(false); expect(has("session-transcript-error")).toBe(true);
  });
  it("ignores older in-flight refreshes and removes the listener on unmount", async () => {
    await mount(); let resolve!: (model: LocalTranscriptReadModelWithEvidence) => void;
    loader.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await event(); loader.mockResolvedValue(edited()); await event();
    await act(async () => { resolve(ready()); });
    expect(node("session-transcript-text").props.children).toBe("Edited full text");
    await act(async () => { tree!.unmount(); tree = null; }); expect(mockListeners.size).toBe(0);
  });
});
