import { z } from "zod";

import {
  AssetType,
  LanguageDetectionStatus,
  MembershipStatus,
  ProcessingJobStatus,
  ProviderCleanupStatus,
  ProjectStatus,
  SessionStatus,
  SpokenLanguageMode,
  TimelineEventType,
  TranscriptionRequestStatus,
  TranscriptionRunStatus,
  TranscriptDisplayMode,
  TranscriptVersionOrigin,
  TranscriptVersionStatus,
  UploadStatus,
  WorkspaceRole,
  WorkspaceType,
} from "./enums";

// UUID (v4-like) sanity check, permissive.
export const uuidSchema = z.string().regex(/^[0-9a-fA-F-]{32,36}$/);

export const isoTimestampSchema = z.string();

// Profile
export const profileSchema = z.object({
  id: uuidSchema,
  display_name: z.string().nullable(),
  app_language: z.string().default("en"),
  default_spoken_language_mode: z
    .enum([SpokenLanguageMode.AUTO_DETECT, SpokenLanguageMode.SINGLE_LANGUAGE, SpokenLanguageMode.MULTILINGUAL])
    .default(SpokenLanguageMode.AUTO_DETECT),
  default_expected_spoken_languages: z.array(z.string()).default([]),
  default_summary_output_language: z.string().default("en"),
  default_translation_target_language: z.string().nullable().default(null),
  preserve_original_language: z.boolean().default(true),
  prefer_bilingual_view: z.boolean().default(false),
  onboarding_completed: z.boolean().default(false),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type Profile = z.infer<typeof profileSchema>;

export const workspaceSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  workspace_type: z.enum([WorkspaceType.PERSONAL, WorkspaceType.TEAM]),
  owner_user_id: uuidSchema,
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceMemberSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  user_id: uuidSchema,
  role: z.enum([WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER]),
  membership_status: z.enum([
    MembershipStatus.ACTIVE,
    MembershipStatus.INVITED,
    MembershipStatus.SUSPENDED,
    MembershipStatus.REMOVED,
  ]),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const projectSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum([ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED]),
  default_spoken_language_mode: z
    .enum([SpokenLanguageMode.AUTO_DETECT, SpokenLanguageMode.SINGLE_LANGUAGE, SpokenLanguageMode.MULTILINGUAL])
    .nullable(),
  default_expected_spoken_languages: z.array(z.string()).nullable(),
  default_summary_output_language: z.string().nullable(),
  default_translation_target_language: z.string().nullable(),
  created_by: uuidSchema,
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  deleted_at: isoTimestampSchema.nullable(),
});
export type Project = z.infer<typeof projectSchema>;

export const sessionSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  project_id: uuidSchema.nullable(),
  created_by: uuidSchema,
  title: z.string(),
  session_type: z.string().default("standard"),
  status: z.enum(Object.values(SessionStatus) as [SessionStatus, ...SessionStatus[]]),
  started_at: isoTimestampSchema.nullable(),
  stopped_at: isoTimestampSchema.nullable(),
  total_recorded_duration_ms: z.number().int().nonnegative().default(0),
  spoken_language_mode: z.enum([
    SpokenLanguageMode.AUTO_DETECT,
    SpokenLanguageMode.SINGLE_LANGUAGE,
    SpokenLanguageMode.MULTILINGUAL,
  ]),
  expected_spoken_languages: z.array(z.string()).default([]),
  detected_spoken_languages: z.array(z.string()).default([]),
  primary_detected_language: z.string().nullable(),
  language_detection_status: z.enum(
    Object.values(LanguageDetectionStatus) as [LanguageDetectionStatus, ...LanguageDetectionStatus[]],
  ),
  summary_output_language: z.string().nullable(),
  translation_target_language: z.string().nullable(),
  transcript_display_mode: z.enum([
    TranscriptDisplayMode.ORIGINAL,
    TranscriptDisplayMode.TRANSLATED,
    TranscriptDisplayMode.BILINGUAL,
  ]),
  language_metadata: z.unknown().nullable(),
  local_sync_status: z.string(),
  cloud_sync_status: z.string(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  deleted_at: isoTimestampSchema.nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const recordingSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  project_id: uuidSchema.nullable(),
  session_id: uuidSchema,
  local_file_uri: z.string().nullable(),
  private_storage_path: z.string().nullable(),
  mime_type: z.string(),
  original_file_name: z.string(),
  file_size: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  recording_format: z.string(),
  checksum_sha256: z.string().nullable(),
  upload_status: z.enum(Object.values(UploadStatus) as [UploadStatus, ...UploadStatus[]]),
  upload_error_code: z.string().nullable(),
  upload_error_message: z.string().nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type Recording = z.infer<typeof recordingSchema>;

export const mediaAssetSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  project_id: uuidSchema.nullable(),
  session_id: uuidSchema,
  added_by: uuidSchema,
  asset_type: z.enum([AssetType.IMAGE, AssetType.VIDEO, AssetType.DOCUMENT, AssetType.AUDIO_ATTACHMENT]),
  mime_type: z.string(),
  original_file_name: z.string(),
  sanitized_file_name: z.string(),
  local_file_uri: z.string().nullable(),
  private_storage_path: z.string().nullable(),
  file_size: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative().nullable(),
  image_width: z.number().int().nonnegative().nullable(),
  image_height: z.number().int().nonnegative().nullable(),
  page_count: z.number().int().nonnegative().nullable(),
  captured_at: isoTimestampSchema.nullable(),
  recording_offset_ms: z.number().int().nonnegative(),
  user_caption: z.string().nullable(),
  checksum_sha256: z.string().nullable(),
  upload_status: z.enum(Object.values(UploadStatus) as [UploadStatus, ...UploadStatus[]]),
  upload_error_code: z.string().nullable(),
  upload_error_message: z.string().nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  deleted_at: isoTimestampSchema.nullable(),
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;

export const userNoteSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  project_id: uuidSchema.nullable(),
  session_id: uuidSchema,
  text: z.string(),
  recording_offset_ms: z.number().int().nonnegative(),
  created_by: uuidSchema,
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  deleted_at: isoTimestampSchema.nullable(),
});
export type UserNote = z.infer<typeof userNoteSchema>;

