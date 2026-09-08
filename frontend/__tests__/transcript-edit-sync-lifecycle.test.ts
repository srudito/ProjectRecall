import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { AppState, Platform, type AppStateStatus } from "react-native";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import { startTranscriptEditSyncLifecycle } from "@/src/services/sync/ProjectSyncCoordinator";
import { pauseTranscriptEditSync, resumeTranscriptEditSync } from "@/src/services/sync/transcript-edit-worker";
import { useAuthStore } from "@/src/stores/auth-store";

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { currentState: "active", addEventListener: jest.fn() },
}));
jest.mock("@/src/services/account-deletion/state", () => ({ isAccountDeletionLocallyPending: jest.fn() }));
jest.mock("@/src/stores/auth-store", () => ({
  useAuthStore: { getState: jest.fn(), subscribe: jest.fn() },
}));
jest.mock("@/src/services/sync/transcript-edit-worker", () => ({
  pauseTranscriptEditSync: jest.fn(), resumeTranscriptEditSync: jest.fn(),
}));
jest.mock("@/src/services/sync/project-sync-events", () => ({ subscribeMetadataSyncChanges: jest.fn() }));
jest.mock("@/src/services/sync/project-sync-worker", () => ({ requestMetadataSync: jest.fn() }));
jest.mock("@/src/services/sync/media-upload-worker", () => ({ requestMediaUploadSync: jest.fn() }));
jest.mock("@/src/services/sync/recording-upload-worker", () => ({ requestRecordingUploadSync: jest.fn() }));
jest.mock("@/src/services/sync/session-deletion-worker", () => ({ requestSessionDeletionSync: jest.fn() }));
jest.mock("@/src/services/sync/transcription-request-worker", () => ({ requestTranscriptionRequestSync: jest.fn() }));
jest.mock("@/src/services/sync/transcription-result-worker", () => ({ requestTranscriptionResultSync: jest.fn() }));
jest.mock("@/src/services/sync/transcript-current-version-worker", () => ({ requestTranscriptCurrentVersionSync: jest.fn() }));
jest.mock("@/src/services/sync/transcription-sync-events", () => ({ subscribeTranscriptionRequestSubmissions: jest.fn() }));

// These tests exercise the actual coordinator adapter, without rendering UI or
// running unrelated workers. Connection/auth subscriptions are fully controlled.
const setup = () => {
  const userA = { id: "11111111-1111-4111-8111-111111111111" };
  const userB = { id: "22222222-2222-4222-8222-222222222222" };
  let auth = { initialized: true, user: userA as { id: string } | null, session: {} };
  const appListeners: ((state: AppStateStatus) => void)[] = [];
  const authListeners: ((state: typeof auth) => void)[] = [];
  const connectionListeners: ((state: NetInfoState) => void)[] = [];
  const removeApp = jest.fn(); const removeAuth = jest.fn(); const removeConnection = jest.fn();
  (useAuthStore.getState as jest.Mock).mockImplementation(() => auth);
  (useAuthStore.subscribe as jest.Mock).mockImplementation((listener: (value: typeof auth) => void) => {
    authListeners.push(listener); return removeAuth;
  });
  (AppState.addEventListener as jest.Mock).mockImplementation((_event: string, listener: (state: AppStateStatus) => void) => {
    appListeners.push(listener); return { remove: removeApp };
  });
  (NetInfo.addEventListener as jest.Mock).mockImplementation((listener: (state: NetInfoState) => void) => {
    connectionListeners.push(listener); return removeConnection;
  });
  const changeAuth = (patch: Partial<typeof auth>) => {
    auth = { ...auth, ...patch };
    for (const listener of authListeners) listener(auth);
  };
  return { userA, userB, changeAuth, removeApp, removeAuth, removeConnection,
    app: (state: AppStateStatus) => { (AppState as { currentState: AppStateStatus }).currentState = state; for (const listener of appListeners) listener(state); },
    network: (online: boolean) => {
      const state = { isConnected: online, isInternetReachable: online } as NetInfoState;
      for (const listener of connectionListeners) listener(state);
    },
  };
};

