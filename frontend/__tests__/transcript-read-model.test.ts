import {
  loadLocalTranscriptReadModel,
  LocalTranscriptReadError,
} from "@/src/services/transcription/read-model";
import type {
  SyncedTranscriptSegment,
  SyncedTranscriptVersion,
} from "@/src/services/transcription/result-types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-15T00:00:00.000Z";

const version: SyncedTranscriptVersion = {
  id: VERSION_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcription_run_id: RUN_ID,
  created_by: null,
  version: 1,
  version_origin: "provider",
  version_status: "final",
  parent_version_id: null,
  plain_text: "First sentence. Second sentence.",
  language_summary: { primaryLanguage: "en" },
  content_checksum_sha256: "a".repeat(64),
  is_current: true,
  created_at: NOW,
  updated_at: NOW,
};

const segment = (
  index: number,
  text: string,
): SyncedTranscriptSegment => ({
  id: `${index + 5}${index + 5}${index + 5}${index + 5}${index + 5}${index + 5}${index + 5}${index + 5}-${index + 5}${index + 5}${index + 5}${index + 5}-4${index + 5}${index + 5}${index + 5}-8${index + 5}${index + 5}${index + 5}-${String(index + 5).repeat(12)}`,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcript_version_id: VERSION_ID,
  segment_index: index,
  start_ms: index * 1000,
  end_ms: (index + 1) * 1000,
  text,
  language_code: "en",
  speaker_label: null,
  confidence: 0.9,
  provider_segment_id: null,
  created_at: NOW,
  updated_at: NOW,
});

describe("local transcript read model", () => {
  it("returns an empty state when no current transcript is cached", async () => {
    await expect(
      loadLocalTranscriptReadModel(SESSION_ID, {
        getCurrentVersion: jest.fn(async () => null),
        listSegments: jest.fn(),
      }),
    ).resolves.toEqual({ kind: "empty" });
  });

  it("returns current plain text and the local segment count", async () => {
    const segments = [
      segment(0, "First sentence."),
      segment(1, "Second sentence."),
    ];

    await expect(
      loadLocalTranscriptReadModel(SESSION_ID, {
        getCurrentVersion: jest.fn(async () => version),
        listSegments: jest.fn(async () => segments),
      }),
    ).resolves.toEqual({
      kind: "ready",
      version,
      segments,
      plainText: "First sentence. Second sentence.",
      segmentCount: 2,
    });
  });

  it("falls back to ordered segment text when plain_text is empty", async () => {
    const segments = [
      segment(0, "First sentence."),
      segment(1, "Second sentence."),
    ];

    const result = await loadLocalTranscriptReadModel(SESSION_ID, {
      getCurrentVersion: jest.fn(async () => ({ ...version, plain_text: "" })),
      listSegments: jest.fn(async () => segments),
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "ready",
        plainText: "First sentence. Second sentence.",
        segmentCount: 2,
      }),
    );
  });

  it("rejects transcript segments that cross session scope", async () => {
    await expect(
      loadLocalTranscriptReadModel(SESSION_ID, {
        getCurrentVersion: jest.fn(async () => version),
        listSegments: jest.fn(async () => [
          {
            ...segment(0, "Wrong session."),
            session_id: "99999999-9999-4999-8999-999999999999",
          },
        ]),
      }),
    ).rejects.toBeInstanceOf(LocalTranscriptReadError);
  });

  it("rejects duplicate or out-of-order segment indexes", async () => {
    await expect(
      loadLocalTranscriptReadModel(SESSION_ID, {
        getCurrentVersion: jest.fn(async () => version),
        listSegments: jest.fn(async () => [
          segment(1, "Second."),
          segment(1, "Duplicate."),
        ]),
      }),
    ).rejects.toBeInstanceOf(LocalTranscriptReadError);
  });
});
