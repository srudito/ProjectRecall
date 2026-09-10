import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Crypto from "expo-crypto";

import { createTranscriptHistoryRestoreService } from "@/src/services/transcription/history-restore-service";
import type {
  TranscriptHistoryRestoreDraftResult,
} from "@/src/services/transcription/history-restore-types";

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: jest.fn(),
}));
jest.mock("@/src/services/sqlite/repository", () => ({
  prepareGuardedTranscriptHistoryRestoreDraft: jest.fn(),
}));
jest.mock("@/src/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ initialized: false, user: null }),
    subscribe: jest.fn(() => () => {}),
  },
}));
jest.mock("@/src/services/account-deletion/state", () => ({
  isAccountDeletionLocallyPending: () => false,
}));
jest.mock("@/src/services/sync/transcription-sync-events", () => ({
  notifyTranscriptionSyncChanges: jest.fn(),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";
const CURRENT_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ID = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-09-11T00:00:00.000Z";
const SOURCE_TEXT = "  exact historical Full Text  ";
const SOURCE_CHECKSUM = "A".repeat(64);
const scope = { userId: USER_ID, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
const digest = Crypto.digestStringAsync as jest.MockedFunction<
  typeof Crypto.digestStringAsync
>;

const result = (): TranscriptHistoryRestoreDraftResult => ({
  kind: "draft_created",
  sourceVersionId: SOURCE_ID,
  baseVersionId: CURRENT_ID,
  draft: {
    user_id: USER_ID,
    workspace_id: WORKSPACE_ID,
    session_id: SESSION_ID,
    base_version_id: CURRENT_ID,
    plain_text: SOURCE_TEXT,
    created_at: NOW,
    updated_at: NOW,
  },
});
const request = () => ({
  scope: { ...scope },
  sourceVersionId: SOURCE_ID,
  sourceVersionNumber: 2,
  sourcePlainText: SOURCE_TEXT,
  sourceContentChecksumSha256: SOURCE_CHECKSUM as string | null,
  assertActive: jest.fn(),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

const fixture = () => {
  const auth = { initialized: true, userId: USER_ID as string | null };
  const state = { deleting: false };
  const listeners = new Set<() => void>();
  const notifyChanged = jest.fn();
  const persisted = result();
  const prepare = jest.fn(async (input: { assertActive: () => void }) => {
    input.assertActive();
    return persisted;
  });
  const service = createTranscriptHistoryRestoreService({
    platform: "android",
    getAuth: () => ({ ...auth }),
    subscribeAuth: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isDeletionPending: () => state.deleting,
    prepare: prepare as never,
    notifyChanged,
  });
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return { auth, state, listeners, notifyChanged, persisted, prepare, service, emit };
};

beforeEach(() => {
  jest.clearAllMocks();
  digest.mockResolvedValue(SOURCE_CHECKSUM.toLowerCase());
});

describe("C2F.1 guarded history restore service", () => {
  it("captures one exact request and returns a detached committed draft", async () => {
    const f = fixture();
    const input = request();
    const pending = f.service.prepareDraft(input);
    input.scope.userId = OTHER_ID;
    input.sourceVersionId = OTHER_ID;
    input.sourceVersionNumber = 99;
    input.sourcePlainText = "mutated";
    input.sourceContentChecksumSha256 = null;

    const restored = await pending;

    expect(digest).toHaveBeenCalledWith(
      Crypto.CryptoDigestAlgorithm.SHA256,
      SOURCE_TEXT,
    );
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.prepare.mock.calls[0][0]).toMatchObject({
      scope,
      sourceVersionId: SOURCE_ID,
      sourceVersionNumber: 2,
      sourcePlainText: SOURCE_TEXT,
      sourceContentChecksumSha256: SOURCE_CHECKSUM.toLowerCase(),
      assertActive: expect.any(Function),
    });
    expect(restored).toEqual(f.persisted);
    expect(restored).not.toBe(f.persisted);
    expect(restored.draft).not.toBe(f.persisted.draft);
    restored.draft.plain_text = "caller mutation";
    expect(f.persisted.draft.plain_text).toBe(SOURCE_TEXT);
    expect(f.notifyChanged).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
  });

  it.each(["web", "windows"])(
    "rejects unsupported platform %s before persistence",
    async (platform: string) => {
      const f = fixture();
      const service = createTranscriptHistoryRestoreService({
        platform,
        getAuth: () => ({ ...f.auth }),
        subscribeAuth: () => () => {},
        isDeletionPending: () => false,
        prepare: f.prepare as never,
        notifyChanged: f.notifyChanged,
      });

      await expect(service.prepareDraft(request())).rejects.toMatchObject({
        code: "HISTORY_RESTORE_NATIVE_ONLY",
      });
      expect(f.prepare).not.toHaveBeenCalled();
    },
  );

  it("requires matching restored auth and no deletion before persistence", async () => {
    const f = fixture();
    f.auth.userId = OTHER_ID;
    await expect(f.service.prepareDraft(request())).rejects.toMatchObject({
      code: "HISTORY_RESTORE_AUTH_REQUIRED",
    });
    expect(f.prepare).not.toHaveBeenCalled();

    f.auth.userId = USER_ID;
    f.state.deleting = true;
    await expect(f.service.prepareDraft(request())).rejects.toMatchObject({
      code: "HISTORY_RESTORE_DELETION_PENDING",
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("permanently invalidates an in-flight A to B to A identity switch", async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.prepare.mockImplementationOnce(async (input: { assertActive: () => void }) => {
      input.assertActive();
      await gate.promise;
      input.assertActive();
      return result();
    });
    const pending = f.service.prepareDraft(request());
    await flush();

    f.auth.userId = OTHER_ID;
    f.emit();
    f.auth.userId = USER_ID;
    f.emit();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({
      code: "HISTORY_RESTORE_CONTEXT_INACTIVE",
    });
    expect(f.notifyChanged).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
  });

  it("rolls admission closed when caller lifetime or deletion changes", async () => {
    for (const kind of ["caller", "deletion"] as const) {
      const f = fixture();
      const gate = deferred<void>();
      const input = request();
      let active = true;
      input.assertActive.mockImplementation(() => {
        if (!active) throw new Error("PRIVATE CALLER STATE");
      });
      f.prepare.mockImplementationOnce(async (value: { assertActive: () => void }) => {
        value.assertActive();
        await gate.promise;
        value.assertActive();
        return result();
      });
      const pending = f.service.prepareDraft(input);
      await flush();
      if (kind === "caller") active = false;
      else f.state.deleting = true;
      gate.resolve();

      await expect(pending).rejects.toMatchObject({
        code: kind === "caller"
          ? "HISTORY_RESTORE_CONTEXT_INACTIVE"
          : "HISTORY_RESTORE_DELETION_PENDING",
      });
      expect(f.notifyChanged).not.toHaveBeenCalled();
    }
  });

  it("preserves an acknowledged commit if notification observes a later identity change", async () => {
    const f = fixture();
    f.notifyChanged.mockImplementation(() => {
      f.auth.userId = OTHER_ID;
      f.emit();
      throw new Error("PRIVATE NOTIFY FAILURE");
    });

    await expect(f.service.prepareDraft(request())).resolves.toEqual(f.persisted);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
  });

  it("fails before persistence when the selected text does not match its checksum", async () => {
    const f = fixture();
    digest.mockResolvedValueOnce("b".repeat(64));

    await expect(f.service.prepareDraft(request())).rejects.toMatchObject({
      code: "HISTORY_RESTORE_CHECKSUM_MISMATCH",
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.notifyChanged).not.toHaveBeenCalled();
  });

  it("sanitizes checksum implementation failures and permits a nullable checksum", async () => {
    const f = fixture();
    digest.mockRejectedValueOnce(new Error("PRIVATE HASH FAILURE"));
    await expect(f.service.prepareDraft(request())).rejects.toMatchObject({
      code: "HISTORY_RESTORE_HASH_UNAVAILABLE",
    });
    expect(f.prepare).not.toHaveBeenCalled();

    const withoutChecksum = request();
    withoutChecksum.sourceContentChecksumSha256 = null;
    await expect(f.service.prepareDraft(withoutChecksum)).resolves.toMatchObject({
      kind: "draft_created",
    });
    expect(digest).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it("validates input before persistence and sanitizes arbitrary failures", async () => {
    const f = fixture();
    await expect(f.service.prepareDraft({
      ...request(),
      sourceVersionId: "invalid",
    })).rejects.toMatchObject({ code: "HISTORY_RESTORE_INPUT_INVALID" });
    expect(f.prepare).not.toHaveBeenCalled();

    f.prepare.mockRejectedValueOnce(new Error("PRIVATE SQL AND TRANSCRIPT"));
    try {
      await f.service.prepareDraft(request());
      throw new Error("Expected restore failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "HISTORY_RESTORE_WRITE_FAILED" });
      expect(String(error)).not.toContain("PRIVATE");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("fails closed on a malformed internal persistence result", async () => {
    const f = fixture();
    f.prepare.mockResolvedValueOnce({
      ...result(),
      baseVersionId: SOURCE_ID,
    });

    await expect(f.service.prepareDraft(request())).rejects.toMatchObject({
      code: "HISTORY_RESTORE_WRITE_FAILED",
    });
    expect(f.notifyChanged).not.toHaveBeenCalled();
  });

  it("has no cloud, RPC, current-promotion, timer, or automatic sync boundary", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/services/transcription/history-restore-service.ts"),
      "utf8",
    );

    for (const token of [
      "history-client",
      "supabase",
      ".rpc(",
      "is_current",
      "setTimeout(",
      "requestTranscriptEditSync",
      "requestTranscriptCurrentVersionSync",
    ]) {
      expect(source).not.toContain(token);
    }
    expect(source).toContain("prepareGuardedTranscriptHistoryRestoreDraft");
    expect(source).toContain("notifyTranscriptionSyncChanges");
  });
});
