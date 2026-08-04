import AsyncStorage from "@react-native-async-storage/async-storage";

import { RecordingState } from "@/src/services/recording/state-machine";
import {
  ACCOUNT_DELETION_MARKER_KEY,
  __resetAccountDeletionStateForTests,
  clearAccountDeletionMarker,
  createAccountDeletionMarker,
  getCurrentAccountDeletionMarker,
  isAccountDeletionLocallyPending,
  isRecordingStateSafeForAccountDeletion,
  loadAccountDeletionMarker,
  resolveAccountDeletionAuthMismatchStatus,
  resolveAccountDeletionLocalCleanupErrorCode,
  resolveAccountDeletionWorkflowFailureMarker,
  saveAccountDeletionMarker,
  updateAccountDeletionMarker,
} from "@/src/services/account-deletion/state";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

describe("account deletion persistent state", () => {
  beforeEach(async () => {
    __resetAccountDeletionStateForTests();
    await AsyncStorage.clear();
  });

  it("persists only the narrow crash-recovery marker", async () => {
    const marker = createAccountDeletionMarker({
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID, WORKSPACE_ID],
      now: new Date("2026-08-04T00:00:00.000Z"),
    });

    await saveAccountDeletionMarker(marker);
    __resetAccountDeletionStateForTests();

    await expect(loadAccountDeletionMarker()).resolves.toEqual({
      version: 1,
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID],
      status: "requested",
      requestedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      serverRequestStartedAt: null,
      serverDeletionConfirmedAt: null,
      retryCount: 0,
      lastErrorCode: null,
      blockers: [],
    });

    const raw = await AsyncStorage.getItem(ACCOUNT_DELETION_MARKER_KEY);
    expect(raw).not.toContain("access_token");
    expect(raw).not.toContain("refresh_token");
    expect(raw).not.toContain("email");
    expect(isAccountDeletionLocallyPending()).toBe(true);
  });

  it("fails closed when a non-empty marker is corrupt", async () => {
    const corruptMarker = "{invalid-json";
    await AsyncStorage.setItem(
      ACCOUNT_DELETION_MARKER_KEY,
      corruptMarker,
    );

    await expect(loadAccountDeletionMarker()).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_LOCAL_STATE_FAILED",
    });
    await expect(
      AsyncStorage.getItem(ACCOUNT_DELETION_MARKER_KEY),
    ).resolves.toBe(corruptMarker);
    expect(isAccountDeletionLocallyPending()).toBe(false);
  });

  it("fails closed when marker storage cannot be read", async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(
      new Error("native storage unavailable"),
    );

    await expect(loadAccountDeletionMarker()).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_LOCAL_STATE_FAILED",
    });
    expect(isAccountDeletionLocallyPending()).toBe(false);
  });

  it("updates retry state without changing the deletion scope", () => {
    const marker = createAccountDeletionMarker({
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID],
      now: new Date("2026-08-04T00:00:00.000Z"),
    });

    expect(
      updateAccountDeletionMarker(
        marker,
        {
          status: "retryable_error",
          retryCount: 2,
          lastErrorCode: "ACCOUNT_DELETION_IN_PROGRESS",
        },
        new Date("2026-08-04T00:01:00.000Z"),
      ),
    ).toMatchObject({
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID],
      status: "retryable_error",
      retryCount: 2,
      lastErrorCode: "ACCOUNT_DELETION_IN_PROGRESS",
      updatedAt: "2026-08-04T00:01:00.000Z",
    });
  });

  it("removes the marker only after explicit cleanup", async () => {
    const marker = createAccountDeletionMarker({
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID],
    });
    await saveAccountDeletionMarker(marker);
    await clearAccountDeletionMarker();

    expect(getCurrentAccountDeletionMarker()).toBeNull();
    expect(isAccountDeletionLocallyPending()).toBe(false);
    await expect(
      AsyncStorage.getItem(ACCOUNT_DELETION_MARKER_KEY),
    ).resolves.toBeNull();
  });

  it("blocks deletion while recording is not in a safe terminal state", () => {
    expect(
      isRecordingStateSafeForAccountDeletion(RecordingState.IDLE),
    ).toBe(true);
    expect(
      isRecordingStateSafeForAccountDeletion(RecordingState.SAVED),
    ).toBe(true);
    expect(
      isRecordingStateSafeForAccountDeletion(RecordingState.FAILED),
    ).toBe(true);

    for (const state of [
      RecordingState.REQUESTING_PERMISSION,
      RecordingState.PREPARING,
      RecordingState.RECORDING,
      RecordingState.PAUSED,
      RecordingState.STOPPING,
    ]) {
      expect(isRecordingStateSafeForAccountDeletion(state)).toBe(false);
    }
  });
  it("preserves server-outcome evidence across privacy-first local cleanup", () => {
    const marker = createAccountDeletionMarker({
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID],
      now: new Date("2026-08-04T00:00:00.000Z"),
    });

    const requestStarted = updateAccountDeletionMarker(marker, {
      status: "in_progress",
      serverRequestStartedAt: "2026-08-04T00:01:00.000Z",
    });
    const cleanupPending = updateAccountDeletionMarker(requestStarted, {
      status: "server_outcome_unverified_local_cleanup_pending",
    });

    expect(cleanupPending).toMatchObject({
      serverRequestStartedAt: "2026-08-04T00:01:00.000Z",
      serverDeletionConfirmedAt: null,
      status: "server_outcome_unverified_local_cleanup_pending",
    });
    expect(resolveAccountDeletionAuthMismatchStatus(marker)).toBe(
      "reauthentication_required",
    );
    expect(
      resolveAccountDeletionAuthMismatchStatus(requestStarted),
    ).toBe("server_outcome_unverified_local_cleanup_pending");
  });

  it("keeps prior server-request evidence when a later attempt requires reauthentication", () => {
    const marker = updateAccountDeletionMarker(
      createAccountDeletionMarker({
        userId: USER_ID,
        workspaceIds: [WORKSPACE_ID],
      }),
      {
        status: "retryable_error",
        serverRequestStartedAt: "2026-08-04T00:01:00.000Z",
      },
    );

    expect(resolveAccountDeletionAuthMismatchStatus(marker)).toBe(
      "server_outcome_unverified_local_cleanup_pending",
    );
  });

  it("never claims cloud deletion when unverified local cleanup fails", () => {
    const unverified = updateAccountDeletionMarker(
      createAccountDeletionMarker({
        userId: USER_ID,
        workspaceIds: [WORKSPACE_ID],
      }),
      {
        status: "server_outcome_unverified_local_cleanup_pending",
        serverRequestStartedAt: "2026-08-04T00:01:00.000Z",
      },
    );
    const confirmed = updateAccountDeletionMarker(unverified, {
      status: "server_deleted_local_cleanup_pending",
      serverDeletionConfirmedAt: "2026-08-04T00:02:00.000Z",
    });

    expect(
      resolveAccountDeletionLocalCleanupErrorCode(
        unverified,
        "ACCOUNT_DELETION_LOCAL_CLEANUP_FAILED",
      ),
    ).toBe("ACCOUNT_DELETION_LOCAL_CLEANUP_UNVERIFIED_FAILED");
    expect(
      resolveAccountDeletionLocalCleanupErrorCode(
        confirmed,
        "ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE",
      ),
    ).toBe("ACCOUNT_DELETION_BACKGROUND_WORK_ACTIVE");
  });

  it("preserves the latest durable server-request evidence after a workflow persistence failure", async () => {
    const fallback = createAccountDeletionMarker({
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID],
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    const durable = updateAccountDeletionMarker(fallback, {
      status: "in_progress",
      serverRequestStartedAt: "2026-08-04T00:01:00.000Z",
    });
    await saveAccountDeletionMarker(durable);

    expect(
      resolveAccountDeletionWorkflowFailureMarker(fallback),
    ).toMatchObject({
      status: "retryable_error",
      serverRequestStartedAt: "2026-08-04T00:01:00.000Z",
      lastErrorCode: "ACCOUNT_DELETION_LOCAL_STATE_FAILED",
    });
  });

});
