import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CurrentTranscriptVersionClientError,
  fetchCurrentTranscriptVersionSnapshot,
} from "@/src/services/transcription/current-version-client";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const PROVIDER_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const EDIT_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const EDIT_VERSION_3_ID = "88888888-8888-4888-8888-888888888888";
const SEGMENT_ID = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-08-19T00:00:00.000Z";

const providerVersion = {
  id: PROVIDER_VERSION_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcription_run_id: RUN_ID,
  created_by: USER_ID,
  version: 1,
  version_origin: "provider",
  version_status: "final",
  parent_version_id: null,
  plain_text: "source transcript",
  language_summary: { primaryLanguage: "en" },
  content_checksum_sha256: "a".repeat(64),
  is_current: true,
  created_at: NOW,
  updated_at: NOW,
};

const userEditVersion = {
  ...providerVersion,
  id: EDIT_VERSION_ID,
  version: 2,
  version_origin: "user_edit",
  parent_version_id: PROVIDER_VERSION_ID,
  plain_text: "corrected transcript",
  content_checksum_sha256: "b".repeat(64),
};

const sourceSegment = {
  id: SEGMENT_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  transcript_version_id: PROVIDER_VERSION_ID,
  segment_index: 0,
  start_ms: 0,
  end_ms: 1_000,
  text: "source transcript",
  language_code: "en",
  speaker_label: null,
  confidence: 0.9,
  provider_segment_id: null,
  created_at: NOW,
  updated_at: NOW,
};

interface QueryResponse {
  data: unknown;
  error: unknown;
}

const makeQuery = (
  response: QueryResponse,
  calls: string[],
  table: string,
) => {
  const query: Record<string, jest.Mock> = {
    select: jest.fn((selection: string) => {
      calls.push(`${table}.select:${selection}`);
      return query;
    }),
    eq: jest.fn((field: string, value: unknown) => {
      calls.push(`${table}.eq:${field}=${String(value)}`);
      return query;
    }),
    lt: jest.fn((field: string, value: unknown) => {
      calls.push(`${table}.lt:${field}=${String(value)}`);
      return query;
    }),
    order: jest.fn((field: string) => {
      calls.push(`${table}.order:${field}`);
      return query;
    }),
    limit: jest.fn((value: number) => {
      calls.push(`${table}.limit:${value}`);
      return query;
    }),
    range: jest.fn(async (start: number, end: number) => {
      calls.push(`${table}.range:${start}-${end}`);
      return response;
    }),
    maybeSingle: jest.fn(async () => {
      calls.push(`${table}.maybeSingle`);
      return response;
    }),
  };
  return query;
};

const authenticatedClient = (
  responses: Record<string, QueryResponse[]>,
  calls: string[],
  authenticatedUserId = USER_ID,
): SupabaseClient => {
  const queues = Object.fromEntries(
    Object.entries(responses).map(([table, values]) => [table, [...values]]),
  ) as Record<string, QueryResponse[]>;

  return {
    auth: {
      getSession: jest.fn(async () => ({
        data: {
          session: {
            access_token: "test-access-token",
            user: { id: authenticatedUserId },
          },
        },
        error: null,
      })),
    },
    from: jest.fn((table: string) => {
      const response = queues[table]?.shift();
      if (!response) throw new Error(`Unexpected query for ${table}`);
      calls.push(`from:${table}`);
      return makeQuery(response, calls, table);
    }),
  } as unknown as SupabaseClient;
};

