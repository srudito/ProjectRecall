import * as transcriptRepository from "@/src/services/sqlite/repository";
import {
  buildLocalTranscriptSegmentRows,
  formatTranscriptSegmentTimeRange,
  loadLocalTranscriptReadModel,
  loadLocalTranscriptReadModelWithEvidence,
  type LocalTranscriptEvidenceReadDependencies,
  LocalTranscriptReadError,
} from "@/src/services/transcription/read-model";
import type {
  SyncedTranscriptSegment,
  SyncedTranscriptVersion,
  SyncedTranscriptVersionRecord,
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

describe("3D.1 opt-in local provider evidence read model", () => {
  const EDIT2_ID = "66666666-6666-4666-8666-666666666666";
  const EDIT3_ID = "77777777-7777-4777-8777-777777777777";
  const provider: SyncedTranscriptVersionRecord = { ...version, is_current: false };
  const edit2: SyncedTranscriptVersionRecord = {
    ...version,
    id: EDIT2_ID,
    version: 2,
    version_origin: "user_edit",
    parent_version_id: VERSION_ID,
    is_current: false,
    plain_text: "earlier edit",
  };
  const edit3: SyncedTranscriptVersion = {
    ...edit2,
    id: EDIT3_ID,
    version: 3,
    parent_version_id: EDIT2_ID,
    is_current: true,
    plain_text: "  corrected text\n",
  };
  const make = (
    overrides: Partial<LocalTranscriptEvidenceReadDependencies> = {},
  ): LocalTranscriptEvidenceReadDependencies => ({
    getCurrentVersion: jest.fn(async () => edit3),
    getVersionById: jest.fn(async (input: { versionId: string }) => {
      if (input.versionId === EDIT2_ID) return edit2;
      if (input.versionId === VERSION_ID) return provider;
      return null;
    }),
    listSegments: jest.fn(async (id: string) =>
      id === VERSION_ID ? [segment(0, "provider words")] : [],
    ),
    ...overrides,
  });

  it("keeps the legacy reader unchanged and does not load ancestry implicitly", async () => {
    const deps = make();
    const result = await loadLocalTranscriptReadModel(SESSION_ID, deps);
    expect(result).toMatchObject({ kind: "ready", plainText: "corrected text", segmentCount: 0 });
    expect(result).not.toHaveProperty("evidence");
    expect(deps.getVersionById).not.toHaveBeenCalled();
  });

  it("returns empty without reading parents or segments", async () => {
    const deps = make({ getCurrentVersion: jest.fn(async () => null) });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .resolves.toEqual({ kind: "empty" });
    expect(deps.getVersionById).not.toHaveBeenCalled();
    expect(deps.listSegments).not.toHaveBeenCalled();
  });

  it("uses a current provider's own segments without reading parents", async () => {
    const deps = make({ getCurrentVersion: jest.fn(async () => version) });
    const result = await loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps);
    expect(result).toMatchObject({
      kind: "ready",
      rawPlainText: version.plain_text,
      segmentCount: 1,
      evidence: { kind: "available", source: "current", version, segmentCount: 1 },
    });
    expect(deps.getVersionById).not.toHaveBeenCalled();
    expect(deps.listSegments).toHaveBeenCalledTimes(1);
  });

  it("follows the exact multi-edit path and keeps raw text and evidence separate", async () => {
    const deps = make();
    const result = await loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps);
    expect(result).toMatchObject({
      kind: "ready",
      version: { id: EDIT3_ID },
      rawPlainText: "  corrected text\n",
      plainText: "corrected text",
      segmentRows: [],
      segmentCount: 0,
      evidence: {
        kind: "available",
        source: "ancestor",
        version: { id: VERSION_ID, is_current: false },
        segmentCount: 1,
        segmentRows: [{ text: "provider words", startMs: 0, endMs: 1000 }],
      },
    });
    expect(deps.getVersionById).toHaveBeenNthCalledWith(1, {
      versionId: EDIT2_ID, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID,
    });
    expect(deps.getVersionById).toHaveBeenNthCalledWith(2, {
      versionId: VERSION_ID, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID,
    });
    expect(deps.listSegments).toHaveBeenNthCalledWith(1, EDIT3_ID);
    expect(deps.listSegments).toHaveBeenNthCalledWith(2, VERSION_ID);
  });

  it("supports a direct provider parent with null or differing run provenance", async () => {
    const deps = make({
      getCurrentVersion: jest.fn(async () => ({
        ...edit3, parent_version_id: VERSION_ID, transcription_run_id: null,
      })),
      getVersionById: jest.fn(async () => ({ ...provider, transcription_run_id: RUN_ID })),
    });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .resolves.toMatchObject({ evidence: { kind: "available", version: { id: VERSION_ID } } });
  });

  it("preserves a terminal import ancestor as a legitimate no-provider outcome", async () => {
    const deps = make({ getVersionById: jest.fn(async () => ({
      ...edit2, version_origin: "import" as const, parent_version_id: null,
    })) });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .resolves.toMatchObject({ evidence: { kind: "none" } });
    expect(deps.listSegments).toHaveBeenCalledTimes(1);
  });

  it("does not guess a cached provider when an intermediate parent is missing", async () => {
    const deps = make({ getVersionById: jest.fn(async () => null) });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .resolves.toMatchObject({
        rawPlainText: edit3.plain_text,
        evidence: { kind: "unavailable", reason: "parent_missing" },
      });
    expect(deps.listSegments).not.toHaveBeenCalledWith(VERSION_ID);
  });

  const invalidParents: { label: string; patch: Partial<SyncedTranscriptVersionRecord> }[] = [
    { label: "id", patch: { id: VERSION_ID } },
    { label: "workspace", patch: { workspace_id: RUN_ID } },
    { label: "session", patch: { session_id: RUN_ID } },
    { label: "current marker", patch: { is_current: true } },
    { label: "draft status", patch: { version_status: "draft" } },
    { label: "equal version", patch: { version: 3 } },
    { label: "higher version", patch: { version: 4 } },
    { label: "noninteger version", patch: { version: 1.5 } },
    { label: "zero version", patch: { version: 0 } },
    { label: "self parent", patch: { parent_version_id: EDIT2_ID } },
    { label: "malformed parent id", patch: { parent_version_id: "invalid" } },
  ];
  it.each(invalidParents)("fails closed on a parent's $label", async ({ patch }) => {
    const deps = make({ getVersionById: jest.fn(async () => ({ ...edit2, ...patch })) });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .resolves.toMatchObject({ evidence: { kind: "unavailable", reason: "invalid_cache" } });
    expect(deps.listSegments).toHaveBeenCalledTimes(1);
  });

  it("rejects a cycle before issuing a repeated parent lookup", async () => {
    const deps = make({ getVersionById: jest.fn(async () => ({
      ...edit2, parent_version_id: EDIT3_ID,
    })) });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .resolves.toMatchObject({ evidence: { kind: "unavailable", reason: "invalid_cache" } });
    expect(deps.getVersionById).toHaveBeenCalledTimes(1);
  });

  it("distinguishes local read failure from an absent provider ancestor", async () => {
    const deps = make({ getVersionById: jest.fn(async () => { throw new Error("read failed"); }) });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .resolves.toMatchObject({
        rawPlainText: edit3.plain_text,
        evidence: { kind: "unavailable", reason: "read_failed" },
      });
  });

  it("does not attach malformed provider segments to valid current Full Text", async () => {
    const deps = make({ listSegments: jest.fn(async (id: string) => id === VERSION_ID
      ? [segment(0, "bad evidence", { transcript_version_id: EDIT3_ID })] : []) });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .resolves.toMatchObject({
        rawPlainText: edit3.plain_text,
        segmentRows: [],
        evidence: { kind: "unavailable", reason: "invalid_cache" },
      });
  });

  it("rejects timestamp segments attached to the current user edit", async () => {
    const deps = make({ listSegments: jest.fn(async () => [
      segment(0, "not real evidence", { transcript_version_id: EDIT3_ID }),
    ]) });
    await expect(loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps))
      .rejects.toBeInstanceOf(LocalTranscriptReadError);
    expect(deps.getVersionById).not.toHaveBeenCalled();
  });

  it.each([64, 65])("handles a path of %i parents at the exact bound", async (length) => {
    const id = (index: number) =>
      `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`;
    const parents: SyncedTranscriptVersionRecord[] = Array.from({ length }, (_, index) => ({
      ...provider,
      id: id(index + 1),
      version: length - index,
      version_origin: index === length - 1 ? "provider" : "user_edit",
      parent_version_id: index === length - 1 ? null : id(index + 2),
    }));
    const deps = make({
      getCurrentVersion: jest.fn(async () => ({
        ...edit3, version: length + 1, parent_version_id: id(1),
      })),
      getVersionById: jest.fn(async (input: { versionId: string }) =>
        parents.find((row) => row.id === input.versionId) ?? null,
      ),
      listSegments: jest.fn(async () => []),
    });
    const result = await loadLocalTranscriptReadModelWithEvidence(SESSION_ID, deps);
    expect(result).toMatchObject({ evidence: length === 64
      ? { kind: "available", source: "ancestor", version: { id: id(64) } }
      : { kind: "unavailable", reason: "depth_limit" } });
    expect(deps.getVersionById).toHaveBeenCalledTimes(64);
  });
});

