import type { SupabaseClient } from "@supabase/supabase-js";

import type { ProjectRecord } from "@/src/services/sqlite/repository";

import { getSupabase } from "./client";

export type ProjectSyncErrorCode =
  | "SUPABASE_NOT_CONFIGURED"
  | "AUTHENTICATION_REQUIRED"
  | "NETWORK_UNAVAILABLE"
  | "RATE_LIMITED"
  | "REMOTE_SERVER_ERROR"
  | "REMOTE_ACCESS_DENIED"
  | "REMOTE_CONFLICT"
  | "REMOTE_VALIDATION_ERROR"
  | "TRANSCRIPTION_PROVIDER_SUBMISSION_IN_PROGRESS"
  | "TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED"
  | "REMOTE_UNKNOWN_ERROR";

export class ProjectSyncError extends Error {
  readonly code: ProjectSyncErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly cause?: unknown;

  constructor(
    code: ProjectSyncErrorCode,
    message: string,
    options: {
      retryable: boolean;
      status?: number | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ProjectSyncError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.cause = options.cause;
  }
}

interface RemoteErrorShape {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  status?: number;
}

interface RemoteProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: string;
  default_spoken_language_mode: string | null;
  default_expected_spoken_languages: string[] | null;
  default_summary_output_language: string | null;
  default_translation_target_language: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const PROJECT_COLUMNS =
  "id,workspace_id,name,description,status,default_spoken_language_mode,default_expected_spoken_languages,default_summary_output_language,default_translation_target_language,created_by,created_at,updated_at,deleted_at" as const;

const safeMessageForCode = (code: ProjectSyncErrorCode): string => {
  switch (code) {
    case "SUPABASE_NOT_CONFIGURED":
      return "Cloud synchronization is not configured.";
    case "AUTHENTICATION_REQUIRED":
      return "Sign in again to synchronize this project.";
    case "NETWORK_UNAVAILABLE":
      return "The project is saved locally and will synchronize when the network is available.";
    case "RATE_LIMITED":
      return "Cloud synchronization is temporarily busy and will retry automatically.";
    case "REMOTE_SERVER_ERROR":
      return "The cloud service is temporarily unavailable and will retry automatically.";
    case "REMOTE_ACCESS_DENIED":
      return "You do not have permission to synchronize this project.";
    case "REMOTE_CONFLICT":
      return "The project could not be synchronized because of a data conflict.";
    case "REMOTE_VALIDATION_ERROR":
      return "The project data was rejected by the cloud database.";
    case "TRANSCRIPTION_PROVIDER_SUBMISSION_IN_PROGRESS":
      return "Transcription submission is still in progress. Session cleanup will retry automatically.";
    case "TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED":
      return "Transcription provider cleanup is still pending. Session cleanup will retry automatically.";
    default:
      return "The project could not be synchronized.";
  }
};

export const normalizeProjectSyncError = (
  error: unknown,
  statusOverride?: number | null,
): ProjectSyncError => {
  if (error instanceof ProjectSyncError) return error;

  const shape = (error ?? {}) as RemoteErrorShape;
  const status = statusOverride ?? shape.status ?? null;
  const code = shape.code ?? "";
  const message = String(shape.message ?? error ?? "").toLowerCase();

  if (
    error instanceof TypeError ||
    message.includes("failed to fetch") ||
    message.includes("network request failed") ||
    message.includes("networkerror") ||
    message.includes("timeout")
  ) {
    const mappedCode: ProjectSyncErrorCode = "NETWORK_UNAVAILABLE";
    return new ProjectSyncError(mappedCode, safeMessageForCode(mappedCode), {
      retryable: true,
      status,
      cause: error,
    });
  }

  if (status === 401 || code === "PGRST301" || message.includes("jwt")) {
    const mappedCode: ProjectSyncErrorCode = "AUTHENTICATION_REQUIRED";
    return new ProjectSyncError(mappedCode, safeMessageForCode(mappedCode), {
      retryable: true,
      status,
      cause: error,
    });
  }

  if (status === 429) {
    const mappedCode: ProjectSyncErrorCode = "RATE_LIMITED";
    return new ProjectSyncError(mappedCode, safeMessageForCode(mappedCode), {
      retryable: true,
      status,
      cause: error,
    });
  }

  if ((status != null && status >= 500) || code.startsWith("08")) {
    const mappedCode: ProjectSyncErrorCode = "REMOTE_SERVER_ERROR";
    return new ProjectSyncError(mappedCode, safeMessageForCode(mappedCode), {
      retryable: true,
      status,
      cause: error,
    });
  }

  if (
    status === 403 ||
    code === "42501" ||
    message.includes("row-level security") ||
    message.includes("permission denied")
  ) {
    const mappedCode: ProjectSyncErrorCode = "REMOTE_ACCESS_DENIED";
    return new ProjectSyncError(mappedCode, safeMessageForCode(mappedCode), {
      retryable: false,
      status,
      cause: error,
    });
  }

  if (status === 409 || code === "23505") {
    const mappedCode: ProjectSyncErrorCode = "REMOTE_CONFLICT";
    return new ProjectSyncError(mappedCode, safeMessageForCode(mappedCode), {
      retryable: false,
      status,
      cause: error,
    });
  }

  if (
    status === 400 ||
    code.startsWith("22") ||
    code.startsWith("23") ||
    code.startsWith("PGRST")
  ) {
    const mappedCode: ProjectSyncErrorCode = "REMOTE_VALIDATION_ERROR";
    return new ProjectSyncError(mappedCode, safeMessageForCode(mappedCode), {
      retryable: false,
      status,
      cause: error,
    });
  }

  const mappedCode: ProjectSyncErrorCode = "REMOTE_UNKNOWN_ERROR";
  return new ProjectSyncError(mappedCode, safeMessageForCode(mappedCode), {
    retryable: false,
    status,
    cause: error,
  });
};

const requireAuthenticatedClient = async (
  clientOverride?: SupabaseClient,
): Promise<{ client: SupabaseClient; userId: string }> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new ProjectSyncError(
      "SUPABASE_NOT_CONFIGURED",
      safeMessageForCode("SUPABASE_NOT_CONFIGURED"),
      { retryable: false },
    );
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw normalizeProjectSyncError(error, 401);
  const userId = data.session?.user.id;
  if (!userId) {
    throw new ProjectSyncError(
      "AUTHENTICATION_REQUIRED",
      safeMessageForCode("AUTHENTICATION_REQUIRED"),
      { retryable: true, status: 401 },
    );
  }

