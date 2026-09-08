import React, { act } from "react";
import { Alert } from "react-native";
import { TranscriptEditorModal } from "@/src/components/TranscriptEditorModal";
import type { useTranscriptEditor, EditorUiResult } from "@/src/hooks/use-transcript-editor";
import type { TranscriptEditorControllerSnapshot } from "@/src/services/transcription/editor-types";

type TestNode = {
  props: { [key: string]: unknown; onPress: () => void; onRequestClose: () => void; onChangeText: (s: string) => void };
  findByProps: (props: object) => TestNode;
  findAllByProps: (props: object) => TestNode[];
};
type Tree = { root: TestNode; update: (node: React.ReactNode) => void; unmount: () => void };
const { create } = jest.requireActual<{ create: (node: React.ReactNode) => Tree }>("react-test-renderer");
jest.mock("react-native", () => ({
  Alert: { alert: jest.fn() }, Platform: { OS: "android" }, Modal: "Modal", Text: "Text", TextInput: "TextInput",
  View: "View", ScrollView: "ScrollView", KeyboardAvoidingView: "KeyboardAvoidingView",
}));
jest.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
jest.mock("@/src/components/Button", () => ({ Button: "Button" }));
jest.mock("@/src/i18n/I18nProvider", () => ({ useI18n: () => ({ t: (_ns: string, key: string) => key }) }));
jest.mock("@/src/theme/ThemeProvider", () => ({ useTheme: () => ({
  colors: { background: "white", textPrimary: "black", textSecondary: "gray", border: "gray", recording: "red", warning: "orange", surface: "white" },
  spacing: { md: 16, sm: 8, xs: 4 }, radii: { md: 8 }, typography: { body: {}, title: {}, caption: {} },
}) }));
let mockEditor: ReturnType<typeof useTranscriptEditor>;
jest.mock("@/src/hooks/use-transcript-editor", () => ({ useTranscriptEditor: () => mockEditor }));
const scope = { userId: "user", workspaceId: "workspace", sessionId: "session" };
const ready = (): TranscriptEditorControllerSnapshot => ({
  scope, phase: "ready", text: "  Bahasa Indonesia / English\n", currentText: "Original", baseVersionId: "base", currentVersionId: "base",
  revision: 2, durableRevision: 2, localState: "saved", syncState: "none", operationId: null,
  staleBase: false, draftConflict: false, canSave: true, busy: false, hasFrozenSave: false, frozenSaveMatchesText: false, errorCode: null,
});
let tree: Tree | null = null;
let closed: jest.Mock;
const mount = async () => { await act(async () => { tree = create(<TranscriptEditorModal scope={scope} onClosed={closed} />); }); };
const node = (testID: string) => tree!.root.findByProps({ testID });
const exists = (testID: string) => tree!.root.findAllByProps({ testID }).length > 0;
const press = async (testID: string) => { await act(async () => { node(testID).props.onPress(); }); };
const acceptLastDialog = async () => {
  const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2] as { onPress?: () => void }[];
  await act(async () => { buttons[1].onPress?.(); });
};
const update = async () => { await act(async () => { tree!.update(<TranscriptEditorModal scope={scope} onClosed={closed} />); }); };
beforeEach(() => {
  jest.clearAllMocks(); closed = jest.fn();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const success = jest.fn(async () => ({ ok: true as const }));
  mockEditor = { snapshot: ready(), loading: false, action: null, errorCode: null, setText: jest.fn(),
    save: success, flush: jest.fn(async () => ({ ok: true as const })), discard: jest.fn(async () => ({ ok: true as const })),
    reload: jest.fn(async () => ({ ok: true as const })), requestLatest: jest.fn(),
    close: jest.fn(async () => ({ ok: true as const })), abandon: jest.fn(async () => ({ ok: true as const })),
  };
});
afterEach(async () => { await act(async () => { tree?.unmount(); tree = null; }); });

