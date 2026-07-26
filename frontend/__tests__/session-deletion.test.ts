import { planSessionDeletion } from "@/src/services/session/deletion";

describe("session deletion planner", () => {
  it("produces expected steps for a full-session delete", () => {
    const steps = planSessionDeletion({
      sessionId: "s1",
      workspaceId: "w1",
      hasRecording: true,
      mediaAssetIds: ["a1", "a2"],
      noteIds: ["n1"],
      bookmarkIds: ["b1"],
      queuedUploadIds: ["u1"],
    });
    expect(steps.map((s) => s.kind)).toEqual([
      "cancel_upload_queue",
      "delete_cloud_storage",
      "delete_cloud_metadata",
      "delete_local_files",
      "delete_local_metadata",
    ]);
    const cloudStorage = steps.find((s) => s.kind === "delete_cloud_storage")!;
    expect(cloudStorage.targetIds).toEqual(["recording:s1", "asset:a1", "asset:a2"]);
  });

  it("omits cancel_upload_queue when no queued uploads", () => {
    const steps = planSessionDeletion({
      sessionId: "s1",
      workspaceId: "w1",
      hasRecording: false,
      mediaAssetIds: [],
      noteIds: [],
      bookmarkIds: [],
      queuedUploadIds: [],
    });
    expect(steps.some((s) => s.kind === "cancel_upload_queue")).toBe(false);
  });
});
