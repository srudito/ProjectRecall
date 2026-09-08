import { createTranscriptEditorService, type TranscriptEditorServiceDependencies } from "@/src/services/transcription/editor-service";
import {
  MAX_TRANSCRIPT_EDITOR_BYTES,
  normalizeTranscriptEditorScope,
  transcriptEditorUuid,
  TranscriptEditorError,
  validateTranscriptEditorText,
  type TranscriptEditorContext,
  type TranscriptEditorDraftCommand,
  type TranscriptEditorLocalState,
  type TranscriptEditorSaveCommand,
  type TranscriptEditorSaveResult,
} from "@/src/services/transcription/editor-types";
import type { TranscriptEditDraftRow, TranscriptEditQueueRow } from "@/src/services/sqlite/repository";

jest.mock("@/src/services/sqlite/repository", () => ({
  loadTranscriptEditorState: jest.fn(), saveGuardedTranscriptEditDraft: jest.fn(),
  enqueueGuardedTranscriptEditSnapshot: jest.fn(), discardGuardedTranscriptEditDraft: jest.fn(),
}));
jest.mock("@/src/services/sync/transcript-edit-worker", () => ({ requestTranscriptEditSync: jest.fn() }));
jest.mock("@/src/services/sync/transcription-sync-events", () => ({ notifyTranscriptionSyncChanges: jest.fn() }));
jest.mock("@/src/services/account-deletion/state", () => ({ isAccountDeletionLocallyPending: jest.fn() }));
jest.mock("@/src/stores/auth-store", () => ({ useAuthStore: { getState: jest.fn(() => ({ user: null })) } }));

const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const BASE = "44444444-4444-4444-8444-444444444444";
const CLIENT = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-09-08T00:00:00.000Z";
const scope = { userId: USER, workspaceId: WORKSPACE, sessionId: SESSION };
const command = (): TranscriptEditorDraftCommand => ({ baseVersionId: BASE, plainText: "  Edited.\n", expectedDraft: null });
const draft: TranscriptEditDraftRow = { user_id: USER, workspace_id: WORKSPACE, session_id: SESSION,
  base_version_id: BASE, plain_text: "  Edited.\n", created_at: NOW, updated_at: NOW };
const queued: TranscriptEditQueueRow = { id: CLIENT, user_id: USER, workspace_id: WORKSPACE, session_id: SESSION,
  expected_current_version_id: BASE, plain_text: "  Edited.\n", queue_status: "pending", attempt_count: 0,
  max_attempts: 5, next_retry_at: null, last_error_code: null, last_safe_error: null, created_at: NOW, updated_at: NOW };

const dependencies = (overrides: Partial<TranscriptEditorServiceDependencies> = {}): TranscriptEditorServiceDependencies => ({
  platform: "android", getUserId: jest.fn(() => USER), isDeletionPending: jest.fn(() => false),
  isContextActive: jest.fn(() => true), createId: jest.fn(() => CLIENT),
  load: jest.fn(async (_input: TranscriptEditorContext): Promise<TranscriptEditorLocalState> =>
    ({ currentVersion: null, draft: null, baseVersion: null, queue: [] })),
  saveDraft: jest.fn(async (_input: TranscriptEditorContext & TranscriptEditorDraftCommand) => ({ ...draft })),
  enqueue: jest.fn(async (_input: TranscriptEditorContext & TranscriptEditorSaveCommand): Promise<TranscriptEditorSaveResult> =>
    ({ kind: "queued", operation: { ...queued }, draft: { ...draft } })),
  discard: jest.fn(async (_input: TranscriptEditorContext & { expectedDraft: Readonly<TranscriptEditDraftRow> | null }) => undefined),
  notifyChanged: jest.fn(), requestSync: jest.fn(), ...overrides,
});

