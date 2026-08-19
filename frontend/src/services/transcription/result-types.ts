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
      version: SyncedTranscriptVersion;
      segments: SyncedTranscriptSegment[];
    };
