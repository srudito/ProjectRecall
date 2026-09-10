import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fetchRemoteTranscriptionResult,
  parseSyncedProcessingJob,
  parseSyncedTranscriptSegment,
  parseSyncedTranscriptVersion,
  parseSyncedTranscriptVersionRecord,
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

interface QueryResponse {
  data: unknown;
  error: unknown;
}

const makeQuery = (response: QueryResponse) => {
  const query: Record<string, jest.Mock> = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    order: jest.fn(() => query),
    limit: jest.fn(() => query),
    range: jest.fn(async () => response),
    maybeSingle: jest.fn(async () => response),
  };
  return query;
};

const authenticatedClient = (
  responses: Record<string, QueryResponse[]>,
  from: jest.Mock,
): SupabaseClient => {
  const queues = Object.fromEntries(
    Object.entries(responses).map(([table, values]) => [table, [...values]]),
  ) as Record<string, QueryResponse[]>;

  from.mockImplementation((table: string) => {
    const response = queues[table]?.shift();
    if (!response) throw new Error(`Unexpected query for ${table}`);
    return makeQuery(response);
  });

  return {
    auth: {
      getSession: jest.fn(async () => ({
        data: {
          session: {
            access_token: "test-access-token",
            user: { id: UUIDS[0] },
          },
        },
        error: null,
      })),
    },
    from,
  } as unknown as SupabaseClient;
};

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

  it("supports nullable transcript provenance without weakening current parsing", () => {
    const nullableCurrent = parseSyncedTranscriptVersion({
      id: UUIDS[0], workspace_id: UUIDS[1], session_id: UUIDS[2],
      transcription_run_id: null, created_by: null, version: 2,
      version_origin: "import", version_status: "final", parent_version_id: null,
      plain_text: "imported", language_summary: {}, content_checksum_sha256: null,
      is_current: true, created_at: now, updated_at: now,
    });
    expect(nullableCurrent.transcription_run_id).toBeNull();

    const evidence = parseSyncedTranscriptVersionRecord({
      id: UUIDS[3], workspace_id: UUIDS[1], session_id: UUIDS[2],
      transcription_run_id: UUIDS[0], created_by: null, version: 1,
      version_origin: "provider", version_status: "final", parent_version_id: null,
      plain_text: "source", language_summary: {}, content_checksum_sha256: null,
      is_current: false, created_at: now, updated_at: now,
    });
    expect(evidence.is_current).toBe(false);

    expect(() => parseSyncedTranscriptVersion({
      ...evidence,
      language_summary: {},
    })).toThrow(TranscriptionResultClientError);
  });

  it("filters result reads to final provider rows for the exact run", async () => {
    const from = jest.fn();
    const job = {
      id: UUIDS[0],
      workspace_id: UUIDS[1],
      session_id: UUIDS[2],
      recording_id: UUIDS[3],
      created_by: UUIDS[0],
      job_type: "batch_transcription",
      status: "succeeded",
      idempotency_key: "key",
      priority: 100,
      attempt_count: 1,
      max_attempts: 5,
      next_attempt_at: null,
      lease_owner: null,
      lease_expires_at: null,
      started_at: now,
      completed_at: now,
      cancelled_at: null,
      last_error_code: null,
      last_safe_error: null,
      request_payload: {},
      created_at: now,
      updated_at: now,
    };
    const run = {
      id: UUIDS[3],
      processing_job_id: job.id,
      workspace_id: job.workspace_id,
      session_id: job.session_id,
      recording_id: job.recording_id,
      created_by: UUIDS[0],
      run_attempt: 1,
      provider_key: "assemblyai",
      provider_model: "universal-2",
      request_mode: "AUTO_DETECT",
      requested_languages: [],
      status: "succeeded",
      provider_job_id: "provider-secretless-id",
      provider_cleanup_status: "succeeded",
      detected_languages: ["en"],
      primary_detected_language: "en",
      language_detection_status: "DETECTED",
      started_at: now,
      completed_at: now,
      last_error_code: null,
      last_safe_error: null,
      created_at: now,
      updated_at: now,
    };
    const client = authenticatedClient(
      {
        processing_jobs: [{ data: job, error: null }],
        transcription_runs: [{ data: run, error: null }],
        transcript_versions: [{ data: null, error: null }],
      },
      from,
    );

    await expect(
      fetchRemoteTranscriptionResult(
        { serverJobId: job.id, expectedUserId: UUIDS[0] },
        client,
      ),
    ).resolves.toMatchObject({ kind: "pending", reason: "result" });

    const runQuery = from.mock.results[1]?.value as { select: jest.Mock };
    expect(runQuery.select).toHaveBeenCalledWith(
      expect.stringContaining("word_count:provider_metadata->wordCount"),
    );
    const versionQuery = from.mock.results[2]?.value as {
      eq: jest.Mock;
      order: jest.Mock;
    };
    expect(versionQuery.eq).toHaveBeenCalledWith(
      "transcription_run_id",
      run.id,
    );
    expect(versionQuery.eq).toHaveBeenCalledWith(
      "version_origin",
      "provider",
    );
    expect(versionQuery.eq).toHaveBeenCalledWith(
      "version_status",
      "final",
    );
    expect(versionQuery.order).toHaveBeenCalledWith("version", {
      ascending: false,
    });
    expect(from).not.toHaveBeenCalledWith("transcript_segments");
  });

  it("retrieves a final provider result after it is no longer current", async () => {
    const from = jest.fn();
    const job = {
      id: UUIDS[0],
      workspace_id: UUIDS[1],
      session_id: UUIDS[2],
      recording_id: UUIDS[3],
      created_by: UUIDS[0],
      job_type: "batch_transcription",
      status: "succeeded",
      idempotency_key: "key",
      priority: 100,
      attempt_count: 1,
      max_attempts: 5,
      next_attempt_at: null,
      lease_owner: null,
      lease_expires_at: null,
      started_at: now,
      completed_at: now,
      cancelled_at: null,
      last_error_code: null,
      last_safe_error: null,
      request_payload: {},
      created_at: now,
      updated_at: now,
    };
    const run = {
      id: UUIDS[3],
      processing_job_id: job.id,
      workspace_id: job.workspace_id,
      session_id: job.session_id,
      recording_id: job.recording_id,
      created_by: UUIDS[0],
      run_attempt: 1,
      provider_key: "assemblyai",
      provider_model: "universal-2",
      request_mode: "AUTO_DETECT",
      requested_languages: [],
      status: "succeeded",
      provider_job_id: "provider-secretless-id",
      provider_cleanup_status: "succeeded",
      detected_languages: ["en"],
      primary_detected_language: "en",
      language_detection_status: "DETECTED",
      started_at: now,
      completed_at: now,
      last_error_code: null,
      last_safe_error: null,
      created_at: now,
      updated_at: now,
      word_count: 1,
    };
    const archivedProvider = {
      id: UUIDS[1],
      workspace_id: job.workspace_id,
      session_id: job.session_id,
      transcription_run_id: run.id,
      created_by: UUIDS[0],
      version: 1,
      version_origin: "provider",
      version_status: "final",
      parent_version_id: null,
      plain_text: "provider transcript",
      language_summary: {},
      content_checksum_sha256: "a".repeat(64),
      is_current: false,
      created_at: now,
      updated_at: now,
    };
    const providerSegment = {
      id: UUIDS[2],
      workspace_id: job.workspace_id,
      session_id: job.session_id,
      transcript_version_id: archivedProvider.id,
      segment_index: 0,
      start_ms: 0,
      end_ms: 100,
      text: "provider transcript",
      language_code: "en",
      speaker_label: null,
      confidence: 0.9,
      provider_segment_id: null,
      created_at: now,
      updated_at: now,
    };
    const client = authenticatedClient(
      {
        processing_jobs: [{ data: job, error: null }],
        transcription_runs: [{ data: run, error: null }],
        transcript_versions: [{ data: archivedProvider, error: null }],
        transcript_segments: [{ data: [providerSegment], error: null }],
      },
      from,
    );

    await expect(
      fetchRemoteTranscriptionResult(
        { serverJobId: job.id, expectedUserId: UUIDS[0] },
        client,
      ),
    ).resolves.toMatchObject({
      kind: "succeeded",
      version: { id: archivedProvider.id, is_current: false },
      segments: [{ id: providerSegment.id }],
      expectedSegmentCount: 1,
    });
    expect(from).toHaveBeenCalledWith("transcript_segments");

    const mismatchFrom = jest.fn();
    const mismatchClient = authenticatedClient(
      {
        processing_jobs: [{ data: job, error: null }],
        transcription_runs: [{ data: { ...run, word_count: 2 }, error: null }],
        transcript_versions: [{ data: archivedProvider, error: null }],
        transcript_segments: [{ data: [providerSegment], error: null }],
      },
      mismatchFrom,
    );
    await expect(
      fetchRemoteTranscriptionResult(
        { serverJobId: job.id, expectedUserId: UUIDS[0] },
        mismatchClient,
      ),
    ).rejects.toMatchObject({
      code: "TRANSCRIPTION_RESULT_INVALID",
      retryable: false,
    });
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