describe("generic current transcript version client", () => {
  it("pulls a current provider version and its own timestamp segments", async () => {
    const calls: string[] = [];
    const client = authenticatedClient(
      {
        transcript_versions: [{ data: providerVersion, error: null }],
        transcript_segments: [{ data: [sourceSegment], error: null }],
      },
      calls,
    );

    const snapshot = await fetchCurrentTranscriptVersionSnapshot(
      {
        sessionId: SESSION_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedUserId: USER_ID,
      },
      client,
    );

    expect(snapshot).toMatchObject({
      kind: "ready",
      currentVersion: {
        id: PROVIDER_VERSION_ID,
        version_origin: "provider",
      },
      intermediateVersions: [],
      evidenceVersion: null,
      evidenceSegments: [],
    });
    if (snapshot.kind === "ready") {
      expect(snapshot.currentSegments).toHaveLength(1);
    }
    expect(
      calls.filter((call) => call === "from:transcript_versions"),
    ).toHaveLength(1);
  });

  it("keeps user-edited Full Text separate from provider timestamp evidence", async () => {
    const calls: string[] = [];
    const client = authenticatedClient(
      {
        transcript_versions: [
          { data: userEditVersion, error: null },
          {
            data: { ...providerVersion, is_current: false },
            error: null,
          },
        ],
        transcript_segments: [
          { data: [], error: null },
          { data: [sourceSegment], error: null },
        ],
      },
      calls,
    );

    const snapshot = await fetchCurrentTranscriptVersionSnapshot(
      {
        sessionId: SESSION_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedUserId: USER_ID,
      },
      client,
    );

    expect(snapshot).toMatchObject({
      kind: "ready",
      currentVersion: {
        id: EDIT_VERSION_ID,
        plain_text: "corrected transcript",
      },
      currentSegments: [],
      intermediateVersions: [],
      evidenceVersion: {
        id: PROVIDER_VERSION_ID,
        version_origin: "provider",
        is_current: false,
      },
    });
    if (snapshot.kind === "ready") {
      expect(snapshot.evidenceSegments).toHaveLength(1);
      expect(snapshot.evidenceSegments[0].transcript_version_id).toBe(
        PROVIDER_VERSION_ID,
      );
    }
    expect(calls).toContain(
      `transcript_versions.eq:id=${PROVIDER_VERSION_ID}`,
    );
    expect(
      calls.some((call) =>
        call.startsWith("transcript_versions.eq:transcription_run_id="),
      ),
    ).toBe(false);
  });

  it("walks multiple immutable parents to the provider evidence version", async () => {
    const calls: string[] = [];
    const currentEdit = {
      ...userEditVersion,
      id: EDIT_VERSION_3_ID,
      version: 3,
      parent_version_id: EDIT_VERSION_ID,
    };
    const priorEdit = { ...userEditVersion, is_current: false };
    const client = authenticatedClient(
      {
        transcript_versions: [
          { data: currentEdit, error: null },
          { data: priorEdit, error: null },
          { data: { ...providerVersion, is_current: false }, error: null },
        ],
        transcript_segments: [
          { data: [], error: null },
          { data: [sourceSegment], error: null },
        ],
      },
      calls,
    );

    const snapshot = await fetchCurrentTranscriptVersionSnapshot(
      {
        sessionId: SESSION_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedUserId: USER_ID,
      },
      client,
    );

    expect(snapshot).toMatchObject({
      kind: "ready",
      currentVersion: { id: EDIT_VERSION_3_ID, version: 3 },
      intermediateVersions: [priorEdit],
      evidenceVersion: { id: PROVIDER_VERSION_ID, version: 1 },
    });
    expect(calls).toContain(`transcript_versions.eq:id=${EDIT_VERSION_ID}`);
    expect(calls).toContain(
      `transcript_versions.eq:id=${PROVIDER_VERSION_ID}`,
    );
  });

  it("resolves provider evidence through parent lineage when provenance is nullable", async () => {
    const calls: string[] = [];
    const client = authenticatedClient(
      {
        transcript_versions: [
          {
            data: { ...userEditVersion, transcription_run_id: null },
            error: null,
          },
          {
            data: {
              ...providerVersion,
              transcription_run_id: null,
              is_current: false,
            },
            error: null,
          },
        ],
        transcript_segments: [
          { data: [], error: null },
          { data: [sourceSegment], error: null },
        ],
      },
      calls,
    );

    const snapshot = await fetchCurrentTranscriptVersionSnapshot(
      {
        sessionId: SESSION_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedUserId: USER_ID,
      },
      client,
    );

    expect(snapshot).toMatchObject({
      kind: "ready",
      currentVersion: { transcription_run_id: null },
      evidenceVersion: {
        id: PROVIDER_VERSION_ID,
        transcription_run_id: null,
      },
    });
    if (snapshot.kind === "ready") {
      expect(snapshot.evidenceSegments).toHaveLength(1);
    }
    expect(
      calls.some((call) =>
        call.startsWith("transcript_versions.eq:transcription_run_id="),
      ),
    ).toBe(false);
  });

  it.each([
    ["workspace", { workspace_id: "99999999-9999-4999-8999-999999999999" }],
    ["session", { session_id: "99999999-9999-4999-8999-999999999999" }],
  ])(
    "fails closed when a parent has the wrong %s scope",
    async (_label, patch) => {
      const calls: string[] = [];
      const client = authenticatedClient(
        {
          transcript_versions: [
            { data: userEditVersion, error: null },
            {
              data: { ...providerVersion, ...patch, is_current: false },
              error: null,
            },
          ],
          transcript_segments: [{ data: [], error: null }],
        },
        calls,
      );

      await expect(
        fetchCurrentTranscriptVersionSnapshot(
          {
            sessionId: SESSION_ID,
            expectedWorkspaceId: WORKSPACE_ID,
            expectedUserId: USER_ID,
          },
          client,
        ),
      ).rejects.toMatchObject({ code: "TRANSCRIPT_CURRENT_INVALID" });
    },
  );

  it("fails closed when a parent version does not decrease", async () => {
    const calls: string[] = [];
    const client = authenticatedClient(
      {
        transcript_versions: [
          { data: userEditVersion, error: null },
          {
            data: { ...providerVersion, version: 2, is_current: false },
            error: null,
          },
        ],
        transcript_segments: [{ data: [], error: null }],
      },
      calls,
    );

    await expect(
      fetchCurrentTranscriptVersionSnapshot(
        {
          sessionId: SESSION_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedUserId: USER_ID,
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_CURRENT_INVALID" });
  });

  it("fails closed on a repeated parent id cycle", async () => {
    const calls: string[] = [];
    const currentEdit = {
      ...userEditVersion,
      id: EDIT_VERSION_3_ID,
      version: 3,
      parent_version_id: EDIT_VERSION_ID,
    };
    const cyclicParent = {
      ...userEditVersion,
      is_current: false,
      parent_version_id: EDIT_VERSION_3_ID,
    };
    const client = authenticatedClient(
      {
        transcript_versions: [
          { data: currentEdit, error: null },
          { data: cyclicParent, error: null },
        ],
        transcript_segments: [{ data: [], error: null }],
      },
      calls,
    );

    await expect(
      fetchCurrentTranscriptVersionSnapshot(
        {
          sessionId: SESSION_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedUserId: USER_ID,
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_CURRENT_INVALID" });
    expect(
      calls.filter((call) => call === "from:transcript_versions"),
    ).toHaveLength(2);
  });

  it("fails closed when immutable ancestry exceeds the lineage depth limit", async () => {
    const calls: string[] = [];
    const lineageId = (index: number) =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
    const currentEdit = {
      ...userEditVersion,
      id: EDIT_VERSION_3_ID,
      version: 1_000,
      parent_version_id: lineageId(1),
    };
    const parents = Array.from({ length: 64 }, (_, index) => ({
      data: {
        ...userEditVersion,
        id: lineageId(index + 1),
        version: 999 - index,
        is_current: false,
        parent_version_id: lineageId(index + 2),
      },
      error: null,
    }));
    const client = authenticatedClient(
      {
        transcript_versions: [{ data: currentEdit, error: null }, ...parents],
        transcript_segments: [{ data: [], error: null }],
      },
      calls,
    );

    await expect(
      fetchCurrentTranscriptVersionSnapshot(
        {
          sessionId: SESSION_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedUserId: USER_ID,
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_CURRENT_INVALID" });
    expect(
      calls.filter((call) => call === "from:transcript_versions"),
    ).toHaveLength(65);
  });

  it("rejects timestamp segments attached directly to a user edit", async () => {
    const calls: string[] = [];
    const client = authenticatedClient(
      {
        transcript_versions: [{ data: userEditVersion, error: null }],
        transcript_segments: [
          {
            data: [
              { ...sourceSegment, transcript_version_id: EDIT_VERSION_ID },
            ],
            error: null,
          },
        ],
      },
      calls,
    );

    await expect(
      fetchCurrentTranscriptVersionSnapshot(
        {
          sessionId: SESSION_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedUserId: USER_ID,
        },
        client,
      ),
    ).rejects.toBeInstanceOf(CurrentTranscriptVersionClientError);
  });

  it("normalizes malformed transcript rows into the current-version client error domain", async () => {
    const calls: string[] = [];
    const client = authenticatedClient(
      {
        transcript_versions: [
          {
            data: {
              ...providerVersion,
              transcription_run_id: "not-a-uuid",
            },
            error: null,
          },
        ],
      },
      calls,
    );

    await expect(
      fetchCurrentTranscriptVersionSnapshot(
        {
          sessionId: SESSION_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedUserId: USER_ID,
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "TRANSCRIPT_CURRENT_INVALID",
      retryable: true,
    });
  });

  it("returns an explicit empty snapshot when no current version is visible", async () => {
    const calls: string[] = [];
    const client = authenticatedClient(
      { transcript_versions: [{ data: null, error: null }] },
      calls,
    );

    await expect(
      fetchCurrentTranscriptVersionSnapshot(
        {
          sessionId: SESSION_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedUserId: USER_ID,
        },
        client,
      ),
    ).resolves.toEqual({
      kind: "empty",
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    });
  });

  it("requires the expected authenticated user and workspace scope", async () => {
    const calls: string[] = [];
    const wrongUserClient = authenticatedClient(
      {
        transcript_versions: [{ data: providerVersion, error: null }],
      },
      calls,
      "88888888-8888-4888-8888-888888888888",
    );

    await expect(
      fetchCurrentTranscriptVersionSnapshot(
        {
          sessionId: SESSION_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedUserId: USER_ID,
        },
        wrongUserClient,
      ),
    ).rejects.toMatchObject({
      code: "TRANSCRIPT_CURRENT_AUTHENTICATION_REQUIRED",
    });

    const mismatchCalls: string[] = [];
    const mismatchedClient = authenticatedClient(
      {
        transcript_versions: [
          {
            data: {
              ...providerVersion,
              workspace_id: "99999999-9999-4999-8999-999999999999",
            },
            error: null,
          },
        ],
      },
      mismatchCalls,
    );

    await expect(
      fetchCurrentTranscriptVersionSnapshot(
        {
          sessionId: SESSION_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedUserId: USER_ID,
        },
        mismatchedClient,
      ),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_CURRENT_INVALID" });
  });
});

describe("3D.1 complete current-version ancestry snapshots", () => {
  const input = {
    sessionId: SESSION_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedUserId: USER_ID,
  };

  it("retains every intermediate edit in immediate-parent-first order", async () => {
    const calls: string[] = [];
    const edit4Id = "99999999-9999-4999-8999-999999999999";
    const edit2 = { ...userEditVersion, is_current: false };
    const edit3 = {
      ...edit2,
      id: EDIT_VERSION_3_ID,
      version: 3,
      parent_version_id: EDIT_VERSION_ID,
      transcription_run_id: null,
    };
    const current = {
      ...edit3,
      id: edit4Id,
      version: 4,
      parent_version_id: EDIT_VERSION_3_ID,
      is_current: true,
    };
    const client = authenticatedClient({
      transcript_versions: [
        { data: current, error: null },
        { data: edit3, error: null },
        { data: edit2, error: null },
        { data: { ...providerVersion, is_current: false }, error: null },
      ],
      transcript_segments: [
        { data: [], error: null },
        { data: [sourceSegment], error: null },
      ],
    }, calls);

    const snapshot = await fetchCurrentTranscriptVersionSnapshot(input, client);
    expect(snapshot).toMatchObject({
      kind: "ready",
      currentVersion: { id: edit4Id },
      intermediateVersions: [edit3, edit2],
      evidenceVersion: { id: PROVIDER_VERSION_ID },
    });
    expect(calls.filter((call) => call === "from:transcript_versions")).toHaveLength(4);
    expect(calls.filter((call) => call === "from:transcript_segments")).toHaveLength(2);
    expect(calls).not.toContain(`transcript_versions.eq:transcription_run_id=${RUN_ID}`);
  });

  it("keeps an import leaf when the complete path has no provider evidence", async () => {
    const leaf = {
      ...providerVersion,
      version_origin: "import",
      transcription_run_id: null,
      is_current: false,
    };
    const snapshot = await fetchCurrentTranscriptVersionSnapshot(input,
      authenticatedClient({
        transcript_versions: [
          { data: userEditVersion, error: null },
          { data: leaf, error: null },
        ],
        transcript_segments: [{ data: [], error: null }],
      }, []),
    );
    expect(snapshot).toMatchObject({
      kind: "ready",
      intermediateVersions: [leaf],
      evidenceVersion: null,
      evidenceSegments: [],
    });
  });

  it("traverses an import intermediary without inventing timestamp mappings", async () => {
    const importedParent = {
      ...userEditVersion,
      version_origin: "import",
      is_current: false,
      transcription_run_id: null,
    };
    const current = {
      ...userEditVersion,
      id: EDIT_VERSION_3_ID,
      version: 3,
      parent_version_id: EDIT_VERSION_ID,
    };
    const snapshot = await fetchCurrentTranscriptVersionSnapshot(input,
      authenticatedClient({
        transcript_versions: [
          { data: current, error: null },
          { data: importedParent, error: null },
          { data: { ...providerVersion, is_current: false }, error: null },
        ],
        transcript_segments: [
          { data: [], error: null },
          { data: [sourceSegment], error: null },
        ],
      }, []),
    );
    expect(snapshot).toMatchObject({
      kind: "ready",
      intermediateVersions: [importedParent],
      evidenceVersion: { id: PROVIDER_VERSION_ID },
      currentSegments: [],
    });
  });

  it("does not return a partial path when a later parent is missing", async () => {
    const calls: string[] = [];
    await expect(fetchCurrentTranscriptVersionSnapshot(input,
      authenticatedClient({
        transcript_versions: [
          { data: { ...userEditVersion, id: EDIT_VERSION_3_ID, version: 3,
            parent_version_id: EDIT_VERSION_ID }, error: null },
          { data: { ...userEditVersion, is_current: false }, error: null },
          { data: null, error: null },
        ],
        transcript_segments: [{ data: [], error: null }],
      }, calls),
    )).rejects.toMatchObject({ code: "TRANSCRIPT_CURRENT_INVALID" });
    expect(calls.filter((call) => call === "from:transcript_segments")).toHaveLength(1);
  });

  it("accepts exactly 64 links including the provider, without extra remote reads", async () => {
    const id = (index: number) =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
    const parents = Array.from({ length: 63 }, (_, index) => ({
      ...userEditVersion,
      id: id(index + 1),
      version: 64 - index,
      parent_version_id: index === 62 ? PROVIDER_VERSION_ID : id(index + 2),
      is_current: false,
    }));
    const calls: string[] = [];
    const snapshot = await fetchCurrentTranscriptVersionSnapshot(input,
      authenticatedClient({
        transcript_versions: [
          { data: { ...userEditVersion, version: 65, parent_version_id: id(1) }, error: null },
          ...parents.map((data) => ({ data, error: null })),
          { data: { ...providerVersion, is_current: false }, error: null },
        ],
        transcript_segments: [
          { data: [], error: null },
          { data: [sourceSegment], error: null },
        ],
      }, calls),
    );
    expect(snapshot.kind).toBe("ready");
    if (snapshot.kind !== "ready") throw new Error("Expected ready snapshot.");
    expect(snapshot.intermediateVersions).toEqual(parents);
    expect(snapshot.evidenceVersion?.id).toBe(PROVIDER_VERSION_ID);
    expect(calls.filter((call) => call === "from:transcript_versions")).toHaveLength(65);
  });
});
