import {
  ProcessingJobStatus,
  SessionStatus,
  SpokenLanguageMode,
  TranscriptionRequestStatus,
  UploadStatus,
} from "@/src/domain/enums";
import {
  processingJobSchema,
  transcriptSegmentSchema,
  transcriptionRequestQueueSchema,
  type Recording,
  type Session,
} from "@/src/domain/models";
import {
  buildTranscriptionIdempotencyKey,
  normalizeTranscriptionLanguageCodes,
  prepareTranscriptionRequest,
  TranscriptionRequestErrorCode,
} from "@/src/services/transcription/contracts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const RECORDING_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-09T10:00:00.000Z";

const session: Session = {
  id: SESSION_ID,
  workspace_id: WORKSPACE_ID,
  project_id: null,
  created_by: USER_ID,
  title: "Transcription contract",
  session_type: "standard",
  status: SessionStatus.RECORDED,
  started_at: NOW,
  stopped_at: NOW,
  total_recorded_duration_ms: 120_000,
  spoken_language_mode: SpokenLanguageMode.MULTILINGUAL,
  expected_spoken_languages: ["ID", "EN_us"],
  detected_spoken_languages: [],
  primary_detected_language: null,
  language_detection_status: "NOT_STARTED",
  summary_output_language: null,
  translation_target_language: null,
  transcript_display_mode: "ORIGINAL",
  language_metadata: null,
  local_sync_status: "synchronized",
  cloud_sync_status: "synchronized",
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
};

const recording: Recording = {
  id: RECORDING_ID,
  workspace_id: WORKSPACE_ID,
  project_id: null,
  session_id: SESSION_ID,
  local_file_uri: "file:///documents/recording.m4a",
  private_storage_path:
    `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/recording.m4a`,
  mime_type: "audio/mp4",
  original_file_name: "recording.m4a",
  file_size: 1024,
  duration_ms: 120_000,
  recording_format: "m4a",
  checksum_sha256: null,
  upload_status: UploadStatus.SYNCHRONIZED,
  upload_error_code: null,
  upload_error_message: null,
  created_at: NOW,
  updated_at: NOW,
};

describe("batch transcription request contract", () => {
  it("normalizes, de-duplicates, and sorts language codes", () => {
    expect(
      normalizeTranscriptionLanguageCodes([
        " id-ID ",
        "EN_us",
        "en-US",
        "",
      ]),
    ).toEqual(["en-us", "id-id"]);
  });

  it("prepares a provider-neutral request only after private sync", () => {
    const result = prepareTranscriptionRequest({ session, recording });

    expect(result).toEqual({
      ok: true,
      value: {
        contractVersion: 1,
        jobType: "batch_transcription",
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        recordingId: RECORDING_ID,
        privateStoragePath: recording.private_storage_path,
        spokenLanguageMode: SpokenLanguageMode.MULTILINGUAL,
        expectedSpokenLanguages: ["en", "id"],
        idempotencyKey:
          `batch-transcription:v1:${WORKSPACE_ID}:${SESSION_ID}:` +
          `${RECORDING_ID}:MULTILINGUAL:en,id`,
      },
    });

    if (result.ok) {
      expect(JSON.stringify(result.value)).not.toContain("file://");
      expect(JSON.stringify(result.value)).not.toMatch(
        /provider|secret|service_role/i,
      );
    }
  });

  it("rejects a recording before cloud synchronization completes", () => {
    const result = prepareTranscriptionRequest({
      session,
      recording: { ...recording, upload_status: UploadStatus.UPLOADED },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: TranscriptionRequestErrorCode.RECORDING_NOT_SYNCHRONIZED,
      }),
    );
  });

  it("rejects workspace/session and Storage path scope mismatches", () => {
    expect(
      prepareTranscriptionRequest({
        session,
        recording: { ...recording, workspace_id: USER_ID },
      }),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: TranscriptionRequestErrorCode.SCOPE_MISMATCH,
      }),
    );

    expect(
      prepareTranscriptionRequest({
        session,
        recording: {
          ...recording,
          private_storage_path:
            `${USER_ID}/${SESSION_ID}/${RECORDING_ID}/recording.m4a`,
        },
      }),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: TranscriptionRequestErrorCode.STORAGE_SCOPE_MISMATCH,
      }),
    );
  });

  it.each([
    `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/`,
    `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/../other-file.m4a`,
    `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}//recording.m4a`,
    `${WORKSPACE_ID}/${SESSION_ID}/${RECORDING_ID}/recording.m4a `,
  ])(
    "rejects non-canonical private Storage object key %s",
    (privateStoragePath) => {
      expect(
        prepareTranscriptionRequest({
          session,
          recording: {
            ...recording,
            private_storage_path: privateStoragePath,
          },
        }),
      ).toEqual(
        expect.objectContaining({
          ok: false,
          code: TranscriptionRequestErrorCode.STORAGE_SCOPE_MISMATCH,
        }),
      );
    },
  );

  it("enforces reviewed language-mode cardinality after canonicalization", () => {
    expect(
      prepareTranscriptionRequest({
        session: {
          ...session,
          spoken_language_mode: SpokenLanguageMode.SINGLE_LANGUAGE,
          expected_spoken_languages: ["EN_us"],
        },
        recording,
      }),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          expectedSpokenLanguages: ["en"],
        }),
      }),
    );

    expect(
      prepareTranscriptionRequest({
        session: {
          ...session,
          spoken_language_mode: SpokenLanguageMode.SINGLE_LANGUAGE,
          expected_spoken_languages: ["en", "EN"],
        },
        recording,
      }),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: TranscriptionRequestErrorCode.LANGUAGE_SELECTION_INVALID,
      }),
    );

    expect(
      prepareTranscriptionRequest({
        session: {
          ...session,
          spoken_language_mode: SpokenLanguageMode.MULTILINGUAL,
          expected_spoken_languages: ["ID", "en-GB"],
        },
        recording,
      }),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          expectedSpokenLanguages: ["en", "id"],
        }),
      }),
    );
  });

  it("rejects invalid language tags", () => {
    const result = prepareTranscriptionRequest({
      session: {
        ...session,
        expected_spoken_languages: ["en", "not a language"],
      },
      recording,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: TranscriptionRequestErrorCode.LANGUAGE_CODE_INVALID,
      }),
    );
  });

  it.each(["ja", "id-ID"])(
    "rejects well-formed but unsupported manual language %s",
    (language) => {
      const result = prepareTranscriptionRequest({
        session: {
          ...session,
          spoken_language_mode: SpokenLanguageMode.SINGLE_LANGUAGE,
          expected_spoken_languages: [language],
        },
        recording,
      });

      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          code: TranscriptionRequestErrorCode.LANGUAGE_UNSUPPORTED,
        }),
      );
    },
  );

  it("changes the idempotency key only when stable request inputs change", () => {
    const first = buildTranscriptionIdempotencyKey({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      recordingId: RECORDING_ID,
      spokenLanguageMode: SpokenLanguageMode.MULTILINGUAL,
      expectedSpokenLanguages: ["id", "en-US"],
    });
    const reordered = buildTranscriptionIdempotencyKey({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      recordingId: RECORDING_ID,
      spokenLanguageMode: SpokenLanguageMode.MULTILINGUAL,
      expectedSpokenLanguages: ["EN_us", "ID"],
    });
    const changed = buildTranscriptionIdempotencyKey({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      recordingId: RECORDING_ID,
      spokenLanguageMode: SpokenLanguageMode.SINGLE_LANGUAGE,
      expectedSpokenLanguages: ["en"],
    });

    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(() =>
      buildTranscriptionIdempotencyKey({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        recordingId: RECORDING_ID,
        spokenLanguageMode: SpokenLanguageMode.SINGLE_LANGUAGE,
        expectedSpokenLanguages: ["ja"],
      }),
    ).toThrow("currently supports English");
  });
});

