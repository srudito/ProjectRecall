import {
  buildProjectStats,
  buildSessionSections,
  LIBRARY_SESSIONS_BACK_TO_TOP_THRESHOLD,
  isLibraryViewMode,
  isProjectSortMode,
  isSessionSortMode,
  sessionDisplayTimestamp,
  shouldShowSessionsBackToTop,
  sortProjects,
  sortSessions,
} from "@/src/services/library/library-organization";
import type {
  ProjectRecord,
  SessionRecord,
} from "@/src/services/sqlite/repository";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

const localIso = (
  year: number,
  month: number,
  day: number,
  hour = 12,
): string => new Date(year, month - 1, day, hour, 0, 0).toISOString();

const project = (
  id: string,
  name: string,
  createdAt: string,
  updatedAt = createdAt,
): ProjectRecord => ({
  id,
  workspace_id: workspaceId,
  name,
  description: null,
  status: "active",
  default_spoken_language_mode: null,
  default_expected_spoken_languages: [],
  default_summary_output_language: null,
  default_translation_target_language: null,
  created_by: userId,
  created_at: createdAt,
  updated_at: updatedAt,
  deleted_at: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: updatedAt,
});

const session = (input: {
  id: string;
  title?: string;
  projectId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  durationMs?: number;
}): SessionRecord => ({
  id: input.id,
  workspace_id: workspaceId,
  project_id: input.projectId ?? null,
  created_by: userId,
  title: input.title ?? input.id,
  session_type: "standard",
  status: "recorded",
  started_at: input.startedAt ?? null,
  stopped_at: null,
  total_recorded_duration_ms: input.durationMs ?? 0,
  spoken_language_mode: "AUTO_DETECT",
  expected_spoken_languages: [],
  detected_spoken_languages: [],
  primary_detected_language: null,
  language_detection_status: "NOT_STARTED",
  summary_output_language: null,
  translation_target_language: null,
  transcript_display_mode: "ORIGINAL",
  language_metadata: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  created_at: input.createdAt,
  updated_at: input.createdAt,
  deleted_at: null,
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: input.createdAt,
});