describe("3D.2 local transcript editor service", () => {
  it("loads local state without generating an ID, notifying or requesting sync", async () => {
    const deps = dependencies();
    await createTranscriptEditorService(scope, deps).load();
    expect(deps.load).toHaveBeenCalledWith({ scope, assertActive: expect.any(Function) });
    expect(deps.createId).not.toHaveBeenCalled(); expect(deps.notifyChanged).not.toHaveBeenCalled();
    expect(deps.requestSync).not.toHaveBeenCalled();
  });

  it.each([
    ["web", "EDITOR_NATIVE_ONLY"], ["auth", "EDITOR_AUTH_REQUIRED"],
    ["deletion", "EDITOR_DELETION_PENDING"], ["context", "EDITOR_CONTEXT_INACTIVE"],
  ])("refuses persistence for %s", async (condition, code) => {
    const deps = dependencies({ platform: condition === "web" ? "web" : "android",
      getUserId: () => condition === "auth" ? null : USER,
      isDeletionPending: () => condition === "deletion", isContextActive: () => condition !== "context" });
    const service = createTranscriptEditorService(scope, deps);
    await expect(service.load()).rejects.toMatchObject({ code });
    await expect(service.saveDraft(command())).rejects.toMatchObject({ code });
    await expect(service.save(command())).rejects.toMatchObject({ code });
    await expect(service.discardDraft(null)).rejects.toMatchObject({ code });
    expect(deps.load).not.toHaveBeenCalled(); expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.saveDraft).not.toHaveBeenCalled(); expect(deps.discard).not.toHaveBeenCalled();
  });

  it("does not use an online preflight to persist a local draft", async () => {
    const deps = dependencies();
    await createTranscriptEditorService(scope, deps).saveDraft(command());
    expect(deps.saveDraft).toHaveBeenCalledWith({ ...command(), scope, assertActive: expect.any(Function) });
    expect(deps.requestSync).not.toHaveBeenCalled(); expect(deps.createId).not.toHaveBeenCalled();
  });

  it("waits for durable enqueue before notifying or waking the existing worker", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const deps = dependencies({ enqueue: jest.fn(async (_input): Promise<TranscriptEditorSaveResult> => {
      await blocked; return { kind: "queued", operation: queued, draft };
    }) });
    const pending = createTranscriptEditorService(scope, deps).save(command());
    expect(deps.requestSync).not.toHaveBeenCalled(); expect(deps.notifyChanged).not.toHaveBeenCalled();
    release();
    const result = await pending;
    expect(result.operation.id).toBe(CLIENT);
    expect(deps.createId).toHaveBeenCalledTimes(1); expect(deps.requestSync).toHaveBeenCalledTimes(1);
  });

  it("supports replaying an explicit stable ID without generating a replacement", async () => {
    const deps = dependencies();
    await createTranscriptEditorService(scope, deps).save({ ...command(), clientVersionId: CLIENT });
    expect(deps.createId).not.toHaveBeenCalled();
    expect(deps.enqueue).toHaveBeenCalledWith({ ...command(), clientVersionId: CLIENT, scope, assertActive: expect.any(Function) });
  });

  it("returns a recovered original operation ID rather than the new candidate ID", async () => {
    const originalId = "66666666-6666-4666-8666-666666666666";
    const deps = dependencies({ enqueue: jest.fn(async (_input): Promise<TranscriptEditorSaveResult> => ({
      kind: "existing", operation: { ...queued, id: originalId }, draft,
    })) });
    const result = await createTranscriptEditorService(scope, deps).save(command());
    expect(result.operation.id).toBe(originalId); expect(result.kind).toBe("existing");
  });

  it("freezes command values and draft expectation before asynchronous persistence", async () => {
    const deps = dependencies(); const mutableScope = { ...scope };
    const service = createTranscriptEditorService(mutableScope, deps);
    const expected = { ...draft }; const input = { ...command(), expectedDraft: expected };
    const pending = service.saveDraft(input);
    input.plainText = "different"; expected.plain_text = "changed"; mutableScope.sessionId = CLIENT;
    await pending;
    expect(deps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ scope,
      plainText: "  Edited.\n", expectedDraft: draft }));
  });

  it("does not let extra caller fields replace the identity guard or scope", async () => {
    const deps = dependencies(); const suppliedGuard = jest.fn();
    const input = { ...command(), scope: { ...scope, userId: CLIENT }, assertActive: suppliedGuard };
    await createTranscriptEditorService(scope, deps).saveDraft(input);
    const captured = (deps.saveDraft as jest.Mock).mock.calls[0][0] as TranscriptEditorContext;
    expect(captured.scope).toEqual(scope); expect(captured.assertActive).not.toBe(suppliedGuard);
  });

  it("rechecks current user through the repository transaction guard", async () => {
    let currentUser: string | null = USER;
    const deps = dependencies({ getUserId: () => currentUser,
      saveDraft: jest.fn(async (input) => {
        currentUser = CLIENT; input.assertActive(); return draft;
      }) });
    await expect(createTranscriptEditorService(scope, deps).saveDraft(command()))
      .rejects.toMatchObject({ code: "EDITOR_AUTH_REQUIRED" });
    expect(deps.notifyChanged).not.toHaveBeenCalled();
  });

  it("retains typed repository errors and hides arbitrary SQL/content diagnostics", async () => {
    const privateError = new Error("SQL failure containing confidential draft text");
    const deps = dependencies({ enqueue: jest.fn(async (_input) => { throw privateError; }) });
    const service = createTranscriptEditorService(scope, deps);
    await expect(service.save(command())).rejects.toMatchObject({ code: "EDITOR_LOCAL_STORAGE_FAILED" });
    await expect(service.save(command())).rejects.not.toThrow("confidential");
    expect(deps.requestSync).not.toHaveBeenCalled();
    const known = new TranscriptEditorError("EDITOR_DRAFT_CHANGED");
    const typed = dependencies({ saveDraft: jest.fn(async (_input) => { throw known; }) });
    await expect(createTranscriptEditorService(scope, typed).saveDraft(command())).rejects.toBe(known);
  });

  it("never turns notification or wake failure after commit into a failed Save", async () => {
    const deps = dependencies({ notifyChanged: () => { throw new Error("listener"); },
      requestSync: () => { throw new Error("wake"); } });
    await expect(createTranscriptEditorService(scope, deps).save(command()))
      .resolves.toMatchObject({ kind: "queued", operation: { id: CLIENT } });
  });

  it("does not notify the next account when identity changes after commit", async () => {
    let user = USER;
    const deps = dependencies({ getUserId: () => user,
      enqueue: jest.fn(async (_input): Promise<TranscriptEditorSaveResult> => {
        user = CLIENT; return { kind: "queued", operation: queued, draft };
      }) });
    await expect(createTranscriptEditorService(scope, deps).save(command())).resolves.toMatchObject({ kind: "queued" });
    expect(deps.requestSync).not.toHaveBeenCalled(); expect(deps.notifyChanged).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "conflict", "cancelled", "failed"] as const)("does not retry a terminal/exhausted %s replay", async (status) => {
    const deps = dependencies({ enqueue: jest.fn(async (_input): Promise<TranscriptEditorSaveResult> => ({
      kind: "existing", operation: { ...queued, queue_status: status, attempt_count: 5 }, draft,
    })) });
    await createTranscriptEditorService(scope, deps).save(command());
    expect(deps.requestSync).not.toHaveBeenCalled();
  });

  it("passes exact discard expectation and never wakes a remote cancellation", async () => {
    const deps = dependencies();
    await createTranscriptEditorService(scope, deps).discardDraft(draft);
    expect(deps.discard).toHaveBeenCalledWith({ scope, assertActive: expect.any(Function), expectedDraft: draft });
    expect(deps.requestSync).not.toHaveBeenCalled();
  });
});