describe("transcription domain validation", () => {
  it("allows leases only while processing jobs are leased", () => {
    const baseJob = {
      id: "55555555-5555-4555-8555-555555555555",
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      recording_id: RECORDING_ID,
      created_by: USER_ID,
      job_type: "batch_transcription" as const,
      status: ProcessingJobStatus.PROCESSING,
      idempotency_key: "batch-transcription:test",
      priority: 100,
      attempt_count: 1,
      max_attempts: 5,
      next_attempt_at: null,
      lease_owner: null,
      lease_expires_at: null,
      started_at: NOW,
      completed_at: null,
      cancelled_at: null,
      last_error_code: null,
      last_safe_error: null,
      request_payload: {},
      created_at: NOW,
      updated_at: NOW,
    };

    expect(processingJobSchema.safeParse(baseJob).success).toBe(true);
    expect(
      processingJobSchema.safeParse({
        ...baseJob,
        lease_owner: "worker-1",
        lease_expires_at: NOW,
      }).success,
    ).toBe(false);
    expect(
      processingJobSchema.safeParse({
        ...baseJob,
        status: ProcessingJobStatus.LEASED,
      }).success,
    ).toBe(false);
    expect(
      processingJobSchema.safeParse({
        ...baseJob,
        status: ProcessingJobStatus.LEASED,
        lease_owner: "worker-1",
        lease_expires_at: NOW,
      }).success,
    ).toBe(true);
  });

  it("rejects reversed transcript segment timestamps", () => {
    expect(
      transcriptSegmentSchema.safeParse({
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        transcript_version_id:
          "77777777-7777-4777-8777-777777777777",
        segment_index: 0,
        start_ms: 2_000,
        end_ms: 1_000,
        text: "Hello",
        language_code: "en",
        speaker_label: null,
        confidence: 0.9,
        provider_segment_id: null,
        created_at: NOW,
        updated_at: NOW,
      }).success,
    ).toBe(false);
  });

  it("requires stable UUID queue identifiers and bounded attempts", () => {
    const request = {
      id: "not-a-uuid",
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      recording_id: RECORDING_ID,
      spoken_language_mode: SpokenLanguageMode.AUTO_DETECT,
      expected_spoken_languages: [],
      queue_status: TranscriptionRequestStatus.PENDING,
      attempt_count: 6,
      max_attempts: 5,
      next_retry_at: null,
      server_job_id: null,
      last_error_code: null,
      last_safe_error: null,
      idempotency_key: "batch-transcription:test",
      created_at: NOW,
      updated_at: NOW,
    };

    expect(transcriptionRequestQueueSchema.safeParse(request).success).toBe(
      false,
    );
  });
});
