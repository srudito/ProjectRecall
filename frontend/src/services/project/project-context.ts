import type {
  ProjectRecord,
  SessionRecord,
} from "@/src/services/sqlite/repository";

export interface ProjectContextLabels {
  noProject: string;
  unknownProject: string;
  archived: string;
}

export const mergeProjectReferences = (
  ...groups: ProjectRecord[][]
): ProjectRecord[] => {
  const byId = new Map<string, ProjectRecord>();

  groups.flat().forEach((project) => {
    byId.set(project.id, project);
  });

  return [...byId.values()];
};

export const buildProjectLookup = (
  projects: ProjectRecord[],
): Map<string, ProjectRecord> =>
  new Map(projects.map((project) => [project.id, project]));

export const referencedProjectIds = (
  sessions: SessionRecord[],
): string[] => [
  ...new Set(
    sessions
      .map((session) => session.project_id)
      .filter((projectId): projectId is string => Boolean(projectId)),
  ),
];

export const projectDisplayNameForSession = (
  session: SessionRecord,
  projectLookup: ReadonlyMap<string, ProjectRecord>,
  labels: ProjectContextLabels,
): string => {
  if (!session.project_id) {
    return labels.noProject;
  }

  const project = projectLookup.get(session.project_id);
  if (!project) {
    return labels.unknownProject;
  }

  return project.status === "archived"
    ? `${project.name} (${labels.archived})`
    : project.name;
};

export const sessionsForProject = (
  sessions: SessionRecord[],
  projectId: string,
): SessionRecord[] =>
  sessions.filter((session) => session.project_id === projectId);
