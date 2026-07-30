import { openLocalDb } from "@/src/services/sqlite/schema";
import {
  atomicRequeueMediaAssetUpload,
  type UploadQueueRow,
} from "@/src/services/sqlite/repository";

jest.mock("@/src/services/sqlite/schema", () => ({
  openLocalDb: jest.fn(),
}));

const assetId = "77777777-7777-4777-8777-777777777777";
const timelineId = "88888888-8888-4888-8888-888888888888";

const upload: UploadQueueRow = {
  id: "99999999-9999-4999-8999-999999999999",
  user_id: "33333333-3333-4333-8333-333333333333",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  session_id: "55555555-5555-4555-8555-555555555555",
  source_entity_type: "media_asset",
  source_entity_id: assetId,
  local_file_uri: "file:///documents/pump.jpg",
  target_storage_path:
    "22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555/77777777-7777-4777-8777-777777777777/pump.jpg",
  queue_status: "pending",
  attempt_count: 0,
  next_retry_at: null,
  last_error_code: null,
  last_safe_error: null,
  idempotency_key: `upload:media_asset:${assetId}`,
  created_at: "2026-07-30T10:00:00.000Z",
  updated_at: "2026-07-30T10:00:00.000Z",
};

describe("media upload retry", () => {
  it("requeues failed evidence timeline metadata with the binary upload", async () => {
    const runAsync = jest.fn(async () => ({ changes: 1 }));
    const getAllAsync = jest.fn(async () => [
      {
        id: timelineId,
        workspace_id: upload.workspace_id,
        created_by: upload.user_id,
        created_at: "2026-07-30T10:00:05.000Z",
      },
    ]);
    const database = {
      runAsync,
      getAllAsync,
      withTransactionAsync: jest.fn(async (operation: () => Promise<void>) =>
        operation(),
      ),
    };
    jest.mocked(openLocalDb).mockResolvedValue(database as never);

    await atomicRequeueMediaAssetUpload({ assetId, upload });

    expect(getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining("source_entity_type = 'media_asset'"),
      [assetId],
    );
    expect(
      runAsync.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("UPDATE local_timeline_events"),
      ),
    ).toBe(true);
    expect(
      runAsync.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("INSERT INTO local_metadata_sync_queue"),
      ),
    ).toBe(true);
  });
});