describe("3D.2 editor text and identity validation", () => {
  it("normalizes UUID input without accepting malformed identities", () => {
    expect(transcriptEditorUuid("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"))
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(normalizeTranscriptEditorScope(scope)).toEqual(scope);
    expect(() => transcriptEditorUuid("not-a-uuid")).toThrow(TranscriptEditorError);
  });
  it("allows blank drafts but rejects a blank immutable save", () => {
    expect(() => validateTranscriptEditorText("", true)).not.toThrow();
    expect(() => validateTranscriptEditorText(" \n\t", false)).toThrow("must not be blank");
  });
  it("accepts exact boundary ASCII/Unicode byte sizes without stripping whitespace", () => {
    expect(() => validateTranscriptEditorText("a".repeat(MAX_TRANSCRIPT_EDITOR_BYTES), false)).not.toThrow();
    expect(() => validateTranscriptEditorText("\u{1f600}".repeat(MAX_TRANSCRIPT_EDITOR_BYTES / 4), false)).not.toThrow();
    const text = "  Bahasa Indonesia / English / \u4e2d\u6587 / \u{1f600}\n";
    expect(() => validateTranscriptEditorText(text, false)).not.toThrow();
    expect(text.startsWith("  ")).toBe(true);
  });
  it.each(["a", "\u00e9", "\u4e2d", "\u{1f600}"])("rejects an oversized UTF-8 payload (%s)", (character) => {
    const bytes = character === "a" ? 1 : character === "\u00e9" ? 2 : character === "\u4e2d" ? 3 : 4;
    expect(() => validateTranscriptEditorText(character.repeat(Math.floor(MAX_TRANSCRIPT_EDITOR_BYTES / bytes) + 1), false))
      .toThrow("exceeds the supported text size");
  });
  it.each(["a\u0000b", "\ud800", "\udc00", "a\ud800x"])("rejects unrepresentable text without substitution (%p)", (text) => {
    expect(() => validateTranscriptEditorText(text, true)).toThrow(TranscriptEditorError);
  });
});