describe("library organization", () => {
  it("uses recording start time before creation time", () => {
    const row = session({
      id: "session-1",
      createdAt: localIso(2026, 7, 31, 8),
      startedAt: localIso(2026, 7, 31, 9),
    });

    expect(sessionDisplayTimestamp(row)).toBe(row.started_at);
  });

  it("groups chronological sessions by local date", () => {
    const now = new Date(2026, 6, 31, 12, 0, 0);
    const rows = [
      session({
        id: "today",
        createdAt: localIso(2026, 7, 31, 9),
      }),
      session({
        id: "yesterday",
        createdAt: localIso(2026, 7, 30, 9),
      }),
      session({
        id: "this-week",
        createdAt: localIso(2026, 7, 28, 9),
      }),
      session({
        id: "earlier",
        createdAt: localIso(2026, 7, 1, 9),
      }),
    ];

    const sections = buildSessionSections(rows, "newest", "en", now);

    expect(sections.map((section) => section.key)).toEqual([
      "today",
      "yesterday",
      "thisWeek",
      "earlier",
    ]);
    expect(sections.flatMap((section) => section.data.map((item) => item.id))).toEqual([
      "today",
      "yesterday",
      "this-week",
      "earlier",
    ]);
  });

  it("sorts duration modes globally without date sections", () => {
    const rows = [
      session({
        id: "short",
        createdAt: localIso(2026, 7, 31),
        durationMs: 10_000,
      }),
      session({
        id: "long",
        createdAt: localIso(2026, 7, 1),
        durationMs: 90_000,
      }),
    ];

    const sections = buildSessionSections(rows, "longest", "en");

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("all");
    expect(sections[0].data.map((item) => item.id)).toEqual([
      "long",
      "short",
    ]);
  });

  it("sorts sessions by newest, oldest, longest, and shortest", () => {
    const rows = [
      session({
        id: "older-long",
        createdAt: localIso(2026, 7, 1),
        durationMs: 90_000,
      }),
      session({
        id: "newer-short",
        createdAt: localIso(2026, 7, 31),
        durationMs: 10_000,
      }),
    ];

    expect(sortSessions(rows, "newest").map((item) => item.id)).toEqual([
      "newer-short",
      "older-long",
    ]);
    expect(sortSessions(rows, "oldest").map((item) => item.id)).toEqual([
      "older-long",
      "newer-short",
    ]);
    expect(sortSessions(rows, "longest").map((item) => item.id)).toEqual([
      "older-long",
      "newer-short",
    ]);
    expect(sortSessions(rows, "shortest").map((item) => item.id)).toEqual([
      "newer-short",
      "older-long",
    ]);
  });

  it("sorts starred sessions first without changing the remaining chronology", () => {
    const rows = [
      session({
        id: "newest-unstarred",
        createdAt: localIso(2026, 7, 31),
      }),
      session({
        id: "older-starred",
        createdAt: localIso(2026, 7, 1),
      }),
      session({
        id: "middle-unstarred",
        createdAt: localIso(2026, 7, 20),
      }),
    ];

    expect(
      sortSessions(
        rows,
        "starred",
        new Set(["older-starred"]),
      ).map((item) => item.id),
    ).toEqual([
      "older-starred",
      "newest-unstarred",
      "middle-unstarred",
    ]);
  });

  it("calculates session count and last project activity", () => {
    const projectA = project(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "Alpha",
      localIso(2026, 7, 1),
    );
    const projectB = project(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "Beta",
      localIso(2026, 7, 10),
    );
    const rows = [
      session({
        id: "a-1",
        projectId: projectA.id,
        createdAt: localIso(2026, 7, 20),
      }),
      session({
        id: "a-2",
        projectId: projectA.id,
        createdAt: localIso(2026, 7, 30),
      }),
    ];

    const stats = buildProjectStats([projectA, projectB], rows);

    expect(stats.get(projectA.id)?.sessionCount).toBe(2);
    expect(stats.get(projectA.id)?.lastActivityAt).toBe(
      rows[1].created_at,
    );
    expect(stats.get(projectB.id)?.sessionCount).toBe(0);
  });

  it("sorts projects by activity, creation time, and name", () => {
    const projectA = project(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "Zulu",
      localIso(2026, 7, 1),
    );
    const projectB = project(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "Alpha",
      localIso(2026, 7, 20),
    );
    const rows = [
      session({
        id: "a-1",
        projectId: projectA.id,
        createdAt: localIso(2026, 7, 30),
      }),
    ];
    const stats = buildProjectStats([projectA, projectB], rows);

    expect(
      sortProjects([projectA, projectB], "recent", stats, "en").map(
        (item) => item.id,
      ),
    ).toEqual([projectA.id, projectB.id]);
    expect(
      sortProjects([projectA, projectB], "newest", stats, "en").map(
        (item) => item.id,
      ),
    ).toEqual([projectB.id, projectA.id]);
    expect(
      sortProjects([projectA, projectB], "name", stats, "en").map(
        (item) => item.id,
      ),
    ).toEqual([projectB.id, projectA.id]);
  });

  it("shows the Sessions back-to-top action only after a meaningful scroll", () => {
    expect(shouldShowSessionsBackToTop(-1)).toBe(false);
    expect(shouldShowSessionsBackToTop(0)).toBe(false);
    expect(
      shouldShowSessionsBackToTop(
        LIBRARY_SESSIONS_BACK_TO_TOP_THRESHOLD - 1,
      ),
    ).toBe(false);
    expect(
      shouldShowSessionsBackToTop(
        LIBRARY_SESSIONS_BACK_TO_TOP_THRESHOLD,
      ),
    ).toBe(true);
    expect(shouldShowSessionsBackToTop(Number.POSITIVE_INFINITY)).toBe(
      false,
    );
  });

  it("validates persisted view and sort preferences", () => {
    expect(isLibraryViewMode("card")).toBe(true);
    expect(isLibraryViewMode("grid")).toBe(false);
    expect(isSessionSortMode("longest")).toBe(true);
    expect(isSessionSortMode("starred")).toBe(true);
    expect(isSessionSortMode("recent")).toBe(false);
    expect(isProjectSortMode("recent")).toBe(true);
    expect(isProjectSortMode("longest")).toBe(false);
  });
});