  return { client, userId };
};

const toRemotePayload = (project: ProjectRecord): RemoteProjectRow => ({
  id: project.id,
  workspace_id: project.workspace_id,
  name: project.name,
  description: project.description,
  status: project.status,
  default_spoken_language_mode: project.default_spoken_language_mode,
  default_expected_spoken_languages: project.default_expected_spoken_languages,
  default_summary_output_language: project.default_summary_output_language,
  default_translation_target_language: project.default_translation_target_language,
  created_by: project.created_by,
  created_at: project.created_at,
  updated_at: project.updated_at,
  deleted_at: project.deleted_at,
});

export const mapRemoteProject = (row: RemoteProjectRow): ProjectRecord => ({
  ...row,
  default_expected_spoken_languages: row.default_expected_spoken_languages ?? null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  last_sync_error_code: null,
  last_sync_error_message: null,
  last_synced_at: new Date().toISOString(),
});

export const upsertRemoteProject = async (
  project: ProjectRecord,
  clientOverride?: SupabaseClient,
): Promise<ProjectRecord> => {
  const { client, userId } = await requireAuthenticatedClient(clientOverride);
  if (userId !== project.created_by) {
    throw new ProjectSyncError(
      "REMOTE_ACCESS_DENIED",
      safeMessageForCode("REMOTE_ACCESS_DENIED"),
      { retryable: false, status: 403 },
    );
  }

  const response = await client
    .from("projects")
    .upsert(toRemotePayload(project), { onConflict: "id" })
    .select(PROJECT_COLUMNS)
    .single();

if (response.error) {
  throw normalizeProjectSyncError(response.error, response.status);
}

return mapRemoteProject(response.data);
};

export const fetchRemoteProjects = async (
  workspaceId: string,
  clientOverride?: SupabaseClient,
): Promise<ProjectRecord[]> => {
  const { client } = await requireAuthenticatedClient(clientOverride);

  const response = await client
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (response.error) {
    throw normalizeProjectSyncError(response.error, response.status);
  }

  return (response.data ?? []).map(mapRemoteProject);
};

export const fetchRemoteProject = async (
  projectId: string,
  clientOverride?: SupabaseClient,
): Promise<ProjectRecord | null> => {
  const { client } = await requireAuthenticatedClient(clientOverride);

  const response = await client
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("id", projectId)
    .maybeSingle();

  if (response.error) {
    throw normalizeProjectSyncError(response.error, response.status);
  }

  return response.data ? mapRemoteProject(response.data) : null;
};
