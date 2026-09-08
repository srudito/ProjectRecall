import { presentTranscriptEditor, transcriptEditorErrorKey } from "@/src/services/transcription/editor-presentation";
import type { TranscriptEditorControllerSnapshot, TranscriptEditorSyncState } from "@/src/services/transcription/editor-types";
import en from "@/src/i18n/en/session.json";
import id from "@/src/i18n/id/session.json";

const snapshot = (): TranscriptEditorControllerSnapshot => ({
  scope: { userId: "user", workspaceId: "workspace", sessionId: "session" },
  phase: "ready", text: "Edited", currentText: "Original", baseVersionId: "base", currentVersionId: "base",
  revision: 1, durableRevision: 1, localState: "saved", syncState: "none", operationId: null,
  staleBase: false, draftConflict: false, canSave: true, busy: false,
  hasFrozenSave: false, frozenSaveMatchesText: false, errorCode: null,
});
const at = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((value, key) =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, obj);
const leaves = (obj: unknown, prefix = ""): string[] => Object.entries(obj as Record<string, unknown>)
  .flatMap(([key, value]) => typeof value === "string" ? [prefix + key] : leaves(value, `${prefix}${key}.`));
const statuses: TranscriptEditorSyncState[] = ["none", "queued", "submitting", "retry_wait", "auth_required", "feature_disabled",
  "conflict", "outcome_unconfirmed", "cancelled", "accepted_refresh_pending", "accepted_current", "accepted_other_current"];

describe("3D.3 editor presentation", () => {
  it("keeps a frozen Save retry distinct from a new Save and the newer draft", () => {
    const value = presentTranscriptEditor({ ...snapshot(), canSave: false, hasFrozenSave: true }, null, false);
    expect(value.canSave).toBe(false); expect(value.canRetryFrozen).toBe(true);
    expect(value.frozenKey).toBe("editor.frozenDifferent"); expect(value.canDiscard).toBe(false);
  });
  it("distinguishes same-text retry and never maps it to new Save availability", () => {
    expect(presentTranscriptEditor({ ...snapshot(), canSave: false, hasFrozenSave: true, frozenSaveMatchesText: true }, null, false))
      .toMatchObject({ canSave: false, canRetryFrozen: true, frozenKey: "editor.frozenSame" });
  });
  it.each(["queued", "submitting", "retry_wait", "auth_required", "feature_disabled", "outcome_unconfirmed"] as const)(
    "does not offer discard or frozen retry just because the outbox is %s", (syncState) => {
      const value = presentTranscriptEditor({ ...snapshot(), syncState, canSave: false }, null, false);
      expect(value.canDiscard).toBe(false); expect(value.canRetryFrozen).toBe(false);
    });
  it("distinguishes local, server, and stale-base conflicts", () => {
    expect(presentTranscriptEditor({ ...snapshot(), draftConflict: true, syncState: "conflict", staleBase: true }, null, false).conflictKey)
      .toBe("editor.localConflict");
    expect(presentTranscriptEditor({ ...snapshot(), syncState: "conflict", staleBase: true }, null, false).conflictKey)
      .toBe("editor.serverConflict");
    expect(presentTranscriptEditor({ ...snapshot(), staleBase: true }, null, false).conflictKey).toBe("editor.staleBase");
  });
  it("keeps later typing enabled during Save but not during close/discard", () => {
    expect(presentTranscriptEditor(snapshot(), "save", false)).toMatchObject({ canSave: false, canEdit: true });
    for (const action of ["close", "discard"]) expect(presentTranscriptEditor(snapshot(), action, false).canEdit).toBe(false);
  });
  it("permits exiting loading/unavailable without pretending to have saved a draft", () => {
    expect(presentTranscriptEditor(null, null, true)).toMatchObject({ canSave: false, canEdit: false, canClose: true });
    expect(presentTranscriptEditor({ ...snapshot(), phase: "unavailable" }, null, false)).toMatchObject({ canClose: true, canReload: true });
  });
  it("maps local storage retry separately and disables it for unknown draft replacement", () => {
    expect(presentTranscriptEditor({ ...snapshot(), localState: "storage_error" }, null, false).canFlush).toBe(true);
    expect(presentTranscriptEditor({ ...snapshot(), localState: "storage_error", draftConflict: true }, null, false).canFlush).toBe(false);
  });
  it.each(statuses)("has translated status text for %s without changing state", (syncState) => {
    const input = { ...snapshot(), syncState }; const before = JSON.stringify(input);
    const result = presentTranscriptEditor(input, null, false);
    for (const dictionary of [en, id]) expect(typeof at(dictionary, result.syncKey)).toBe("string");
    expect(JSON.stringify(input)).toBe(before);
  });
  it("has complete paired editor/evidence resources with matching placeholders", () => {
    expect(leaves(en.editor).sort()).toEqual(leaves(id.editor).sort());
    for (const key of leaves(en.editor)) {
      const english = String(at(en.editor, key)); const indonesian = String(at(id.editor, key));
      expect(indonesian.length).toBeGreaterThan(0);
      expect(english.match(/%\{[^}]+\}/g) ?? []).toEqual(indonesian.match(/%\{[^}]+\}/g) ?? []);
    }
    for (const key of ["editedMetadata", "evidenceProvenance", "evidenceUnavailable", "evidenceNone"]) {
      expect(typeof at(en.transcript, key)).toBe("string"); expect(typeof at(id.transcript, key)).toBe("string");
    }
  });
  it("never exposes arbitrary transport/database errors or object-prototype properties", () => {
    for (const code of [undefined, null, "SQL containing confidential text", "__proto__", "constructor", {}]) {
      expect(transcriptEditorErrorKey(code)).toBe("editor.errors.unknown");
    }
    expect(transcriptEditorErrorKey("EDITOR_LOCAL_STORAGE_FAILED")).toBe("editor.errors.storage");
    expect(transcriptEditorErrorKey("EDITOR_DRAFT_CHANGED")).toBe("editor.errors.draftChanged");
  });
});
