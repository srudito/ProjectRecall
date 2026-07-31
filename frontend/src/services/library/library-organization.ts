import type {
  ProjectRecord,
  SessionRecord,
} from "@/src/services/sqlite/repository";

export type LibraryViewMode = "card" | "compact";
export type SessionSortMode = "newest" | "oldest" | "longest" | "shortest";
export type ProjectSortMode = "recent" | "newest" | "name";
export type SessionDateGroupKey =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "earlier"
  | "all";

export interface SessionLibrarySection {
  key: SessionDateGroupKey;
  data: SessionRecord[];
}

export interface ProjectLibraryStats {
  sessionCount: number;
  lastActivityAt: string;
  lastActivityMs: number;
}

export const LIBRARY_PREFERENCE_KEYS = {
  sessionViewMode: "library.sessions.viewMode.v1",
  sessionSortMode: "library.sessions.sortMode.v1",
  projectViewMode: "library.projects.viewMode.v1",
  projectSortMode: "library.projects.sortMode.v1",
} as const;

const localeForLanguage = (language: string): string =>
  language.toLowerCase().startsWith("id") ? "id-ID" : "en-US";

const timestampMs = (value: string | null | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const startOfDayMs = (date: Date): number =>
  new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();

const startOfWeekMs = (date: Date, weekStartsOnMonday: boolean): number => {
  const current = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const day = current.getDay();
  const offset = weekStartsOnMonday
    ? day === 0
      ? 6
      : day - 1
    : day;
  current.setDate(current.getDate() - offset);
  return current.getTime();
};

const dateGroupForTimestamp = (
  valueMs: number,
  language: string,
  now: Date,
): SessionDateGroupKey => {
  if (valueMs <= 0) return "earlier";

  const sessionDate = new Date(valueMs);
  const sessionDay = startOfDayMs(sessionDate);
  const today = startOfDayMs(now);
  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  yesterday.setDate(yesterday.getDate() - 1);

  if (sessionDay === today) return "today";
  if (sessionDay === yesterday.getTime()) return "yesterday";

  const weekStartsOnMonday = localeForLanguage(language) === "id-ID";
  if (sessionDay >= startOfWeekMs(now, weekStartsOnMonday)) {
    return "thisWeek";
  }

  return "earlier";
};

export const isLibraryViewMode = (
  value: string | null,
): value is LibraryViewMode => value === "card" || value === "compact";

export const isSessionSortMode = (
  value: string | null,
): value is SessionSortMode =>
  value === "newest" ||
  value === "oldest" ||
  value === "longest" ||
  value === "shortest";

export const isProjectSortMode = (
  value: string | null,
): value is ProjectSortMode =>
  value === "recent" || value === "newest" || value === "name";

/**
 * The recording start time is the most useful timestamp for a completed
 * session. Draft sessions fall back to their creation time.
 */
export const sessionDisplayTimestamp = (session: SessionRecord): string =>
  session.started_at ?? session.created_at;

export const sessionDateGroupKey = (
  session: SessionRecord,
  language: string,
  now = new Date(),
): SessionDateGroupKey => {
  return dateGroupForTimestamp(
    timestampMs(sessionDisplayTimestamp(session)),
    language,
    now,
  );
};

export const formatLibraryDateTime = (
  value: string | null | undefined,
  language: string,
  now = new Date(),
): string => {
  const valueMs = timestampMs(value);
  if (valueMs <= 0) return "";

  const date = new Date(valueMs);
  const locale = localeForLanguage(language);
  const group = dateGroupForTimestamp(valueMs, language, now);

  try {
    if (group === "today" || group === "yesterday") {
      return new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    }

    if (group === "thisWeek") {
      return new Intl.DateTimeFormat(locale, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    }

    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
};

export const sortSessions = (
  sessions: SessionRecord[],
  sortMode: SessionSortMode,
): SessionRecord[] => {
  const copy = [...sessions];

  copy.sort((left, right) => {
    const leftTimestamp = timestampMs(sessionDisplayTimestamp(left));
    const rightTimestamp = timestampMs(sessionDisplayTimestamp(right));

    switch (sortMode) {
      case "oldest":
        return (
          leftTimestamp - rightTimestamp ||
          left.title.localeCompare(right.title)
        );

      case "longest":
        return (
          right.total_recorded_duration_ms -
            left.total_recorded_duration_ms ||
          rightTimestamp - leftTimestamp
        );

      case "shortest":
        return (
          left.total_recorded_duration_ms -
            right.total_recorded_duration_ms ||
          rightTimestamp - leftTimestamp
        );

      case "newest":
      default:
        return (
          rightTimestamp - leftTimestamp ||
          left.title.localeCompare(right.title)
        );
    }
  });

  return copy;
};

export const buildSessionSections = (
  sessions: SessionRecord[],
  sortMode: SessionSortMode,
  language: string,
  now = new Date(),
): SessionLibrarySection[] => {
  const sorted = sortSessions(sessions, sortMode);

  // Duration sorts are intentionally global. Chronological sorts use date
  // sections so the user can scan recent recordings quickly.
  if (sortMode === "longest" || sortMode === "shortest") {
    return sorted.length > 0 ? [{ key: "all", data: sorted }] : [];
  }

  const buckets = new Map<SessionDateGroupKey, SessionRecord[]>([
    ["today", []],
    ["yesterday", []],
    ["thisWeek", []],
    ["earlier", []],
  ]);

  sorted.forEach((session) => {
    const key = sessionDateGroupKey(session, language, now);
    buckets.get(key)?.push(session);
  });

  const order: SessionDateGroupKey[] =
    sortMode === "oldest"
      ? ["earlier", "thisWeek", "yesterday", "today"]
      : ["today", "yesterday", "thisWeek", "earlier"];

  return order
    .map((key) => ({ key, data: buckets.get(key) ?? [] }))
    .filter((section) => section.data.length > 0);
};

export const buildProjectStats = (
  projects: ProjectRecord[],
  sessions: SessionRecord[],
): Map<string, ProjectLibraryStats> => {
  const stats = new Map<string, ProjectLibraryStats>();

  projects.forEach((project) => {
    stats.set(project.id, {
      sessionCount: 0,
      lastActivityAt: project.updated_at,
      lastActivityMs: timestampMs(project.updated_at),
    });
  });

  sessions.forEach((session) => {
    if (!session.project_id) return;

    const current = stats.get(session.project_id);
    if (!current) return;

    const activityAt = sessionDisplayTimestamp(session);
    const activityMs = timestampMs(activityAt);

    stats.set(session.project_id, {
      sessionCount: current.sessionCount + 1,
      lastActivityAt:
        activityMs > current.lastActivityMs
          ? activityAt
          : current.lastActivityAt,
      lastActivityMs: Math.max(activityMs, current.lastActivityMs),
    });
  });

  return stats;
};

export const sortProjects = (
  projects: ProjectRecord[],
  sortMode: ProjectSortMode,
  stats: ReadonlyMap<string, ProjectLibraryStats>,
  language: string,
): ProjectRecord[] => {
  const copy = [...projects];
  const locale = localeForLanguage(language);

  copy.sort((left, right) => {
    switch (sortMode) {
      case "name":
        return left.name.localeCompare(right.name, locale, {
          sensitivity: "base",
        });

      case "newest":
        return (
          timestampMs(right.created_at) - timestampMs(left.created_at) ||
          left.name.localeCompare(right.name, locale)
        );

      case "recent":
      default:
        return (
          (stats.get(right.id)?.lastActivityMs ?? 0) -
            (stats.get(left.id)?.lastActivityMs ?? 0) ||
          left.name.localeCompare(right.name, locale)
        );
    }
  });

  return copy;
};
