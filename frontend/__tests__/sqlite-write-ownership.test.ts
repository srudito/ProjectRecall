import * as repository from "@/src/services/sqlite/repository";
import { openLocalDb } from "@/src/services/sqlite/schema";
import { __resetSerializedLocalTransactionsForTests, withLocalTransactionTurn } from "@/src/services/sqlite/transaction";

jest.mock("@/src/services/sqlite/schema", () => ({ openLocalDb: jest.fn() }));
jest.mock("@/src/services/sqlite/read-snapshot", () => ({
  pauseSessionReadSnapshots: jest.fn(() => () => {}), withLocalReadSnapshot: jest.fn(),
}));
jest.mock("@/src/services/transcription/history-cache-service", () => ({
  pauseSessionTranscriptHistoryCache: jest.fn(() => () => {}), waitForTranscriptHistoryCacheIdle: jest.fn(async () => {}),
}));
const open = openLocalDb as jest.MockedFunction<typeof openLocalDb>;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = "2026-09-09T00:00:00.000Z";
const row = { id: ID, user_id: USER, workspace_id: WORKSPACE, session_id: SESSION, recording_id: ID,
  created_by: USER, created_at: NOW, updated_at: NOW, expected_spoken_languages: [],
  detected_spoken_languages: [], language_metadata: {}, language_summary: {},
  queue_status: "pending", attempt_count: 0, max_attempts: 5, is_starred: false,
  spoken_language_mode: "AUTO_DETECT", plain_text: "test", text: "test", title: "test", name: "test" };