export const bookmarkSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  project_id: uuidSchema.nullable(),
  session_id: uuidSchema,
  label: z.string(),
  recording_offset_ms: z.number().int().nonnegative(),
  created_by: uuidSchema,
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  deleted_at: isoTimestampSchema.nullable(),
});
export type Bookmark = z.infer<typeof bookmarkSchema>;

export const timelineEventSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  project_id: uuidSchema.nullable(),
  session_id: uuidSchema,
  event_type: z.enum(Object.values(TimelineEventType) as [TimelineEventType, ...TimelineEventType[]]),
  source_entity_type: z.string().nullable(),
  source_entity_id: uuidSchema.nullable(),
  recording_offset_ms: z.number().int().nonnegative(),
  created_by: uuidSchema,
  created_at: isoTimestampSchema,
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const uploadQueueSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  workspace_id: uuidSchema,
  session_id: uuidSchema,
  source_entity_type: z.string(),
  source_entity_id: uuidSchema,
  local_file_uri: z.string(),
  target_storage_path: z.string(),
  queue_status: z.enum(Object.values(UploadStatus) as [UploadStatus, ...UploadStatus[]]),
  attempt_count: z.number().int().nonnegative(),
  next_retry_at: isoTimestampSchema.nullable(),
  last_error_code: z.string().nullable(),
  last_safe_error: z.string().nullable(),
  idempotency_key: z.string(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type UploadQueueRecord = z.infer<typeof uploadQueueSchema>;

export const processingJobSchema = z
  .object({
    id: uuidSchema,
    workspace_id: uuidSchema,
    session_id: uuidSchema,
    recording_id: uuidSchema,
    created_by: uuidSchema.nullable(),
    job_type: z.literal("batch_transcription"),
    status: z.enum(
      Object.values(ProcessingJobStatus) as [
        ProcessingJobStatus,
        ...ProcessingJobStatus[],
      ],
    ),
    idempotency_key: z.string().trim().min(1),
    priority: z.number().int().nonnegative(),
    attempt_count: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    next_attempt_at: isoTimestampSchema.nullable(),
    lease_owner: z.string().trim().min(1).nullable(),
    lease_expires_at: isoTimestampSchema.nullable(),
    started_at: isoTimestampSchema.nullable(),
    completed_at: isoTimestampSchema.nullable(),
    cancelled_at: isoTimestampSchema.nullable(),
    last_error_code: z.string().nullable(),
    last_safe_error: z.string().nullable(),
    request_payload: z.unknown(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .superRefine((job, context) => {
    if (job.attempt_count > job.max_attempts) {
      context.addIssue({
        code: "custom",
        message: "attempt_count must not exceed max_attempts.",
        path: ["attempt_count"],
      });
    }

    const leaseIsComplete =
      job.lease_owner !== null && job.lease_expires_at !== null;
    const leaseIsEmpty =
      job.lease_owner === null && job.lease_expires_at === null;
    if (
      (job.status === ProcessingJobStatus.LEASED && !leaseIsComplete) ||
      (job.status !== ProcessingJobStatus.LEASED && !leaseIsEmpty)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only leased processing jobs may retain a complete lease.",
        path: ["lease_owner"],
      });
    }
  });
export type ProcessingJob = z.infer<typeof processingJobSchema>;

export const transcriptionRunSchema = z
  .object({
    id: uuidSchema,
    processing_job_id: uuidSchema,
    workspace_id: uuidSchema,
    session_id: uuidSchema,
    recording_id: uuidSchema,
    created_by: uuidSchema.nullable(),
    run_attempt: z.number().int().positive(),
    provider_key: z.string().trim().min(1),
    provider_model: z.string().trim().min(1),
    provider_region: z.enum(["EU", "US"]),
    request_mode: z.enum([
      SpokenLanguageMode.AUTO_DETECT,
      SpokenLanguageMode.SINGLE_LANGUAGE,
      SpokenLanguageMode.MULTILINGUAL,
    ]),
    requested_languages: z.array(z.string().trim().min(1)),
    status: z.enum(
      Object.values(TranscriptionRunStatus) as [
        TranscriptionRunStatus,
        ...TranscriptionRunStatus[],
      ],
    ),
    provider_job_id: z.string().nullable(),
    detected_languages: z.array(z.string().trim().min(1)),
    primary_detected_language: z.string().nullable(),
    language_detection_status: z.enum(
      Object.values(LanguageDetectionStatus) as [
        LanguageDetectionStatus,
        ...LanguageDetectionStatus[],
      ],
    ),
    provider_metadata: z.unknown(),
    submission_started_at: isoTimestampSchema.nullable(),
    provider_processing_deadline_at: isoTimestampSchema.nullable(),
    provider_cleanup_status: z.enum(
      Object.values(ProviderCleanupStatus) as [
        ProviderCleanupStatus,
        ...ProviderCleanupStatus[],
      ],
    ),
    provider_cleanup_attempt_count: z.number().int().nonnegative(),
    provider_cleanup_max_attempts: z.number().int().positive(),
    provider_cleanup_next_attempt_at: isoTimestampSchema.nullable(),
    provider_cleanup_lease_owner: z.string().trim().min(1).nullable(),
    provider_cleanup_lease_expires_at: isoTimestampSchema.nullable(),
    provider_cleanup_completed_at: isoTimestampSchema.nullable(),
    provider_cleanup_last_error_code: z.string().nullable(),
    provider_cleanup_last_safe_error: z.string().nullable(),
    started_at: isoTimestampSchema.nullable(),
    completed_at: isoTimestampSchema.nullable(),
    last_error_code: z.string().nullable(),
    last_safe_error: z.string().nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .superRefine((run, context) => {
    const languageCount = run.requested_languages.length;
    const validLanguageSelection =
      (run.request_mode === SpokenLanguageMode.AUTO_DETECT &&
        languageCount <= 2) ||
      (run.request_mode === SpokenLanguageMode.SINGLE_LANGUAGE &&
        languageCount === 1) ||
      (run.request_mode === SpokenLanguageMode.MULTILINGUAL &&
        languageCount === 2);

    if (!validLanguageSelection) {
      context.addIssue({
        code: "custom",
        message: "requested_languages does not match request_mode.",
        path: ["requested_languages"],
      });
    }

    if (
      run.provider_cleanup_attempt_count > run.provider_cleanup_max_attempts
    ) {
      context.addIssue({
        code: "custom",
        message: "provider cleanup attempts must remain bounded.",
        path: ["provider_cleanup_attempt_count"],
      });
    }

    const cleanupLeaseIsComplete =
      run.provider_cleanup_lease_owner !== null &&
      run.provider_cleanup_lease_expires_at !== null;
    const cleanupLeaseIsEmpty =
      run.provider_cleanup_lease_owner === null &&
      run.provider_cleanup_lease_expires_at === null;
    const cleanupHasProviderJob = run.provider_job_id !== null;

    const cleanupStateIsValid =
      (run.provider_cleanup_status === ProviderCleanupStatus.NOT_REQUIRED &&
        run.provider_cleanup_next_attempt_at === null &&
        cleanupLeaseIsEmpty &&
        run.provider_cleanup_completed_at === null) ||
      (run.provider_cleanup_status === ProviderCleanupStatus.PENDING &&
        cleanupHasProviderJob &&
        run.provider_cleanup_next_attempt_at !== null &&
        cleanupLeaseIsEmpty &&
        run.provider_cleanup_completed_at === null) ||
      (run.provider_cleanup_status === ProviderCleanupStatus.LEASED &&
        cleanupHasProviderJob &&
        run.provider_cleanup_next_attempt_at === null &&
        cleanupLeaseIsComplete &&
        run.provider_cleanup_completed_at === null) ||
      (run.provider_cleanup_status === ProviderCleanupStatus.SUCCEEDED &&
        run.provider_cleanup_next_attempt_at === null &&
        cleanupLeaseIsEmpty &&
        run.provider_cleanup_completed_at !== null) ||
      (run.provider_cleanup_status === ProviderCleanupStatus.MANUAL_REVIEW &&
        run.provider_cleanup_next_attempt_at === null &&
        cleanupLeaseIsEmpty &&
        run.provider_cleanup_completed_at === null);

    if (!cleanupStateIsValid) {
      context.addIssue({
        code: "custom",
        message: "Provider cleanup fields do not match the durable cleanup status.",
        path: ["provider_cleanup_status"],
      });
    }

    if (
      run.provider_job_id !== null &&
      (run.status === TranscriptionRunStatus.SUCCEEDED ||
        run.status === TranscriptionRunStatus.FAILED ||
        run.status === TranscriptionRunStatus.CANCELLED) &&
      run.provider_cleanup_status === ProviderCleanupStatus.NOT_REQUIRED
    ) {
      context.addIssue({
        code: "custom",
        message: "Terminal provider runs with an artifact require durable cleanup state.",
        path: ["provider_cleanup_status"],
      });
    }

    const hasProviderJob = run.provider_job_id !== null;
    const executionStateIsValid =
      (run.status === TranscriptionRunStatus.QUEUED &&
        !hasProviderJob &&
        run.submission_started_at === null &&
        run.provider_processing_deadline_at === null &&
        run.completed_at === null) ||
      (run.status === TranscriptionRunStatus.SUBMITTING &&
        !hasProviderJob &&
        run.submission_started_at !== null &&
        run.provider_processing_deadline_at === null &&
        run.completed_at === null) ||
      (run.status === TranscriptionRunStatus.PROCESSING &&
        hasProviderJob &&
        run.submission_started_at !== null &&
        run.provider_processing_deadline_at !== null &&
        run.completed_at === null) ||
      (run.status === TranscriptionRunStatus.SUCCEEDED &&
        hasProviderJob &&
        run.submission_started_at !== null &&
        run.provider_processing_deadline_at !== null &&
        run.completed_at !== null) ||
      ((run.status === TranscriptionRunStatus.FAILED ||
        run.status === TranscriptionRunStatus.CANCELLED) &&
        run.completed_at !== null);

    if (!executionStateIsValid) {
      context.addIssue({
        code: "custom",
        message: "Transcription run fields do not match the durable status.",
        path: ["status"],
      });
    }
  });
export type TranscriptionRun = z.infer<typeof transcriptionRunSchema>;

export const transcriptVersionSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  session_id: uuidSchema,
  transcription_run_id: uuidSchema.nullable(),
  created_by: uuidSchema.nullable(),
  version: z.number().int().positive(),
  version_origin: z.enum(
    Object.values(TranscriptVersionOrigin) as [
      TranscriptVersionOrigin,
      ...TranscriptVersionOrigin[],
    ],
  ),
  version_status: z.enum(
    Object.values(TranscriptVersionStatus) as [
      TranscriptVersionStatus,
      ...TranscriptVersionStatus[],
    ],
  ),
  parent_version_id: uuidSchema.nullable(),
  plain_text: z.string(),
  language_summary: z.unknown(),
  content_checksum_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .nullable(),
  is_current: z.boolean(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type TranscriptVersion = z.infer<typeof transcriptVersionSchema>;

export const transcriptSegmentSchema = z
  .object({
    id: uuidSchema,
    workspace_id: uuidSchema,
    session_id: uuidSchema,
    transcript_version_id: uuidSchema,
    segment_index: z.number().int().nonnegative(),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().nonnegative(),
    text: z.string().trim().min(1),
    language_code: z.string().trim().min(1).nullable(),
    speaker_label: z.string().trim().min(1).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    provider_segment_id: z.string().nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .refine((segment) => segment.end_ms >= segment.start_ms, {
    message: "Transcript segment end_ms must be greater than or equal to start_ms.",
    path: ["end_ms"],
  });
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptionRequestQueueSchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema,
    workspace_id: uuidSchema,
    session_id: uuidSchema,
    recording_id: uuidSchema,
    spoken_language_mode: z.enum([
      SpokenLanguageMode.AUTO_DETECT,
      SpokenLanguageMode.SINGLE_LANGUAGE,
      SpokenLanguageMode.MULTILINGUAL,
    ]),
    expected_spoken_languages: z.array(z.string().trim().min(1)),
    queue_status: z.enum(
      Object.values(TranscriptionRequestStatus) as [
        TranscriptionRequestStatus,
        ...TranscriptionRequestStatus[],
      ],
    ),
    attempt_count: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    next_retry_at: isoTimestampSchema.nullable(),
    server_job_id: uuidSchema.nullable(),
    last_error_code: z.string().nullable(),
    last_safe_error: z.string().nullable(),
    idempotency_key: z.string().trim().min(1),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .refine((request) => request.attempt_count <= request.max_attempts, {
    message: "attempt_count must not exceed max_attempts.",
    path: ["attempt_count"],
  });
export type TranscriptionRequestQueueRecord = z.infer<
  typeof transcriptionRequestQueueSchema
>;