describe("3D.2B edit sync lifecycle adapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = "android";
    (AppState as { currentState: AppStateStatus }).currentState = "active";
    (isAccountDeletionLocallyPending as jest.Mock).mockReturnValue(false);
  });

  it("starts only for a foreground initialized signed-in native session", () => {
    const state = setup(); const stop = startTranscriptEditSyncLifecycle();
    expect(resumeTranscriptEditSync).toHaveBeenCalledTimes(1);
    stop(); expect(state.removeApp).toHaveBeenCalledTimes(1);
    expect(state.removeAuth).toHaveBeenCalledTimes(1); expect(state.removeConnection).toHaveBeenCalledTimes(1);
  });

  it.each(["background", "uninitialized", "signed_out", "deletion"])("pauses rather than starts for %s", (condition) => {
    const state = setup();
    if (condition === "background") (AppState as { currentState: AppStateStatus }).currentState = "background";
    if (condition === "uninitialized") state.changeAuth({ initialized: false });
    if (condition === "signed_out") state.changeAuth({ user: null });
    if (condition === "deletion") (isAccountDeletionLocallyPending as jest.Mock).mockReturnValue(true);
    const stop = startTranscriptEditSyncLifecycle();
    expect(resumeTranscriptEditSync).not.toHaveBeenCalled(); expect(pauseTranscriptEditSync).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not attach native subscriptions on web", () => {
    setup(); (Platform as { OS: string }).OS = "web";
    const stop = startTranscriptEditSyncLifecycle(); stop();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    expect(NetInfo.addEventListener).not.toHaveBeenCalled(); expect(useAuthStore.subscribe).not.toHaveBeenCalled();
  });

  it("pauses on background/offline and resumes only when both conditions recover", () => {
    const state = setup(); const stop = startTranscriptEditSyncLifecycle();
    state.app("background"); state.network(false); state.app("active");
    expect(resumeTranscriptEditSync).toHaveBeenCalledTimes(1);
    state.network(true); expect(resumeTranscriptEditSync).toHaveBeenCalledTimes(2);
    stop();
  });

  it("invalidates every identity transition even if React would batch A -> B -> A", () => {
    const state = setup(); const stop = startTranscriptEditSyncLifecycle();
    state.changeAuth({ user: state.userB }); state.changeAuth({ user: state.userA });
    expect(pauseTranscriptEditSync).toHaveBeenCalledTimes(2);
    expect(resumeTranscriptEditSync).toHaveBeenCalledTimes(3);
    const pauses = (pauseTranscriptEditSync as jest.Mock).mock.invocationCallOrder;
    const resumes = (resumeTranscriptEditSync as jest.Mock).mock.invocationCallOrder;
    expect(pauses[0]).toBeLessThan(resumes[1]); expect(pauses[1]).toBeLessThan(resumes[2]);
    stop();
  });

  it("wakes deferred same-user work on session refresh without resetting its generation", () => {
    const state = setup(); const stop = startTranscriptEditSyncLifecycle();
    state.changeAuth({ session: {} });
    expect(resumeTranscriptEditSync).toHaveBeenCalledTimes(2); expect(pauseTranscriptEditSync).not.toHaveBeenCalled();
    stop();
  });

  it("does not reopen admission while account deletion is pending", () => {
    const state = setup(); const stop = startTranscriptEditSyncLifecycle();
    (isAccountDeletionLocallyPending as jest.Mock).mockReturnValue(true);
    state.network(true); state.app("active"); state.changeAuth({ session: {} });
    expect(resumeTranscriptEditSync).toHaveBeenCalledTimes(1); stop();
  });

  it("ignores queued callbacks from a disposed subscription owner", () => {
    const state = setup(); const stop = startTranscriptEditSyncLifecycle(); stop();
    const pauses = (pauseTranscriptEditSync as jest.Mock).mock.calls.length;
    state.app("active"); state.network(true); state.changeAuth({ user: state.userB });
    expect(resumeTranscriptEditSync).toHaveBeenCalledTimes(1); expect(pauseTranscriptEditSync).toHaveBeenCalledTimes(pauses);
  });
});
