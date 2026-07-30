import {
  buildProjectLookup,
  mergeProjectReferences,
  projectDisplayNameForSession,
  referencedProjectIds,
  sessionsForProject,
} from "@/src/services/project/project-context";
import type {
  ProjectRecord,
  SessionRecord,
} from "@/src/services/sqlite/repository";

const project = (
  id: string,
  name: string,
  status = "active",
): ProjectRecord => ({
  id,
  workspace_id: "11111111-1111-4111-8111-111111111111",
  name,
  description: null,
  status,
  default_spoken_language_mode: null,
  default_expected_spoken_languages: [],
  default_summary_output_language: null,
  default_translation_target_language: null,
  created_by: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-07-30T00:00:00.000Z",
  updated_at: "2026-07-30T00:00:00.000Z",
  deleted_at: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: "2026-07-30T00:00:00.000Z",
});

const session = (
  id: string,
  projectId: string | null,
): SessionRecord => ({
  id,
  workspace_id: "11111111-1111-4111-8111-111111111111",
  project_id: projectId,
  created_by: "22222222-2222-4222-8222-222222222222",
  title: `Session ${id}`,
  session_type: "standard",
  status: "recorded",
  started_at: null,
  stopped_at: null,
  total_recorded_duration_ms: 0,
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
  created_at: "2026-07-30T00:00:00.000Z",
  updated_at: "2026-07-30T00:00:00.000Z",
  deleted_at: null,
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: "2026-07-30T00:00:00.000Z",
});

const labels = {
  noProject: "No project",
  unknownProject: "Unknown project",
  archived: "Archived",
};

describe("project context helpers", () => {
  it("merges project references by stable project id", () => {
    const first = project("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "First");
    const updated = { ...first, name: "Updated" };

    expect(mergeProjectReferences([first], [updated])).toEqual([updated]);
  });

  it("extracts unique referenced project ids", () => {
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    expect(
      referencedProjectIds([
        session("s1", projectId),
        session("s2", projectId),
        session("s3", null),
      ]),
    ).toEqual([projectId]);
  });

  it("resolves active, archived, missing, and unassigned projects", () => {
    const active = project(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "Active project",
    );
    const archived = project(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "Old project",
      "archived",
    );
    const lookup = buildProjectLookup([active, archived]);

    expect(projectDisplayNameForSession(session("s1", active.id), lookup, labels)).toBe(
      "Active project",
    );
    expect(
      projectDisplayNameForSession(session("s2", archived.id), lookup, labels),
    ).toBe("Old project (Archived)");
    expect(
      projectDisplayNameForSession(
        session("s3", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        lookup,
        labels,
      ),
    ).toBe("Unknown project");
    expect(projectDisplayNameForSession(session("s4", null), lookup, labels)).toBe(
      "No project",
    );
  });

  it("returns only sessions belonging to the selected project", () => {
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    expect(
      sessionsForProject(
        [session("s1", projectId), session("s2", null)],
        projectId,
      ).map((item) => item.id),
    ).toEqual(["s1"]);
  });
});