const sync = { local_sync_status: "synchronized" };
const upload = { upload_status: "uploaded" };
const mutationApi = {
  upsertSession: repository.upsertSession,
  updateSessionSyncStatus: repository.updateSessionSyncStatus,
  softDeleteSession: repository.softDeleteSession,
  upsertSessionUserPreference: repository.upsertSessionUserPreference,
  updateSessionUserPreferenceSyncStatus: repository.updateSessionUserPreferenceSyncStatus,
  upsertProject: repository.upsertProject,
  updateProjectSyncStatus: repository.updateProjectSyncStatus,
  upsertNote: repository.upsertNote,
  upsertBookmark: repository.upsertBookmark,
  upsertTimelineEvent: repository.upsertTimelineEvent,
  updateNoteSyncStatus: repository.updateNoteSyncStatus,
  upsertRecording: repository.upsertRecording,
  updateRecordingUploadStatus: repository.updateRecordingUploadStatus,
  upsertMediaAsset: repository.upsertMediaAsset,
  updateMediaAssetUploadStatus: repository.updateMediaAssetUploadStatus,
  enqueueUpload: repository.enqueueUpload,
  claimUploadOperation: repository.claimUploadOperation,
  rescheduleUploadOperation: repository.rescheduleUploadOperation,
  markUploadOperationFailed: repository.markUploadOperationFailed,
  deleteCompletedUploadOperation: repository.deleteCompletedUploadOperation,
  deleteUploadOperationsForEntity: repository.deleteUploadOperationsForEntity,
  resetInProgressUploadOperations: repository.resetInProgressUploadOperations,
  requeueUploadOperationForEntity: repository.requeueUploadOperationForEntity,
  saveTranscriptEditDraft: repository.saveTranscriptEditDraft,
  deleteTranscriptEditDraft: repository.deleteTranscriptEditDraft,
  upsertTranscriptionRequestIntent: repository.upsertTranscriptionRequestIntent,
  claimTranscriptionRequest: repository.claimTranscriptionRequest,
  deferTranscriptionRequest: repository.deferTranscriptionRequest,
  rescheduleTranscriptionRequest: repository.rescheduleTranscriptionRequest,
  markTranscriptionRequestSubmitted: repository.markTranscriptionRequestSubmitted,
  markTranscriptionRequestFailed: repository.markTranscriptionRequestFailed,
  markTranscriptionRequestCancelled: repository.markTranscriptionRequestCancelled,
  resetSubmittingTranscriptionRequests: repository.resetSubmittingTranscriptionRequests,
  rescheduleTranscriptionResultAfterFailure: repository.rescheduleTranscriptionResultAfterFailure,
  setPreference: repository.setPreference,
  enqueueMetadataSync: repository.enqueueMetadataSync,
  markMetadataOperationSucceeded: repository.markMetadataOperationSucceeded,
  markMetadataOperationFailed: repository.markMetadataOperationFailed,
  rescheduleMetadataOperation: repository.rescheduleMetadataOperation,
  deferMetadataOperationForDependency: repository.deferMetadataOperationForDependency,
  deleteCompletedMetadataOperation: repository.deleteCompletedMetadataOperation,
  resetInProgressMetadataOperations: repository.resetInProgressMetadataOperations,
  deleteMetadataOperationsForEntity: repository.deleteMetadataOperationsForEntity,
  requeueMetadataOperationForEntity: repository.requeueMetadataOperationForEntity,
  resetInProgressSessionDeletions: repository.resetInProgressSessionDeletions,
  updateSessionDeletionProgress: repository.updateSessionDeletionProgress,
  deleteCompletedSessionDeletion: repository.deleteCompletedSessionDeletion,
} as const;
const cases: [keyof typeof mutationApi, unknown[]][] = [
  ["upsertSession", [row]], ["updateSessionSyncStatus", [ID, sync]], ["softDeleteSession", [ID]],
  ["upsertSessionUserPreference", [row]], ["updateSessionUserPreferenceSyncStatus", [ID, sync]],
  ["upsertProject", [row]], ["updateProjectSyncStatus", [ID, sync]], ["upsertNote", [row]],
  ["upsertBookmark", [row]], ["upsertTimelineEvent", [row]], ["updateNoteSyncStatus", [ID, sync]],
  ["upsertRecording", [row]], ["updateRecordingUploadStatus", [ID, upload]], ["upsertMediaAsset", [row]],
  ["updateMediaAssetUploadStatus", [ID, upload]], ["enqueueUpload", [row]], ["claimUploadOperation", [ID]],
  ["rescheduleUploadOperation", [ID, NOW, "TEST", "test"]], ["markUploadOperationFailed", [ID, "TEST", "test"]],
  ["deleteCompletedUploadOperation", [ID]], ["deleteUploadOperationsForEntity", ["recording", ID]],
  ["resetInProgressUploadOperations", [USER]], ["requeueUploadOperationForEntity", ["recording", ID]],
  ["saveTranscriptEditDraft", [{ userId: USER, workspaceId: WORKSPACE, sessionId: SESSION, baseVersionId: ID, plainText: "test" }]],
  ["deleteTranscriptEditDraft", [USER, SESSION]], ["upsertTranscriptionRequestIntent", [row]],
  ["claimTranscriptionRequest", [ID]], ["deferTranscriptionRequest", [ID, NOW, "TEST", "test"]],
  ["rescheduleTranscriptionRequest", [ID, NOW, "TEST", "test"]], ["markTranscriptionRequestSubmitted", [ID, ID]],
  ["markTranscriptionRequestFailed", [ID, "TEST", "test"]], ["markTranscriptionRequestCancelled", [ID, "TEST", "test"]],
  ["resetSubmittingTranscriptionRequests", [USER]],
  ["rescheduleTranscriptionResultAfterFailure", [{ queueId: ID, nextRetryAt: NOW, errorCode: "TEST", safeError: "test" }]],
  ["setPreference", ["theme", "system"]], ["enqueueMetadataSync", [{ ...row, entityType: "session", entityId: SESSION }]],
  ["markMetadataOperationSucceeded", [ID]], ["markMetadataOperationFailed", [ID, "TEST", "test"]],
  ["rescheduleMetadataOperation", [ID, NOW, "TEST", "test"]], ["deferMetadataOperationForDependency", [ID, NOW, "TEST", "test"]],
  ["deleteCompletedMetadataOperation", [ID]], ["resetInProgressMetadataOperations", []],
  ["deleteMetadataOperationsForEntity", ["session", ID]], ["requeueMetadataOperationForEntity", ["session", ID]],
  ["resetInProgressSessionDeletions", [USER]], ["updateSessionDeletionProgress", [ID, { queue_status: "succeeded" }]],
  ["deleteCompletedSessionDeletion", [ID]],
];
const invoke = (name: keyof typeof mutationApi, args: unknown[]): Promise<unknown> =>
  (mutationApi[name] as (...values: unknown[]) => Promise<unknown>)(...args);
