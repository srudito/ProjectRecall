import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabase } from "@/src/services/supabase/client";

import {
  parseSyncedTranscriptSegment,
  parseSyncedTranscriptVersion,
  parseSyncedTranscriptVersionRecord,
} from "./result-client";
import {
  isTranscriptLineageParent,
  MAX_TRANSCRIPT_LINEAGE_DEPTH,
  type CurrentTranscriptVersionSnapshot,
  type SyncedTranscriptSegment,
  type SyncedTranscriptVersionRecord,
} from "./result-types";

export type CurrentTranscriptVersionClientErrorCode =
  | "SUPABASE_NOT_CONFIGURED"
  | "TRANSCRIPT_CURRENT_AUTHENTICATION_REQUIRED"
  | "TRANSCRIPT_CURRENT_QUERY_FAILED"
  | "TRANSCRIPT_CURRENT_INVALID"
  | "NETWORK_UNAVAILABLE";

export class CurrentTranscriptVersionClientError extends Error {
  readonly code: CurrentTranscriptVersionClientErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: CurrentTranscriptVersionClientErrorCode,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message);
    this.name = "CurrentTranscriptVersionClientError";
    this.code = code;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEGMENT_PAGE_SIZE = 500;
const MAX_SEGMENTS = 100_000;
const VERSION_SELECT =
  "id,workspace_id,session_id,transcription_run_id,created_by,version,version_origin,version_status,parent_version_id,plain_text,language_summary,content_checksum_sha256,is_current,created_at,updated_at";
const SEGMENT_SELECT =
  "id,workspace_id,session_id,transcript_version_id,segment_index,start_ms,end_ms,text,language_code,speaker_label,confidence,provider_segment_id,created_at,updated_at";

const invalid = (cause?: unknown): CurrentTranscriptVersionClientError =>
  new CurrentTranscriptVersionClientError(
    "TRANSCRIPT_CURRENT_INVALID",
    "The transcript service returned an invalid current version.",
    { retryable: true, cause },
  );

const queryFailed = (cause: unknown): CurrentTranscriptVersionClientError =>
  new CurrentTranscriptVersionClientError(
    "TRANSCRIPT_CURRENT_QUERY_FAILED",
    "The current transcript could not be synchronized yet.",
    { retryable: true, cause },
  );

const looksLikeNetworkFailure = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "").toLowerCase()
      : String(error ?? "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("network request failed") ||
    message.includes("networkerror") ||
    message.includes("timeout")
  );
};

export const normalizeCurrentTranscriptVersionClientError = (
  error: unknown,
): CurrentTranscriptVersionClientError => {
  if (error instanceof CurrentTranscriptVersionClientError) return error;
  if (looksLikeNetworkFailure(error)) {
    return new CurrentTranscriptVersionClientError(
      "NETWORK_UNAVAILABLE",
      "The current transcript will retry when the network is available.",
      { retryable: true, cause: error },
    );
  }
  return queryFailed(error);
};

const normalizeUuidInput = (value: string): string => {
  if (!UUID_PATTERN.test(value)) throw invalid();
  return value.toLowerCase();
};

const requireSession = async (
  client: SupabaseClient,
  expectedUserId: string,
): Promise<void> => {
  const response = await client.auth.getSession();
  if (
    response.error ||
    !response.data.session?.access_token ||
    response.data.session.user.id.toLowerCase() !== expectedUserId
  ) {
    throw new CurrentTranscriptVersionClientError(
      "TRANSCRIPT_CURRENT_AUTHENTICATION_REQUIRED",
      "Sign in again before synchronizing the current transcript.",
      { retryable: true, cause: response.error },
    );
  }
};

interface ExactSegmentSnapshot {
  segments: SyncedTranscriptSegment[];
  expectedSegmentCount: number;
}

const readSegments = async (
  client: SupabaseClient,
  version: SyncedTranscriptVersionRecord,
): Promise<ExactSegmentSnapshot> => {
  const segments: SyncedTranscriptSegment[] = [];
  let expectedSegmentCount: number | null = null;
  for (let offset = 0; offset <= MAX_SEGMENTS; offset += SEGMENT_PAGE_SIZE) {
    const response = await client
      .from("transcript_segments")
      .select(SEGMENT_SELECT, { count: "exact" })
      .eq("transcript_version_id", version.id)
      .order("segment_index", { ascending: true })
      .range(offset, offset + SEGMENT_PAGE_SIZE - 1);
    if (response.error) {
      throw normalizeCurrentTranscriptVersionClientError(response.error);
    }
    if (
      !Number.isSafeInteger(response.count) ||
      (response.count as number) < 0 ||
      (response.count as number) > MAX_SEGMENTS ||
      (expectedSegmentCount !== null && response.count !== expectedSegmentCount)
    ) {
      throw invalid(new Error("TRANSCRIPT_CURRENT_SEGMENT_COUNT_INVALID"));
    }
    expectedSegmentCount = response.count as number;

    let page: SyncedTranscriptSegment[];
    try {
      page = (response.data ?? []).map(parseSyncedTranscriptSegment);
    } catch (error) {
      throw invalid(error);
    }
    if (page.length > SEGMENT_PAGE_SIZE) throw invalid();
    for (const segment of page) {
      if (
        segment.workspace_id !== version.workspace_id ||
        segment.session_id !== version.session_id ||
        segment.transcript_version_id !== version.id ||
        segment.segment_index !== segments.length
      ) {
        throw invalid();
      }
      segments.push(segment);
    }
    if (segments.length > expectedSegmentCount) throw invalid();
    if (segments.length === expectedSegmentCount) {
      return { segments, expectedSegmentCount };
    }
    if (page.length < SEGMENT_PAGE_SIZE) {
      throw invalid(new Error("TRANSCRIPT_CURRENT_SEGMENT_COUNT_MISMATCH"));
    }
  }
  throw invalid(new Error("TRANSCRIPT_CURRENT_SEGMENT_LIMIT_EXCEEDED"));
};

