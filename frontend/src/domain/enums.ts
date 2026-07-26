// Explicit domain enums.

export const SpokenLanguageMode = {
  AUTO_DETECT: "AUTO_DETECT",
  SINGLE_LANGUAGE: "SINGLE_LANGUAGE",
  MULTILINGUAL: "MULTILINGUAL",
} as const;
export type SpokenLanguageMode = (typeof SpokenLanguageMode)[keyof typeof SpokenLanguageMode];

export const LanguageDetectionStatus = {
  NOT_STARTED: "NOT_STARTED",
  DETECTING: "DETECTING",
  DETECTED: "DETECTED",
  PARTIALLY_DETECTED: "PARTIALLY_DETECTED",
  USER_CONFIRMED: "USER_CONFIRMED",
  FAILED: "FAILED",
} as const;
export type LanguageDetectionStatus = (typeof LanguageDetectionStatus)[keyof typeof LanguageDetectionStatus];

export const TranscriptDisplayMode = {
  ORIGINAL: "ORIGINAL",
  TRANSLATED: "TRANSLATED",
  BILINGUAL: "BILINGUAL",
} as const;
export type TranscriptDisplayMode = (typeof TranscriptDisplayMode)[keyof typeof TranscriptDisplayMode];

export const SessionStatus = {
  DRAFT: "draft",
  PREPARING: "preparing",
  RECORDING: "recording",
  PAUSED: "paused",
  RECORDED: "recorded",
  QUEUED: "queued",
  SYNCHRONIZING: "synchronizing",
  SYNCHRONIZED: "synchronized",
  FAILED: "failed",
  DELETING: "deleting",
  DELETED: "deleted",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const ProjectStatus = {
  ACTIVE: "active",
  ARCHIVED: "archived",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const WorkspaceType = {
  PERSONAL: "personal",
  TEAM: "team",
} as const;
export type WorkspaceType = (typeof WorkspaceType)[keyof typeof WorkspaceType];

export const WorkspaceRole = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  VIEWER: "viewer",
} as const;
export type WorkspaceRole = (typeof WorkspaceRole)[keyof typeof WorkspaceRole];

export const MembershipStatus = {
  ACTIVE: "active",
  INVITED: "invited",
  SUSPENDED: "suspended",
  REMOVED: "removed",
} as const;
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];

export const AssetType = {
  IMAGE: "image",
  VIDEO: "video",
  DOCUMENT: "document",
  AUDIO_ATTACHMENT: "audio_attachment",
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];

export const UploadStatus = {
  LOCAL_ONLY: "local_only",
  PENDING: "pending",
  UPLOADING: "uploading",
  UPLOADED: "uploaded",
  SYNCHRONIZED: "synchronized",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type UploadStatus = (typeof UploadStatus)[keyof typeof UploadStatus];

export const TimelineEventType = {
  RECORDING_STARTED: "recording_started",
  RECORDING_PAUSED: "recording_paused",
  RECORDING_RESUMED: "recording_resumed",
  RECORDING_STOPPED: "recording_stopped",
  BOOKMARK_ADDED: "bookmark_added",
  NOTE_ADDED: "note_added",
  IMAGE_ADDED: "image_added",
  VIDEO_ADDED: "video_added",
  DOCUMENT_ADDED: "document_added",
  EVIDENCE_REMOVED: "evidence_removed",
} as const;
export type TimelineEventType = (typeof TimelineEventType)[keyof typeof TimelineEventType];

export const AttachmentEventType = {
  IMAGE_ADDED: "image_added",
  VIDEO_ADDED: "video_added",
  DOCUMENT_ADDED: "document_added",
  AUDIO_ATTACHMENT_ADDED: "audio_attachment_added",
  ASSET_REMOVED: "asset_removed",
} as const;
export type AttachmentEventType = (typeof AttachmentEventType)[keyof typeof AttachmentEventType];
