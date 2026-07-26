import { z } from "zod";

import {
  AssetType,
  LanguageDetectionStatus,
  MembershipStatus,
  ProjectStatus,
  SessionStatus,
  SpokenLanguageMode,
  TimelineEventType,
  TranscriptDisplayMode,
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
