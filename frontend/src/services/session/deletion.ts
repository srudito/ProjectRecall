// Session deletion planning.
//
// Deleting a session removes recording, evidence, notes, bookmarks, timeline
// events, upload-queue records, cloud storage objects, and cloud metadata.
// This planner produces the ORDERED set of steps we need to run, so callers
// can execute them, track partial failure, and mark the session as pending
// cloud cleanup if any cloud step fails.

export interface DeletionPlanInput {
  sessionId: string;
  workspaceId: string;
  hasRecording: boolean;
  mediaAssetIds: readonly string[];
  noteIds: readonly string[];
  bookmarkIds: readonly string[];
  queuedUploadIds: readonly string[];
}

export type DeletionStepScope = "local" | "cloud";

export interface DeletionStep {
  scope: DeletionStepScope;
  kind:
    | "cancel_upload_queue"
    | "delete_cloud_storage"
    | "delete_cloud_metadata"
    | "delete_local_files"
    | "delete_local_metadata";
  targetIds: readonly string[];
}

export const planSessionDeletion = (input: DeletionPlanInput): DeletionStep[] => {
  const steps: DeletionStep[] = [];

  // 1. Cancel any queued uploads so we don't race the cleanup.
  if (input.queuedUploadIds.length > 0) {
    steps.push({ scope: "local", kind: "cancel_upload_queue", targetIds: input.queuedUploadIds });
  }

  // 2. Delete cloud storage objects (recording + media assets).
  const cloudObjectIds = [
    ...(input.hasRecording ? [`recording:${input.sessionId}`] : []),
    ...input.mediaAssetIds.map((id) => `asset:${id}`),
  ];
  if (cloudObjectIds.length > 0) {
    steps.push({ scope: "cloud", kind: "delete_cloud_storage", targetIds: cloudObjectIds });
  }

  // 3. Delete cloud metadata rows.
  steps.push({
    scope: "cloud",
    kind: "delete_cloud_metadata",
    targetIds: [input.sessionId],
  });

  // 4. Delete local files.
  steps.push({
    scope: "local",
    kind: "delete_local_files",
    targetIds: [
      ...(input.hasRecording ? [`recording:${input.sessionId}`] : []),
      ...input.mediaAssetIds.map((id) => `asset:${id}`),
    ],
  });

  // 5. Delete local metadata rows (SQLite).
  steps.push({
    scope: "local",
    kind: "delete_local_metadata",
    targetIds: [
      input.sessionId,
      ...input.mediaAssetIds,
      ...input.noteIds,
      ...input.bookmarkIds,
    ],
  });

  return steps;
};