export const fetchCurrentTranscriptVersionSnapshot = async (
  input: {
    sessionId: string;
    expectedWorkspaceId: string;
    expectedUserId: string;
  },
  clientOverride?: SupabaseClient,
): Promise<CurrentTranscriptVersionSnapshot> => {
  const client = clientOverride ?? getSupabase();
  if (!client) {
    throw new CurrentTranscriptVersionClientError(
      "SUPABASE_NOT_CONFIGURED",
      "Cloud transcript synchronization is not configured.",
      { retryable: false },
    );
  }

  const sessionId = normalizeUuidInput(input.sessionId);
  const workspaceId = normalizeUuidInput(input.expectedWorkspaceId);
  const userId = normalizeUuidInput(input.expectedUserId);
  await requireSession(client, userId);

  const currentResponse = await client
    .from("transcript_versions")
    .select(VERSION_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .eq("is_current", true)
    .maybeSingle();
  if (currentResponse.error) {
    throw normalizeCurrentTranscriptVersionClientError(currentResponse.error);
  }
  if (!currentResponse.data) {
    return { kind: "empty", workspaceId, sessionId };
  }

  let currentVersion;
  try {
    currentVersion = parseSyncedTranscriptVersion(currentResponse.data);
  } catch (error) {
    throw invalid(error);
  }
  if (
    currentVersion.workspace_id !== workspaceId ||
    currentVersion.session_id !== sessionId ||
    currentVersion.version_status !== "final" ||
    (currentVersion.version_origin === "user_edit" &&
      currentVersion.parent_version_id === null) ||
    (currentVersion.version_origin !== "user_edit" &&
      currentVersion.parent_version_id !== null)
  ) {
    throw invalid();
  }

  const currentSegmentSnapshot = await readSegments(client, currentVersion);
  const {
    segments: currentSegments,
    expectedSegmentCount: currentExpectedSegmentCount,
  } = currentSegmentSnapshot;
  if (
    (currentVersion.version_origin === "user_edit" &&
      currentExpectedSegmentCount !== 0) ||
    (currentVersion.version_origin === "provider" &&
      currentExpectedSegmentCount < 1)
  ) {
    throw invalid(
      new Error(
        currentVersion.version_origin === "provider"
          ? "TRANSCRIPT_PROVIDER_CURRENT_EMPTY"
          : "TRANSCRIPT_USER_EDIT_SEGMENTS_FORBIDDEN",
      ),
    );
  }

  const intermediateVersions: SyncedTranscriptVersionRecord[] = [];
  let evidenceVersion: SyncedTranscriptVersionRecord | null = null;
  let evidenceSegments: SyncedTranscriptSegment[] = [];
  let evidenceExpectedSegmentCount: number | null = null;

  if (currentVersion.version_origin === "user_edit") {
    const visitedVersionIds = new Set<string>([currentVersion.id]);
    let childVersion: SyncedTranscriptVersionRecord = currentVersion;
    let parentVersionId = currentVersion.parent_version_id;

    for (let depth = 0; parentVersionId !== null; depth += 1) {
      if (depth >= MAX_TRANSCRIPT_LINEAGE_DEPTH) {
        throw invalid(new Error("TRANSCRIPT_CURRENT_LINEAGE_DEPTH_EXCEEDED"));
      }
      if (visitedVersionIds.has(parentVersionId)) {
        throw invalid(new Error("TRANSCRIPT_CURRENT_LINEAGE_CYCLE"));
      }
      visitedVersionIds.add(parentVersionId);

      const parentResponse = await client
        .from("transcript_versions")
        .select(VERSION_SELECT)
        .eq("id", parentVersionId)
        .eq("workspace_id", workspaceId)
        .eq("session_id", sessionId)
        .maybeSingle();
      if (parentResponse.error) {
        throw normalizeCurrentTranscriptVersionClientError(
          parentResponse.error,
        );
      }
      if (!parentResponse.data) {
        throw invalid(new Error("TRANSCRIPT_CURRENT_LINEAGE_PARENT_MISSING"));
      }

      let parentVersion: SyncedTranscriptVersionRecord;
      try {
        parentVersion = parseSyncedTranscriptVersionRecord(
          parentResponse.data,
        );
      } catch (error) {
        throw invalid(error);
      }
      if (
        parentVersion.id !== parentVersionId ||
        !isTranscriptLineageParent(childVersion, parentVersion)
      ) {
        throw invalid();
      }

      if (parentVersion.version_origin === "provider") {
        evidenceVersion = parentVersion;
        const evidenceSegmentSnapshot = await readSegments(
          client,
          parentVersion,
        );
        evidenceSegments = evidenceSegmentSnapshot.segments;
        evidenceExpectedSegmentCount =
          evidenceSegmentSnapshot.expectedSegmentCount;
        if (evidenceExpectedSegmentCount < 1) {
          throw invalid(new Error("TRANSCRIPT_PROVIDER_EVIDENCE_EMPTY"));
        }
        break;
      }

      intermediateVersions.push(parentVersion);
      childVersion = parentVersion;
      parentVersionId = parentVersion.parent_version_id;
    }
  }

  return {
    kind: "ready",
    currentVersion,
    currentSegments,
    currentExpectedSegmentCount,
    intermediateVersions,
    evidenceVersion,
    evidenceSegments,
    evidenceExpectedSegmentCount,
  };
};
