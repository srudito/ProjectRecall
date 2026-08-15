import {
  parseSyncedProcessingJob,
  parseSyncedTranscriptSegment,
  parseSyncedTranscriptVersion,
  parseSyncedTranscriptionRun,
  TranscriptionResultClientError,
} from "@/src/services/transcription/result-client";

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const now = "2026-08-15T00:00:00.000Z";

describe("transcription result client validation", () => {
  it("normalizes safe durable rows without carrying a provider job ID", () => {
    const job = parseSyncedProcessingJob({
      id: UUIDS[0], workspace_id: UUIDS[1], session_id: UUIDS[2], recording_id: UUIDS[3],
      created_by: UUIDS[0], job_type: "batch_transcription", status: "succeeded",
      idempotency_key: "key", priority: 100, attempt_count: 1, max_attempts: 5,
      next_attempt_at: null, lease_owner: null, lease_expires_at: null,
      started_at: now, completed_at: now, cancelled_at: null,
      last_error_code: null, last_safe_error: null, request_payload: {},
      created_at: now, updated_at: now,
    });
    expect(job.status).toBe("succeeded");

    const run = parseSyncedTranscriptionRun({
      id: UUIDS[0], processing_job_id: UUIDS[1], workspace_id: UUIDS[2],
      session_id: UUIDS[3], recording_id: UUIDS[0], created_by: UUIDS[1],
      run_attempt: 1, provider_key: "assemblyai", provider_model: "universal-2",
      request_mode: "AUTO_DETECT", requested_languages: [], status: "succeeded",
      provider_job_id: "provider-secretless-id", provider_cleanup_status: "succeeded",
      detected_languages: ["en"], primary_detected_language: "en",
      language_detection_status: "DETECTED", started_at: now, completed_at: now,
      last_error_code: null, last_safe_error: null, created_at: now, updated_at: now,
    });
    expect(run.provider_artifact_present).toBe(true);
    expect(run).not.toHaveProperty("provider_job_id");
  });

  it("validates current version checksums and segment timing", () => {
    const version = parseSyncedTranscriptVersion({
      id: UUIDS[0], workspace_id: UUIDS[1], session_id: UUIDS[2],
      transcription_run_id: UUIDS[3], created_by: UUIDS[0], version: 1,
      version_origin: "provider", version_status: "final", parent_version_id: null,
      plain_text: "hello", language_summary: {}, content_checksum_sha256: "a".repeat(64),
      is_current: true, created_at: now, updated_at: now,
    });
    expect(version.is_current).toBe(true);

    const segment = parseSyncedTranscriptSegment({
      id: UUIDS[0], workspace_id: UUIDS[1], session_id: UUIDS[2],
      transcript_version_id: UUIDS[3], segment_index: 0, start_ms: 0, end_ms: 100,
      text: "hello", language_code: "en", speaker_label: null, confidence: 0.9,
      provider_segment_id: null, created_at: now, updated_at: now,
    });
    expect(segment.end_ms).toBe(100);
  });

  it("rejects malformed transcript rows", () => {
    expect(() => parseSyncedTranscriptSegment({})).toThrow(
      TranscriptionResultClientError,
    );
    expect(() => parseSyncedTranscriptVersion({
      id: UUIDS[0], workspace_id: UUIDS[1], session_id: UUIDS[2],
      transcription_run_id: UUIDS[3], created_by: null, version: 1,
      version_origin: "provider", version_status: "final", parent_version_id: null,
      plain_text: "", language_summary: {}, content_checksum_sha256: "not-a-checksum",
      is_current: true, created_at: now, updated_at: now,
    })).toThrow(TranscriptionResultClientError);
  });
});
