export type ProcessingJobStatus =
  | "queued"
  | "leased"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TranscriptionRunStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SyncedProcessingJob {
  id: string;
  workspace_id: string;
  session_id: string;
  recording_id: string;
  created_by: string | null;
  job_type: "batch_transcription";
  status: ProcessingJobStatus;
  idempotency_key: string;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  last_error_code: string | null;
  last_safe_error: string | null;
  request_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Provider identifiers and provider metadata intentionally do not cross the
 * mobile boundary. The boolean/cleanup state is enough to decide whether a
 * durable result is safe to cache locally.
 */
export interface SyncedTranscriptionRun {
  id: string;
  processing_job_id: string;
  workspace_id: string;
  session_id: string;
  recording_id: string;
  created_by: string | null;
  run_attempt: number;
  provider_key: string;
  provider_model: string;
  request_mode: "AUTO_DETECT" | "SINGLE_LANGUAGE" | "MULTILINGUAL";
  requested_languages: string[];
  status: TranscriptionRunStatus;
  provider_artifact_present: boolean;
  provider_cleanup_status: string | null;
  detected_languages: string[];
  primary_detected_language: string | null;
  language_detection_status: string;
  started_at: string | null;
  completed_at: string | null;
  last_error_code: string | null;
  last_safe_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncedTranscriptVersionRecord {
  id: string;
  workspace_id: string;
  session_id: string;
  transcription_run_id: string | null;
  created_by: string | null;
  version: number;
  version_origin: "provider" | "user_edit" | "import";
  version_status: "draft" | "final";
  parent_version_id: string | null;
  plain_text: string;
  language_summary: Record<string, unknown>;
  content_checksum_sha256: string | null;
  is_current: boolean;
  created_at: string;
  updated_at: string;
}

export interface SyncedTranscriptVersion
  extends SyncedTranscriptVersionRecord {
  is_current: true;
}

export interface SyncedTranscriptSegment {
  id: string;
  workspace_id: string;
  session_id: string;
  transcript_version_id: string;
  segment_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  language_code: string | null;
  speaker_label: string | null;
  confidence: number | null;
  provider_segment_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Maximum number of parent links, including the provider evidence leaf. */
export const MAX_TRANSCRIPT_LINEAGE_DEPTH = 64;

const isLineageUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Validate one exact immutable parent link, never nullable run provenance. */
export const isTranscriptLineageParent = (
  child: SyncedTranscriptVersionRecord,
  parent: SyncedTranscriptVersionRecord,
): boolean =>
  isLineageUuid(child.id) &&
  isLineageUuid(child.workspace_id) &&
  isLineageUuid(child.session_id) &&
  isLineageUuid(child.parent_version_id) &&
  isLineageUuid(parent.id) &&
  parent.id === child.parent_version_id &&
  parent.id !== child.id &&
  parent.parent_version_id !== parent.id &&
  (parent.parent_version_id === null || isLineageUuid(parent.parent_version_id)) &&
  parent.workspace_id === child.workspace_id &&
  parent.session_id === child.session_id &&
  parent.is_current === false &&
  parent.version_status === "final" &&
  child.version_status === "final" &&
  ["provider", "user_edit", "import"].includes(parent.version_origin) &&
  Number.isSafeInteger(parent.version) &&
  Number.isSafeInteger(child.version) &&
  parent.version > 0 &&
  parent.version < child.version;

export type CurrentTranscriptVersionSnapshot =
  | {
      kind: "empty";
      workspaceId: string;
      sessionId: string;
    }
  | {
      kind: "ready";
      currentVersion: SyncedTranscriptVersion;
      currentSegments: SyncedTranscriptSegment[];
      /**
       * Non-provider parents in immediate-parent-first order. Excludes current
       * and evidenceVersion; together they form the complete validated path.
       * Includes a terminal import parent when no provider evidence exists.
       */
      intermediateVersions: SyncedTranscriptVersionRecord[];
      evidenceVersion: SyncedTranscriptVersionRecord | null;
      evidenceSegments: SyncedTranscriptSegment[];
    };

export type TranscriptionResultSnapshot =
  | {
      kind: "pending";
      reason: "job" | "result" | "cleanup";
      job: SyncedProcessingJob;
      run: SyncedTranscriptionRun | null;
    }
  | {
      kind: "terminal";
      status: "failed" | "cancelled";
      job: SyncedProcessingJob;
      run: SyncedTranscriptionRun | null;
    }
  | {
      kind: "cleanup_required";
      job: SyncedProcessingJob;
      run: SyncedTranscriptionRun;
    }
  | {
      kind: "succeeded";
      job: SyncedProcessingJob;
      run: SyncedTranscriptionRun;
      version: SyncedTranscriptVersionRecord;
      segments: SyncedTranscriptSegment[];
      expectedSegmentCount: number;
    };