const deferred = () => {
  let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const port = () => ({
  runAsync: jest.fn(async (_sql: string, _values?: unknown) => ({ changes: 1, lastInsertRowId: 0 })),
  getFirstAsync: jest.fn(async (_sql: string, _values?: unknown): Promise<unknown> => null),
  getAllAsync: jest.fn(async () => []),
  withTransactionAsync: jest.fn(async (task: () => Promise<void>) => task()),
  isInTransactionAsync: jest.fn(async () => false),
  execAsync: jest.fn(async () => {}),
});

beforeEach(() => { jest.clearAllMocks(); __resetSerializedLocalTransactionsForTests(); });

describe("standalone repository mutations join the shared lane", () => {
  it.each(cases)("queues %s until the existing owner releases its native work", async (name, args) => {
    const db = port(); open.mockResolvedValue(db as never);
    const entered = deferred(); const finish = deferred();
    const owner = withLocalTransactionTurn(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const pending = invoke(name, args);
    await Promise.resolve(); await Promise.resolve();
    expect(db.runAsync).not.toHaveBeenCalled(); expect(db.getFirstAsync).not.toHaveBeenCalled();
    finish.resolve(); await owner; await pending;
    expect(db.runAsync.mock.calls.length).toBeGreaterThan(0);
    expect(db.isInTransactionAsync).toHaveBeenCalledTimes(2);
    expect(db.withTransactionAsync).not.toHaveBeenCalled();
  });
  it.each(["claimUploadOperation", "claimTranscriptionRequest"] as const)("keeps %s update and readback in the same turn", async (name) => {
    const db = port(); open.mockResolvedValue(db as never);
    const entered = deferred(); const finish = deferred();
    db.getFirstAsync.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return null; });
    const claim = invoke(name, [ID]); await entered.promise;
    const next = repository.setPreference("theme", "dark");
    await Promise.resolve(); expect(db.runAsync).toHaveBeenCalledTimes(1);
    finish.resolve(); await claim; await next; expect(db.runAsync).toHaveBeenCalledTimes(2);
  });
  it("allows existing atomic OnDb helpers to write without recursively acquiring the lane", async () => {
    const db = port(); open.mockResolvedValue(db as never);
    await repository.atomicCreateRecordingWithUpload({ recording: row, upload: row } as never);
    expect(db.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(db.runAsync).toHaveBeenCalledTimes(2); expect(db.isInTransactionAsync).toHaveBeenCalledTimes(2);
  });
  it("does not queue again when public status aliases delegate to an owned root", async () => {
    const db = port(); open.mockResolvedValue(db as never);
    await repository.updateBookmarkSyncStatus(ID, sync);
    await repository.updateTimelineEventSyncStatus(ID, sync);
    await repository.rescheduleSessionDeletion(ID, NOW, "TEST", "test");
    await repository.markSessionDeletionFailed(ID, "TEST", "test");
    expect(db.runAsync).toHaveBeenCalledTimes(4); expect(db.isInTransactionAsync).toHaveBeenCalledTimes(8);
  });
  it.each(cases)("preserves %s no-local-database fallback without queueing SQL", async (name, args) => {
    open.mockResolvedValue(null);
    const finish = deferred(); const entered = deferred();
    const owner = withLocalTransactionTurn(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    try { await invoke(name, args); } finally { finish.resolve(); await owner; }
  });
  it("waits for a delayed native inspection before reporting a mutation complete", async () => {
    const db = port(); open.mockResolvedValue(db as never);
    const entered = deferred(); const finish = deferred();
    db.isInTransactionAsync.mockResolvedValueOnce(false).mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return false; });
    let delivered = false; const pending = repository.setPreference("theme", "dark").then(() => { delivered = true; });
    await entered.promise; expect(delivered).toBe(false); finish.resolve(); await pending; expect(delivered).toBe(true);
  });
  it("holds the WAL checkpoint under its own turn after the deletion transaction has committed", async () => {
    const db = port(); open.mockResolvedValue(db as never);
    const entered = deferred(); const finish = deferred(); let committed = false;
    db.withTransactionAsync.mockImplementation(async (task) => { await task(); committed = true; });
    db.getFirstAsync.mockImplementation(async (sql) => {
      expect(sql).toBe("PRAGMA wal_checkpoint(TRUNCATE)"); expect(committed).toBe(true);
      entered.resolve(); await finish.promise; return { busy: 0, log: 0, checkpointed: 0 };
    });
    const cleanup = repository.deleteLocalAccountData({ userId: USER, workspaceIds: [], sessionIds: [] });
    await entered.promise; const writes = db.runAsync.mock.calls.length;
    const after = repository.setPreference("theme", "system"); await Promise.resolve();
    expect(db.runAsync).toHaveBeenCalledTimes(writes); finish.resolve(); await cleanup; await after;
    expect(db.runAsync).toHaveBeenCalledTimes(writes + 1);
  });
});
