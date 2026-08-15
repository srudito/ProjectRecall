import {
  buildLocalTranscriptSegmentRows,
  formatTranscriptSegmentTimeRange,
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
  overrides: Partial<SyncedTranscriptSegment> = {},
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
  ...overrides,
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

  it("returns current text, segment rows, and the local segment count", async () => {
    const segments = [
      segment(0, "First sentence."),
      segment(1, "Second sentence.", {
        speaker_label: "A",
        language_code: "id",
      }),
    ];

    await expect(
      loadLocalTranscriptReadModel(SESSION_ID, {
        getCurrentVersion: jest.fn(async () => version),
        listSegments: jest.fn(async () => segments),
      }),
    ).resolves.toEqual({
      kind: "ready",
      version,
      segmentRows: [
        {
          id: segments[0].id,
          segmentIndex: 0,
          startMs: 0,
          endMs: 1000,
          timestampLabel: "00:00–00:01",
          text: "First sentence.",
          languageCode: "en",
          speakerLabel: null,
        },
        {
          id: segments[1].id,
          segmentIndex: 1,
          startMs: 1000,
          endMs: 2000,
          timestampLabel: "00:01–00:02",
          text: "Second sentence.",
          languageCode: "id",
          speakerLabel: "A",
        },
      ],
      plainText: "First sentence. Second sentence.",
      segmentCount: 2,
    });
  });

  it("falls back to normalized ordered segment text when plain_text is empty", async () => {
    const segments = [
      segment(0, " First sentence. "),
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

  it("formats transcript ranges across minutes and hours", () => {
    expect(formatTranscriptSegmentTimeRange(65_000, 68_500)).toBe(
      "01:05–01:08",
    );
    expect(formatTranscriptSegmentTimeRange(3_665_000, 3_668_000)).toBe(
      "01:01:05–01:01:08",
    );
  });

  it("normalizes optional timestamp-row metadata without provider identifiers", () => {
    const [row] = buildLocalTranscriptSegmentRows(SESSION_ID, version, [
      segment(0, "  Hello.  ", {
        language_code: " en ",
        speaker_label: " Speaker A ",
        provider_segment_id: "provider-word-1",
      }),
    ]);

    expect(row).toEqual(
      expect.objectContaining({
        timestampLabel: "00:00–00:01",
        text: "Hello.",
        languageCode: "en",
        speakerLabel: "Speaker A",
      }),
    );
    expect(row).not.toHaveProperty("providerSegmentId");
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

  it("rejects invalid time ranges, blank text, and duplicate IDs", () => {
    expect(() =>
      buildLocalTranscriptSegmentRows(SESSION_ID, version, [
        segment(0, "Invalid time.", { start_ms: 2_000, end_ms: 1_000 }),
      ]),
    ).toThrow(LocalTranscriptReadError);

    expect(() =>
      buildLocalTranscriptSegmentRows(SESSION_ID, version, [
        segment(0, "   "),
      ]),
    ).toThrow(LocalTranscriptReadError);

    const first = segment(0, "First.");
    expect(() =>
      buildLocalTranscriptSegmentRows(SESSION_ID, version, [
        first,
        segment(1, "Second.", { id: first.id }),
      ]),
    ).toThrow(LocalTranscriptReadError);
  });
});