describe("3E.2B2A default reader snapshot integration", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const providerId = "33333333-3333-4333-8333-333333333333";
  const editId = "44444444-4444-4444-8444-444444444444";
  const fixture = () => {
    const provider: SyncedTranscriptVersionRecord = {
      id: providerId, workspace_id: workspaceId, session_id: sessionId, version: 1,
      version_origin: "provider", version_status: "final", parent_version_id: null,
      transcription_run_id: null, created_by: null, plain_text: "original", language_summary: {},
      content_checksum_sha256: "a".repeat(64), is_current: false,
      created_at: "2026-09-09T00:00:00Z", updated_at: "2026-09-09T00:00:00Z",
    };
    const edit: SyncedTranscriptVersion = { ...provider, id: editId, version: 2, version_origin: "user_edit",
      parent_version_id: providerId, is_current: true, plain_text: "  edited\ntext  " };
    const segment: SyncedTranscriptSegment = {
      id: "55555555-5555-4555-8555-555555555555", workspace_id: workspaceId, session_id: sessionId,
      transcript_version_id: providerId, segment_index: 0, start_ms: 0, end_ms: 1000, text: "  original  ",
      language_code: "en", speaker_label: "A", confidence: null, provider_segment_id: null,
      created_at: provider.created_at, updated_at: provider.updated_at,
    };
    const reads: LocalTranscriptEvidenceReadDependencies = {
      getCurrentVersion: jest.fn(async () => edit),
      getVersionById: jest.fn(async () => provider),
      listSegments: jest.fn(async (id: string) => id === providerId ? [segment] : []),
    };
    const snapshot = jest.spyOn(transcriptRepository, "withLocalTranscriptReadSnapshot")
      .mockImplementation(async (_sessionId, task) => task(reads));
    return { provider, edit, reads, snapshot };
  };
  afterEach(() => { jest.restoreAllMocks(); });
  it("reads default Full Text from one snapshot without implicitly fetching ancestry", async () => {
    const f = fixture(); const result = await loadLocalTranscriptReadModel(sessionId);
    expect(result).toMatchObject({ kind: "ready", plainText: "edited\ntext", segmentCount: 0 });
    expect(f.snapshot).toHaveBeenCalledTimes(1); expect(f.reads.getVersionById).not.toHaveBeenCalled();
  });
  it("keeps current, ancestry and provider segments in the same callback", async () => {
    const f = fixture(); const result = await loadLocalTranscriptReadModelWithEvidence(sessionId);
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "ready", rawPlainText: f.edit.plain_text, segmentCount: 0,
      evidence: { kind: "available", source: "ancestor", version: { id: providerId }, segmentRows: [{ text: "original", startMs: 0, endMs: 1000 }] } });
    expect(f.reads.listSegments).toHaveBeenNthCalledWith(1, editId);
    expect(f.reads.listSegments).toHaveBeenNthCalledWith(2, providerId);
  });
  it("uses snapshot-bound defaults even when only one dependency is overridden", async () => {
    const f = fixture(); const getCurrentVersion = jest.fn(async () => f.edit);
    await loadLocalTranscriptReadModelWithEvidence(sessionId, { getCurrentVersion });
    expect(f.snapshot).toHaveBeenCalledTimes(1); expect(getCurrentVersion).toHaveBeenCalledTimes(1);
    expect(f.reads.getCurrentVersion).not.toHaveBeenCalled(); expect(f.reads.getVersionById).toHaveBeenCalledTimes(1);
  });
  it("retains complete dependency injection for pure read-model tests", async () => {
    const f = fixture(); await loadLocalTranscriptReadModelWithEvidence(sessionId, f.reads);
    expect(f.snapshot).not.toHaveBeenCalled();
  });
  it("retains the empty result on the web/no-native snapshot path", async () => {
    const f = fixture(); f.snapshot.mockResolvedValueOnce(null);
    expect(await loadLocalTranscriptReadModelWithEvidence(sessionId)).toEqual({ kind: "empty" });
  });
  it("does not return a constructed model when the snapshot boundary rejects delivery", async () => {
    const f = fixture(); f.snapshot.mockImplementation(async (_sessionId, task) => {
      await task(f.reads); throw new Error("Snapshot context retired during close");
    });
    await expect(loadLocalTranscriptReadModelWithEvidence(sessionId)).rejects.toThrow("Snapshot context retired during close");
  });
});