describe("3D.3 rendered transcript editor modal", () => {
  it("uses exact controlled text, permits an empty draft, and does not truncate by character count", async () => {
    await mount(); expect(node("transcript-editor-input").props.value).toBe("  Bahasa Indonesia / English\n");
    expect(node("transcript-editor-input").props.maxLength).toBeUndefined();
    await act(async () => { node("transcript-editor-input").props.onChangeText(""); });
    expect(mockEditor.setText).toHaveBeenCalledWith(""); expect(mockEditor.save).not.toHaveBeenCalled();
  });
  it("queues Save without automatically closing, deleting a draft, or replacing text", async () => {
    await mount(); await press("transcript-editor-save");
    expect(mockEditor.save).toHaveBeenCalledTimes(1); expect(closed).not.toHaveBeenCalled();
    expect(mockEditor.close).not.toHaveBeenCalled(); expect(mockEditor.discard).not.toHaveBeenCalled();
  });
  it("routes Android Back and the Close button through the same handler", async () => {
    await mount(); expect(node("transcript-editor-modal").props.onRequestClose).toBe(node("transcript-editor-close").props.onPress);
    await act(async () => { node("transcript-editor-modal").props.onRequestClose(); });
    expect(mockEditor.close).toHaveBeenCalledTimes(1); expect(closed).toHaveBeenCalledTimes(1);
  });
  it("waits for close durability before dismissing the modal", async () => {
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    mockEditor.close = jest.fn(async (): Promise<EditorUiResult> => { await blocked; return { ok: true }; });
    await mount(); await press("transcript-editor-close"); expect(closed).not.toHaveBeenCalled();
    await act(async () => { release(); }); expect(closed).toHaveBeenCalledTimes(1);
  });
  it("keeps failed-close text and asks explicit permission before abandoning only the open buffer", async () => {
    mockEditor.close = jest.fn(async (): Promise<EditorUiResult> => ({ ok: false, code: "EDITOR_LOCAL_STORAGE_FAILED" }));
    await mount(); await press("transcript-editor-close");
    expect(closed).not.toHaveBeenCalled(); expect(node("transcript-editor-input").props.value).toBe(ready().text);
    expect(Alert.alert).toHaveBeenCalledWith("editor.closeFailedTitle", "editor.closeFailedBody", expect.any(Array), expect.any(Object));
    await acceptLastDialog(); expect(mockEditor.abandon).toHaveBeenCalledWith(2);
    expect(mockEditor.discard).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledTimes(1);
  });
  it("does not abandon newer typing when an old leave confirmation is rejected", async () => {
    mockEditor.close = jest.fn(async (): Promise<EditorUiResult> => ({ ok: false, code: "EDITOR_LOCAL_STORAGE_FAILED" }));
    mockEditor.abandon = jest.fn(async (): Promise<EditorUiResult> => ({ ok: false, code: "EDITOR_DRAFT_CHANGED" }));
    await mount(); await press("transcript-editor-close"); await acceptLastDialog(); expect(closed).not.toHaveBeenCalled();
  });
  it("passes the revision from the moment discard confirmation opened", async () => {
    await mount(); await press("transcript-editor-discard");
    mockEditor = { ...mockEditor, snapshot: { ...ready(), revision: 3, text: "Later" } }; await update();
    await acceptLastDialog(); expect(mockEditor.discard).toHaveBeenCalledWith(2);
  });
  it("does not let stale Alert callbacks act after unmount", async () => {
    await mount(); await press("transcript-editor-discard");
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as { onPress?: () => void }[];
    await act(async () => { tree!.unmount(); tree = null; }); await act(async () => { buttons[1].onPress?.(); });
    expect(mockEditor.discard).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
  });
  it("offers frozen-Save retry separately and explains a different textbox payload", async () => {
    mockEditor.snapshot = { ...ready(), hasFrozenSave: true, frozenSaveMatchesText: false, canSave: false };
    await mount(); expect(node("transcript-editor-save").props.disabled).toBe(true);
    expect(node("transcript-editor-frozen").props.children).toBe("editor.frozenDifferent");
    await press("transcript-editor-retry-save"); expect(mockEditor.save).toHaveBeenCalledTimes(1);
    await press("transcript-editor-close"); expect(mockEditor.close).not.toHaveBeenCalled();
    await acceptLastDialog(); expect(mockEditor.close).toHaveBeenCalledTimes(1);
  });
  it("retrying draft storage does not invoke Save", async () => {
    mockEditor.snapshot = { ...ready(), localState: "storage_error" };
    await mount(); await press("transcript-editor-flush"); expect(mockEditor.flush).toHaveBeenCalledTimes(1);
    expect(mockEditor.save).not.toHaveBeenCalled();
  });
  it("shows local current text separately without replacing the editing buffer", async () => {
    mockEditor.snapshot = { ...ready(), currentText: "Remote cache", staleBase: true, canSave: false };
    await mount(); await press("transcript-editor-toggle-current");
    expect(node("transcript-editor-current-text").props.children).toBe("Remote cache");
    expect(node("transcript-editor-input").props.value).toBe(ready().text);
    await press("transcript-editor-request-latest"); expect(mockEditor.requestLatest).toHaveBeenCalledTimes(1);
    expect(mockEditor.setText).not.toHaveBeenCalled();
  });
  it.each(["conflict", "accepted_refresh_pending", "outcome_unconfirmed"] as const)("presents %s without declaring a new Save success", async (syncState) => {
    mockEditor.snapshot = { ...ready(), syncState, canSave: false };
    await mount(); expect(node("transcript-editor-sync-status").props.children).toBe(`editor.sync.${syncState}`);
    expect(node("transcript-editor-save").props.disabled).toBe(true);
  });
  it("can leave loading or unavailable screens without requiring editable text", async () => {
    mockEditor.snapshot = null; mockEditor.loading = true;
    await mount(); expect(exists("transcript-editor-input")).toBe(false);
    await press("transcript-editor-close"); expect(closed).toHaveBeenCalledTimes(1);
  });
  it("closes a scrubbed invalidated owner once and does not render private text", async () => {
    mockEditor.snapshot = { ...ready(), phase: "invalidated", text: "" };
    await mount(); expect(exists("transcript-editor-input")).toBe(false); expect(closed).toHaveBeenCalledTimes(1);
    await update(); expect(closed).toHaveBeenCalledTimes(1);
  });
  it("keeps newer typing enabled while Save is pending, but disables close", async () => {
    mockEditor.action = "save"; mockEditor.snapshot = { ...ready(), busy: true };
    await mount(); expect(node("transcript-editor-input").props.editable).toBe(true);
    expect(node("transcript-editor-close").props.disabled).toBe(true);
  });
});
