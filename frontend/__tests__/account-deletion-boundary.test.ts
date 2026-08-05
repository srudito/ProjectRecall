import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("account deletion root boundary", () => {
  const boundary = readSource(
    "src/components/AccountDeletionBoundary.tsx",
  );
  const rootLayout = readSource("app/_layout.tsx");
  const deleteScreen = readSource("app/account/delete.tsx");

  it("loads the persistent marker before mounting private coordinators and routes", () => {
    expect(rootLayout).toMatch(
      /<AccountDeletionBoundary>[\s\S]*<RecordingAudioCoordinator \/>[\s\S]*<ProjectSyncCoordinator \/>[\s\S]*<RootStack \/>[\s\S]*<\/AccountDeletionBoundary>/,
    );
    expect(boundary).toContain("loadAccountDeletionMarker()");
    expect(boundary).toContain("!initialized || !authInitialized");
    expect(boundary).toContain("marker ? (");
  });

  it("writes the marker before invoking the server and waits for workers to stop", () => {
    const persistIndex = boundary.indexOf("await persistMarker(started)");
    const waitIndex = boundary.indexOf(
      "await waitForAccountDeletionBackgroundWork()",
      persistIndex,
    );
    const invokeIndex = boundary.indexOf(
      "await invokeDeleteAccount(current.userId)",
      waitIndex,
    );

    expect(persistIndex).toBeGreaterThan(-1);
    expect(waitIndex).toBeGreaterThan(persistIndex);
    expect(invokeIndex).toBeGreaterThan(waitIndex);
  });

  it("removes files and SQLite data before clearing session and removes the marker last", () => {
    const cleanupIndex = boundary.indexOf("await performLocalAccountCleanup");
    const authIndex = boundary.indexOf("await clearLocalAuthSession");
    const markerIndex = boundary.indexOf(
      "await clearAccountDeletionMarker()",
      authIndex,
    );

    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(cleanupIndex);
    expect(markerIndex).toBeGreaterThan(authIndex);
  });

  it("keeps private UI hidden when marker loading or persistence fails", () => {
    expect(boundary).toContain("ACCOUNT_DELETION_LOCAL_STATE_FAILED");
    expect(boundary).toContain(
      "account-deletion-state-check-error-screen",
    );
    expect(boundary).toContain("setMarkerLoadError");
    expect(boundary).toContain('status: "retryable_error"');
    expect(boundary).toContain("activeWorkflow = null");
    expect(boundary).toContain(
      "resolveAccountDeletionWorkflowFailureMarker(marker)",
    );
  });

  it("resynchronizes a remounted boundary after the active workflow settles", () => {
    expect(boundary).toContain("activeWorkflowOwner");
    expect(boundary).toContain("boundaryInstanceRef");
    expect(boundary).toContain("const observedWorkflow = activeWorkflow");
    expect(boundary).toContain("reloadAfterWorkflow");
    expect(boundary).toContain("void reloadMarker()");
    expect(boundary).toContain("cancelled = true");
  });

  it("prepares a validated owned-workspace scope before persisting deletion state", () => {
    expect(boundary).toContain("await prepareAccountDeletionMarker({");
    expect(boundary).toContain(
      "collectLocalScope: collectLocalAccountCleanupScope",
    );
    expect(boundary).toContain("resolvePersonalWorkspaceId");
    expect(boundary).toContain("persistMarker");
  });

  it("requires exact DELETE confirmation and blocks active recordings", () => {
    expect(deleteScreen).toContain('const REQUIRED_CONFIRMATION = "DELETE"');
    expect(deleteScreen).toContain(
      "isRecordingStateSafeForAccountDeletion",
    );
    expect(deleteScreen).toContain("inFlightRef.current");
    expect(deleteScreen).toContain("beginDeletion(userId)");
  });
  it("finishes privacy-first local cleanup when a started server request loses its session", () => {
    expect(boundary).toContain(
      '"server_outcome_unverified_local_cleanup_pending"',
    );
    expect(boundary).toContain(
      '"local_cleanup_complete_server_unverified"',
    );
    expect(boundary).toContain("current.serverRequestStartedAt");
    expect(boundary).toContain("current.serverDeletionConfirmedAt");
    expect(boundary).toContain(
      "account-deletion-unverified-continue-button",
    );

    const reauthGuardIndex = boundary.indexOf(
      "if (marker.serverRequestStartedAt)",
    );
    const markerClearIndex = boundary.indexOf(
      "await clearAccountDeletionMarker()",
      reauthGuardIndex,
    );
    expect(reauthGuardIndex).toBeGreaterThan(-1);
    expect(markerClearIndex).toBeGreaterThan(reauthGuardIndex);
  });

  it("returns to Profile only for server-confirmed gate-inactive blockers", () => {
    expect(boundary).toContain(
      "isSafeAccountDeletionPreflightBlock(cause)",
    );
    expect(boundary).toContain("cause.gateActive === false");
  });

  it("does not erase prior server-request evidence when reauthentication is requested later", () => {
    expect(boundary).toContain(
      "resolveAccountDeletionAuthMismatchStatus(current)",
    );
    expect(boundary).toContain(
      'status === "reauthentication_required"',
    );
    expect(boundary).toContain(
      "resolveAccountDeletionLocalCleanupErrorCode",
    );
  });

});
