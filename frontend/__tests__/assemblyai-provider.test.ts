import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ASSEMBLYAI_EU_BASE_URL,
  ASSEMBLYAI_PROVIDER_MODEL,
  ASSEMBLYAI_US_BASE_URL,
  AssemblyAITranscriptionProvider,
  buildAssemblyAISubmissionRequest,
  classifyAssemblyAIJobError,
  normalizeAssemblyAICompletedTranscript,
} from "../../supabase/functions/_shared/transcription/assemblyai";
import {
  TranscriptionProviderError,
  type FetchLike,
  type ProviderDiagnosticCode,
  type ProviderFailureCode,
} from "../../supabase/functions/_shared/transcription/provider";

const TEST_API_KEY = "assemblyai-test-key-not-a-real-credential";
const AUDIO_URL =
  "https://project.supabase.co/storage/v1/object/sign/session-assets/path?token=test";
const PROVIDER_JOB_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_JOB_ID_WITH_HEX =
  "abcdefab-cdef-4abc-8def-abcdefabcdef";

const response = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        headers[
          Object.keys(headers).find(
            (key) => key.toLowerCase() === name.toLowerCase(),
          ) ?? ""
        ] ?? null,
    },
    json: async () => body,
  }) as unknown as Response;

const providerWith = (fetchImplementation: FetchLike) =>
  new AssemblyAITranscriptionProvider({
    apiKey: TEST_API_KEY,
    region: "EU",
    fetchImplementation,
  });

const readSourceTree = (root: string): string => {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return [readSourceTree(path)];
      if (!entry.isFile() || !/\.(?:ts|tsx|js|json)$/.test(entry.name)) {
        return [];
      }
      return [readFileSync(path, "utf8")];
    })
    .join("\n");
};

const expectSyncProviderError = (
  callback: () => unknown,
  code: ProviderFailureCode,
): void => {
  let captured: unknown;
  try {
    callback();
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(TranscriptionProviderError);
  expect(captured).toMatchObject({ failure: { code } });
};

const expectSyncProviderDiagnostic = (
  callback: () => unknown,
  diagnosticCode: ProviderDiagnosticCode,
): void => {
  let captured: unknown;
  try {
    callback();
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(TranscriptionProviderError);
  expect(captured).toMatchObject({
    failure: {
      code: "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
      diagnosticCode,
      retryable: false,
      safeMessage: "The transcription provider returned an invalid result.",
    },
  });
};

const completedResponse = () => ({
  id: PROVIDER_JOB_ID,
  status: "completed",
  audio_url: AUDIO_URL,
  text: "Halo world.",
  words: [
    {
      text: "Halo",
      start: 100,
      end: 420,
      confidence: 0.97,
      speaker: "A",
    },
    {
      text: "world.",
      start: 450,
      end: 900,
      confidence: 0.92,
      speaker: "B",
    },
  ],
  utterances: [{ speaker: "A" }, { speaker: "B" }],
  language_code: "id",
  language_confidence: 0.91,
  language_detection: true,
  speech_model_used: "universal-2",
  audio_duration: 1.2,
  speaker_labels: true,
});

describe("AssemblyAI provider request mapping", () => {
  it("uses Universal-2 with automatic language detection and optional hints", () => {
    expect(
      buildAssemblyAISubmissionRequest({
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: ["ID", "en-US", "id"],
        speakerDiarization: false,
      }),
    ).toEqual({
      audio_url: AUDIO_URL,
      speech_models: ["universal-2"],
      punctuate: true,
      format_text: true,
      disfluencies: false,
      language_detection: true,
      language_detection_options: {
        expected_languages: ["en_us", "id"],
        fallback_language: "auto",
      },
    });
  });

  it("deduplicates language hints after provider-code mapping", () => {
    expect(
      buildAssemblyAISubmissionRequest({
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: ["en-GB", "en-UK"],
        speakerDiarization: false,
      }),
    ).toMatchObject({
      language_detection_options: {
        expected_languages: ["en_uk"],
        fallback_language: "auto",
      },
    });
  });

  it("maps known single-language variants and optional diarization", () => {
    expect(
      buildAssemblyAISubmissionRequest({
        audioUrl: AUDIO_URL,
        languageMode: "SINGLE_LANGUAGE",
        requestedLanguages: ["en-GB"],
        speakerDiarization: true,
      }),
    ).toMatchObject({
      speech_models: [ASSEMBLYAI_PROVIDER_MODEL],
      language_code: "en_uk",
      speaker_labels: true,
    });

    expect(
      buildAssemblyAISubmissionRequest({
        audioUrl: AUDIO_URL,
        languageMode: "SINGLE_LANGUAGE",
        requestedLanguages: ["id"],
        speakerDiarization: false,
      }),
    ).toMatchObject({ language_code: "id" });
  });

  it("rejects duplicate manual language selections before normalization", () => {
    for (const input of [
      {
        languageMode: "SINGLE_LANGUAGE" as const,
        requestedLanguages: ["id", "id"],
      },
      {
        languageMode: "MULTILINGUAL" as const,
        requestedLanguages: ["en", "id", "id"],
      },
      {
        languageMode: "MULTILINGUAL" as const,
        requestedLanguages: ["en", "id", "en"],
      },
    ]) {
      expectSyncProviderError(
        () =>
          buildAssemblyAISubmissionRequest({
            audioUrl: AUDIO_URL,
            speakerDiarization: false,
            ...input,
          }),
        "TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED",
      );
    }
  });

  it("supports only the initial English-Indonesian code-switching pair", () => {
    expect(
      buildAssemblyAISubmissionRequest({
        audioUrl: AUDIO_URL,
        languageMode: "MULTILINGUAL",
        requestedLanguages: ["id", "en-US"],
        speakerDiarization: true,
      }),
    ).toMatchObject({ language_codes: ["en", "id"] });

    for (const requestedLanguages of [
      ["id", "ms"],
      ["en"],
      ["en", "id", "ms"],
      ["en-xyz", "id"],
      ["en--", "id"],
    ]) {
      expectSyncProviderError(
        () =>
          buildAssemblyAISubmissionRequest({
            audioUrl: AUDIO_URL,
            languageMode: "MULTILINGUAL",
            requestedLanguages,
            speakerDiarization: false,
          }),
        "TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED",
      );
    }
  });

  it("rejects unsupported languages and unsafe provider input URLs", () => {
    expectSyncProviderError(
      () =>
        buildAssemblyAISubmissionRequest({
          audioUrl: AUDIO_URL,
          languageMode: "SINGLE_LANGUAGE",
          requestedLanguages: ["fr"],
          speakerDiarization: false,
        }),
      "TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED",
    );

    for (const audioUrl of [
      "http://project.supabase.co/audio.m4a",
      "https://user:password@project.supabase.co/audio.m4a",
      "https://project.supabase.co/audio.m4a#fragment",
      " https://project.supabase.co/audio.m4a",
      "https://project.supabase.co/audio\tm4a",
    ]) {
      expectSyncProviderError(
        () =>
          buildAssemblyAISubmissionRequest({
            audioUrl,
            languageMode: "AUTO_DETECT",
            requestedLanguages: [],
            speakerDiarization: false,
          }),
        "TRANSCRIPTION_PROVIDER_REQUEST_INVALID",
      );
    }
  });

  it("fails closed for malformed runtime inputs", () => {
    const sparseRequestedLanguages = new Array<string>(1);

    for (const malformedInput of [
      null,
      {},
      {
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: [null],
        speakerDiarization: false,
      },
      {
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: [],
        speakerDiarization: "yes",
      },
      {
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: ["   "],
        speakerDiarization: false,
      },
      {
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: ["\t"],
        speakerDiarization: false,
      },
      {
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: sparseRequestedLanguages,
        speakerDiarization: false,
      },
    ]) {
      expectSyncProviderError(
        () =>
          buildAssemblyAISubmissionRequest(
            malformedInput as never,
          ),
        "TRANSCRIPTION_PROVIDER_REQUEST_INVALID",
      );
    }
  });

  it("rejects prototype-inherited language names without changing provider intent", () => {
    for (const input of [
      {
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT" as const,
        requestedLanguages: ["constructor"],
        speakerDiarization: false,
      },
      {
        audioUrl: AUDIO_URL,
        languageMode: "SINGLE_LANGUAGE" as const,
        requestedLanguages: ["constructor"],
        speakerDiarization: false,
      },
      {
        audioUrl: AUDIO_URL,
        languageMode: "MULTILINGUAL" as const,
        requestedLanguages: ["constructor", "id"],
        speakerDiarization: false,
      },
    ]) {
      expectSyncProviderError(
        () => buildAssemblyAISubmissionRequest(input),
        "TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED",
      );
    }
  });
});

describe("AssemblyAI provider transport and polling", () => {
  it("submits to the EU endpoint without returning the signed audio URL", async () => {
    const fetchImplementation = jest.fn(async () =>
      response(200, { id: PROVIDER_JOB_ID, status: "queued" }),
    );
    const provider = providerWith(fetchImplementation as FetchLike);

    const result = await provider.submit({
      audioUrl: AUDIO_URL,
      languageMode: "AUTO_DETECT",
      requestedLanguages: [],
      speakerDiarization: false,
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      `${ASSEMBLYAI_EU_BASE_URL}/v2/transcript`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ Authorization: TEST_API_KEY }),
      }),
    );
    expect(result).toEqual({
      providerKey: "assemblyai",
      providerModel: "universal-2",
      providerJobId: PROVIDER_JOB_ID,
      status: "queued",
      providerMetadata: {
        status: "queued",
        region: "EU",
        speechModelRequested: "universal-2",
      },
    });
    expect(JSON.stringify(result)).not.toContain(AUDIO_URL);
    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
  });

  it("uses the US endpoint only when explicitly configured", async () => {
    const fetchImplementation = jest.fn(async () =>
      response(200, { id: PROVIDER_JOB_ID, status: "queued" }),
    );
    const provider = new AssemblyAITranscriptionProvider({
      apiKey: TEST_API_KEY,
      region: "US",
      fetchImplementation: fetchImplementation as FetchLike,
    });

    await provider.submit({
      audioUrl: AUDIO_URL,
      languageMode: "AUTO_DETECT",
      requestedLanguages: [],
      speakerDiarization: false,
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      `${ASSEMBLYAI_US_BASE_URL}/v2/transcript`,
      expect.any(Object),
    );
  });

  it("rejects invalid runtime provider configuration", () => {
    for (const config of [
      { apiKey: "" },
      { apiKey: "bad key" },
      { apiKey: TEST_API_KEY, region: "OTHER" },
      { apiKey: TEST_API_KEY, fetchImplementation: "not-a-function" },
      { apiKey: "bad\uD800key" },
    ]) {
      expectSyncProviderError(
        () => new AssemblyAITranscriptionProvider(config as never),
        config.apiKey === "" ||
          config.apiKey === "bad key" ||
          config.apiKey === "bad\uD800key"
          ? "TRANSCRIPTION_PROVIDER_AUTH_FAILED"
          : "TRANSCRIPTION_PROVIDER_REQUEST_INVALID",
      );
    }
  });

  it("does not automatically retry an ambiguous provider submission", async () => {
    const networkProvider = providerWith(
      jest.fn(async () => {
        throw new Error(`response lost after submit ${TEST_API_KEY}`);
      }) as FetchLike,
    );

    await expect(
      networkProvider.submit({
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: [],
        speakerDiarization: false,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
        retryable: false,
      },
    });

    const unavailableProvider = providerWith(
      jest.fn(async () => response(503, { error: "temporary" })) as FetchLike,
    );
    await expect(
      unavailableProvider.submit({
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: [],
        speakerDiarization: false,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
        retryable: false,
        httpStatus: 503,
      },
    });

    const malformedSuccessProvider = providerWith(
      jest.fn(async () => response(200, { status: "queued" })) as FetchLike,
    );
    await expect(
      malformedSuccessProvider.submit({
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: [],
        speakerDiarization: false,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
        retryable: false,
      },
    });
  });

  it("preserves a known provider job ID on failed or malformed submissions", async () => {
    const providerFailure = providerWith(
      jest.fn(async () =>
        response(200, {
          id: PROVIDER_JOB_ID,
          status: "error",
          error: "unsupported file format",
        }),
      ) as FetchLike,
    );

    await expect(
      providerFailure.submit({
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: [],
        speakerDiarization: false,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE",
        retryable: false,
        providerJobId: PROVIDER_JOB_ID,
      },
    });

    const malformedStatusProvider = providerWith(
      jest.fn(async () =>
        response(200, { id: PROVIDER_JOB_ID, status: "unknown" }),
      ) as FetchLike,
    );

    await expect(
      malformedStatusProvider.submit({
        audioUrl: AUDIO_URL,
        languageMode: "AUTO_DETECT",
        requestedLanguages: [],
        speakerDiarization: false,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
        retryable: false,
        providerJobId: PROVIDER_JOB_ID,
      },
    });
  });

  it("returns pending and normalized completed states", async () => {
    const fetchImplementation = jest
      .fn()
      .mockResolvedValueOnce(response(200, { id: PROVIDER_JOB_ID, status: "processing" }))
      .mockResolvedValueOnce(response(200, completedResponse()));
    const provider = providerWith(fetchImplementation as FetchLike);

    await expect(provider.getStatus(PROVIDER_JOB_ID)).resolves.toEqual({
      status: "processing",
      providerJobId: PROVIDER_JOB_ID,
      providerMetadata: { status: "processing", region: "EU" },
    });

    const completed = await provider.getStatus(PROVIDER_JOB_ID);
    expect(completed.status).toBe("completed");
    if (completed.status !== "completed") throw new Error("Expected completion");
    expect(completed.transcript.plainText).toBe("Halo world.");
    expect(completed.transcript.languageSummary).toEqual({
      primaryLanguage: "id",
      detectedLanguages: ["id"],
      confidence: 0.91,
      detectionEnabled: true,
    });
    expect(completed.transcript.providerMetadata).toMatchObject({
      region: "EU",
      speechModelUsed: "universal-2",
    });
    expect(completed.transcript.segments).toEqual([
      {
        segmentIndex: 0,
        startMs: 100,
        endMs: 420,
        text: "Halo",
        confidence: 0.97,
        languageCode: "id",
        speakerLabel: "A",
        providerSegmentId: `${PROVIDER_JOB_ID}:word:0`,
      },
      {
        segmentIndex: 1,
        startMs: 450,
        endMs: 900,
        text: "world.",
        confidence: 0.92,
        languageCode: "id",
        speakerLabel: "B",
        providerSegmentId: `${PROVIDER_JOB_ID}:word:1`,
      },
    ]);
    expect(JSON.stringify(completed)).not.toContain(AUDIO_URL);
    expect(JSON.stringify(completed)).not.toContain(TEST_API_KEY);
  });

  it("classifies provider job failures without exposing raw provider text", async () => {
    const rawProviderError = `Download error: unable to access ${AUDIO_URL}`;
    const provider = providerWith(
      jest.fn(async () =>
        response(200, {
          id: PROVIDER_JOB_ID,
          status: "error",
          error: rawProviderError,
        }),
      ) as FetchLike,
    );

    const result = await provider.getStatus(PROVIDER_JOB_ID);
    expect(result).toEqual({
      status: "error",
      providerJobId: PROVIDER_JOB_ID,
      failure: {
        code: "TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE",
        retryable: true,
        safeMessage:
          "The synchronized recording could not be read by the transcription provider.",
        providerJobId: PROVIDER_JOB_ID,
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawProviderError);
    expect(JSON.stringify(result)).not.toContain(AUDIO_URL);
  });

  it("classifies transport failures and honors Retry-After without leaking secrets", async () => {
    const provider = providerWith(
      jest.fn(async () =>
        response(
          429,
          { error: `rate limited ${TEST_API_KEY}` },
          { "Retry-After": "3" },
        ),
      ) as FetchLike,
    );

    await expect(
      provider.getStatus(PROVIDER_JOB_ID),
    ).rejects.toMatchObject({
      failure: {
        code: "TRANSCRIPTION_PROVIDER_RATE_LIMITED",
        retryable: true,
        httpStatus: 429,
        retryAfterMs: 3000,
      },
    });

    try {
      await provider.getStatus(PROVIDER_JOB_ID);
    } catch (error) {
      expect(String(error)).not.toContain(TEST_API_KEY);
    }

    const networkProvider = providerWith(
      jest.fn(async () => {
        throw new Error(`network failure ${TEST_API_KEY}`);
      }) as FetchLike,
    );
    await expect(
      networkProvider.getStatus(PROVIDER_JOB_ID),
    ).rejects.toMatchObject({
      failure: {
        code: "TRANSCRIPTION_PROVIDER_NETWORK_FAILED",
        retryable: true,
      },
    });
  });

  it(
    "retries an unreadable successful polling response and preserves the job ID",
    async () => {
      const malformedJsonResponse = {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new Error("truncated json");
        },
      } as unknown as Response;
      const provider = providerWith(
        jest.fn(async () => malformedJsonResponse) as FetchLike,
      );

      await expect(provider.getStatus(PROVIDER_JOB_ID)).rejects.toMatchObject({
        failure: {
          code: "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
          retryable: true,
          httpStatus: 200,
          providerJobId: PROVIDER_JOB_ID,
        },
      });
    },
  );

  it(
    "retries parsed but incomplete polling envelopes with the known job ID",
    async () => {
      for (const body of [
        {},
        { id: PROVIDER_JOB_ID },
        { id: "not-a-uuid", status: "processing" },
      ]) {
        const provider = providerWith(
          jest.fn(async () => response(200, body)) as FetchLike,
        );

        await expect(provider.getStatus(PROVIDER_JOB_ID)).rejects.toMatchObject({
          failure: {
            code: "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
            retryable: true,
            httpStatus: 200,
            providerJobId: PROVIDER_JOB_ID,
          },
        });
      }
    },
  );

  it(
    "fails closed for mismatched or unknown polling envelopes and retains the job ID",
    async () => {
      for (const body of [
        {
          id: "22222222-2222-4222-8222-222222222222",
          status: "processing",
        },
        { id: PROVIDER_JOB_ID, status: "unknown" },
      ]) {
        const provider = providerWith(
          jest.fn(async () => response(200, body)) as FetchLike,
        );

        await expect(provider.getStatus(PROVIDER_JOB_ID)).rejects.toMatchObject({
          failure: {
            code: "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
            retryable: false,
            httpStatus: 200,
            providerJobId: PROVIDER_JOB_ID,
          },
        });
      }
    },
  );

  it("canonicalizes provider UUID casing across polling and deletion", async () => {
    const uppercaseProviderJobId = PROVIDER_JOB_ID_WITH_HEX.toUpperCase();
    const fetchImplementation = jest
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          id: PROVIDER_JOB_ID_WITH_HEX,
          status: "processing",
        }),
      )
      .mockResolvedValueOnce(
        response(200, { id: PROVIDER_JOB_ID_WITH_HEX }),
      );
    const provider = providerWith(fetchImplementation as FetchLike);

    await expect(provider.getStatus(uppercaseProviderJobId)).resolves.toEqual({
      status: "processing",
      providerJobId: PROVIDER_JOB_ID_WITH_HEX,
      providerMetadata: { status: "processing", region: "EU" },
    });

    await expect(
      provider.deleteArtifact(uppercaseProviderJobId),
    ).resolves.toEqual({
      providerJobId: PROVIDER_JOB_ID_WITH_HEX,
      deleted: true,
      alreadyAbsent: false,
    });
  });

  it(
    "accepts only bounded RFC Retry-After values",
    async () => {
      const acceptedProvider = providerWith(
        jest.fn(async () =>
          response(
            429,
            { error: "rate limited" },
            { "Retry-After": "86400" },
          ),
        ) as FetchLike,
      );

      await expect(
        acceptedProvider.getStatus(PROVIDER_JOB_ID),
      ).rejects.toMatchObject({
        failure: {
          code: "TRANSCRIPTION_PROVIDER_RATE_LIMITED",
          retryable: true,
          httpStatus: 429,
          retryAfterMs: 86_400_000,
          providerJobId: PROVIDER_JOB_ID,
        },
      });

      const unsafeValues = [
        "1e308",
        "1e3",
        "0x10",
        "-1",
        "86401",
        new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toUTCString(),
      ];

      for (const retryAfter of unsafeValues) {
        const provider = providerWith(
          jest.fn(async () =>
            response(
              429,
              { error: "rate limited" },
              { "Retry-After": retryAfter },
            ),
          ) as FetchLike,
        );

        try {
          await provider.getStatus(PROVIDER_JOB_ID);
          throw new Error("Expected a rate-limit failure");
        } catch (error) {
          expect(error).toBeInstanceOf(TranscriptionProviderError);
          if (error instanceof TranscriptionProviderError) {
            expect(error.failure).toMatchObject({
              code: "TRANSCRIPTION_PROVIDER_RATE_LIMITED",
              retryable: true,
              httpStatus: 429,
              providerJobId: PROVIDER_JOB_ID,
            });
            expect(error.failure.retryAfterMs).toBeUndefined();
          }
        }
      }
    },
  );

  it(
    "preserves the provider job ID on invalid completed polling results",
    async () => {
      const provider = providerWith(
        jest.fn(async () =>
          response(200, {
            ...completedResponse(),
            words: [],
          }),
        ) as FetchLike,
      );

      await expect(provider.getStatus(PROVIDER_JOB_ID)).rejects.toMatchObject({
        failure: {
          code: "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
          diagnosticCode: "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
          retryable: false,
          providerJobId: PROVIDER_JOB_ID,
        },
      });
    },
  );

  it(
    "preserves a fine-grained language diagnostic on completed polling results",
    async () => {
      const provider = providerWith(
        jest.fn(async () =>
          response(200, {
            ...completedResponse(),
            language_code: null,
          }),
        ) as FetchLike,
      );

      await expect(provider.getStatus(PROVIDER_JOB_ID)).rejects.toMatchObject({
        failure: {
          code: "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
          diagnosticCode:
            "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING",
          retryable: false,
          providerJobId: PROVIDER_JOB_ID,
        },
      });
    },
  );

  it(
    "preserves the provider job ID on retryable deletion transport failures",
    async () => {
      const provider = providerWith(
        jest.fn(async () => {
          throw new Error("network unavailable");
        }) as FetchLike,
      );

      await expect(
        provider.deleteArtifact(PROVIDER_JOB_ID),
      ).rejects.toMatchObject({
        failure: {
          code: "TRANSCRIPTION_PROVIDER_NETWORK_FAILED",
          retryable: true,
          providerJobId: PROVIDER_JOB_ID,
        },
      });
    },
  );

  it("makes provider cleanup idempotent", async () => {
    const fetchImplementation = jest
      .fn()
      .mockResolvedValueOnce(response(200, { id: PROVIDER_JOB_ID }))
      .mockResolvedValueOnce(response(404, { error: "not found" }));
    const provider = providerWith(fetchImplementation as FetchLike);

    await expect(provider.deleteArtifact(PROVIDER_JOB_ID)).resolves.toEqual({
      providerJobId: PROVIDER_JOB_ID,
      deleted: true,
      alreadyAbsent: false,
    });
    await expect(provider.deleteArtifact(PROVIDER_JOB_ID)).resolves.toEqual({
      providerJobId: PROVIDER_JOB_ID,
      deleted: false,
      alreadyAbsent: true,
    });
  });

  it("validates the provider deletion confirmation ID", async () => {
    for (const body of [
      {},
      { id: "22222222-2222-4222-8222-222222222222" },
    ]) {
      const provider = providerWith(
        jest.fn(async () => response(200, body)) as FetchLike,
      );

      await expect(
        provider.deleteArtifact(PROVIDER_JOB_ID),
      ).rejects.toMatchObject({
        failure: {
          code: "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN",
          retryable: true,
          providerJobId: PROVIDER_JOB_ID,
        },
      });
    }
  });
  it("retries deletion when a successful HTTP response cannot be confirmed", async () => {
    const malformedJsonResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error("invalid json");
      },
    } as unknown as Response;
    const provider = providerWith(
      jest.fn(async () => malformedJsonResponse) as FetchLike,
    );

    await expect(
      provider.deleteArtifact(PROVIDER_JOB_ID),
    ).rejects.toMatchObject({
      failure: {
        code: "TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN",
        retryable: true,
        providerJobId: PROVIDER_JOB_ID,
      },
    });
  });
});

describe("AssemblyAI normalization and safety", () => {
  it("rejects malformed top-level completed responses with a safe provider error", () => {
    for (const value of [null, undefined, 42, "invalid", []]) {
      expectSyncProviderError(
        () => normalizeAssemblyAICompletedTranscript(value as never),
        "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
      );
    }
  });

  it("rejects malformed completed payloads instead of partially ingesting them", () => {
    const sparseWords = new Array(1);

    for (const words of [
      sparseWords,
      [{ text: "bad", start: 500, end: 100, confidence: 0.5 }],
      [null],
      [],
      [{ text: "bad", start: 1.5, end: 100, confidence: 0.5 }],
      [
        { text: "later", start: 500, end: 700, confidence: 0.5 },
        { text: "earlier", start: 100, end: 300, confidence: 0.5 },
      ],
    ]) {
      expectSyncProviderError(
        () =>
          normalizeAssemblyAICompletedTranscript({
            ...completedResponse(),
            words,
          }),
        "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
      );
    }
  });

  it("rejects malformed IDs and optional completed-response fields", () => {
    for (const override of [
      { id: "not-a-uuid" },
      { text: 42 },
      { language_codes: "en,id" },
      { language_detection: "true" },
      { speaker_labels: "true" },
      { utterances: {} },
      { utterances: new Array(1) },
      { speech_model_used: 42 },
    ]) {
      expectSyncProviderError(
        () =>
          normalizeAssemblyAICompletedTranscript({
            ...completedResponse(),
            ...override,
          }),
        "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
      );
    }
  });

  it("canonicalizes reviewed English response locales for code switching", () => {
    for (const input of [
      { language_code: "en_us", language_codes: ["en_us", "id"] },
      { language_code: "en_uk", language_codes: ["id", "en_uk"] },
      { language_code: "id", language_codes: ["id", "en_au"] },
    ]) {
      const normalized = normalizeAssemblyAICompletedTranscript({
        ...completedResponse(),
        ...input,
        language_detection: false,
      });

      expect(normalized.languageSummary).toMatchObject({
        primaryLanguage: input.language_code.replace(/_/g, "-"),
        detectedLanguages: ["en", "id"],
        detectionEnabled: false,
      });
      expect(
        normalized.segments.every((segment) => segment.languageCode === null),
      ).toBe(true);
    }
  });

  it("accepts nullable provider language_codes for later claim reconciliation", () => {
    const normalized = normalizeAssemblyAICompletedTranscript({
      ...completedResponse(),
      language_code: "id",
      language_codes: null,
      language_detection: false,
    });

    expect(normalized.languageSummary).toEqual({
      primaryLanguage: "id",
      detectedLanguages: ["id"],
      confidence: 0.91,
      detectionEnabled: false,
    });
    expect(
      normalized.segments.every((segment) => segment.languageCode === "id"),
    ).toBe(true);
  });

  it("preserves an exact English primary locale for a single response code", () => {
    const normalized = normalizeAssemblyAICompletedTranscript({
      ...completedResponse(),
      language_code: "en_us",
      language_codes: ["en_us"],
      language_detection: false,
    });

    expect(normalized.languageSummary).toEqual({
      primaryLanguage: "en-us",
      detectedLanguages: ["en-us"],
      confidence: 0.91,
      detectionEnabled: false,
    });
    expect(
      normalized.segments.every(
        (segment) => segment.languageCode === "en-us",
      ),
    ).toBe(true);
  });

  it("rejects malformed provider language-code collections", () => {
    const sparseLanguageCodes = new Array(1);

    for (const language_codes of [
      sparseLanguageCodes,
      [],
      ["en", "en"],
      ["id", "ms"],
      ["en", "en-us"],
      ["en", "id", "ms"],
      ["en", null],
      ["fr"],
      ["zzz"],
    ]) {
      expectSyncProviderError(
        () =>
          normalizeAssemblyAICompletedTranscript({
            ...completedResponse(),
            language_codes,
          }),
        "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
      );
    }
  });

  it("classifies language metadata failures by structural cause", () => {
    const sparseLanguageCodes = new Array(1);
    const cases: {
      override: Record<string, unknown>;
      diagnosticCode: ProviderDiagnosticCode;
    }[] = [
      {
        override: { language_code: null },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING",
      },
      {
        override: { language_code: undefined },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING",
      },
      {
        override: { language_code: 42 },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_INVALID",
      },
      {
        override: { language_codes: "en,id" },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_SHAPE_INVALID",
      },
      {
        override: { language_codes: sparseLanguageCodes },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_SHAPE_INVALID",
      },
      {
        override: { language_codes: ["en", "id", "ms"] },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_SHAPE_INVALID",
      },
      {
        override: { language_codes: [] },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_EMPTY",
      },
      {
        override: { language_codes: ["en", null] },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_MEMBER_INVALID",
      },
      {
        override: { language_codes: ["fr"] },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_MEMBER_INVALID",
      },
      {
        override: { language_code: "en", language_codes: ["en", "en_us"] },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_DUPLICATE",
      },
      {
        override: { language_code: "fr", language_codes: ["en", "id"] },
        diagnosticCode:
          "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_NOT_IN_LANGUAGE_CODES",
      },
    ];

    for (const { override, diagnosticCode } of cases) {
      expectSyncProviderDiagnostic(
        () =>
          normalizeAssemblyAICompletedTranscript({
            ...completedResponse(),
            ...override,
          }),
        diagnosticCode,
      );
    }
  });

  it("classifies sanitized completed-result validation failures", () => {
    expectSyncProviderDiagnostic(
      () =>
        normalizeAssemblyAICompletedTranscript({
          ...completedResponse(),
          language_code: null,
        }),
      "TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING",
    );
    expectSyncProviderDiagnostic(
      () =>
        normalizeAssemblyAICompletedTranscript({
          ...completedResponse(),
          words: [],
        }),
      "TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID",
    );
    expectSyncProviderDiagnostic(
      () =>
        normalizeAssemblyAICompletedTranscript({
          ...completedResponse(),
          text: 42,
        }),
      "TRANSCRIPTION_PROVIDER_RESULT_TEXT_INVALID",
    );
    expectSyncProviderDiagnostic(
      () =>
        normalizeAssemblyAICompletedTranscript({
          ...completedResponse(),
          speech_model_used: "unknown",
        }),
      "TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID",
    );
  });

  it("rejects unsupported language metadata and unrequested model provenance", () => {
    for (const override of [
      { language_code: null },
      { language_code: "zzz" },
      { language_code: "abc" },
      { language_code: "en-gb" },
      { language_code: " id " },
      { language_code: "fr", language_codes: ["en", "id"] },
      { language_code: "en-xyz", language_codes: ["en", "id"] },
      { speech_model_used: null },
      { speech_model_used: " universal-2 " },
      { speech_model_used: "universal-3-5-pro" },
    ]) {
      expectSyncProviderError(
        () =>
          normalizeAssemblyAICompletedTranscript({
            ...completedResponse(),
            ...override,
          }),
        "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
      );
    }
  });

  it("rejects NUL characters before database ingestion", () => {
    for (const override of [
      { text: "Halo\u0000world." },
      {
        words: [
          {
            text: "Halo\u0000",
            start: 100,
            end: 420,
            confidence: 0.97,
          },
        ],
      },
    ]) {
      expectSyncProviderError(
        () =>
          normalizeAssemblyAICompletedTranscript({
            ...completedResponse(),
            ...override,
          }),
        "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
      );
    }
  });

  it("rejects malformed Unicode and unsafe timestamps before database ingestion", () => {
    for (const override of [
      { text: "Halo\uD800world." },
      {
        words: [
          {
            text: "Halo\uDC00",
            start: 100,
            end: 420,
            confidence: 0.97,
          },
        ],
      },
      {
        words: [
          {
            text: "Halo",
            start: Number.MAX_SAFE_INTEGER + 1,
            end: Number.MAX_SAFE_INTEGER + 2,
            confidence: 0.97,
          },
        ],
      },
      { audio_duration: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expectSyncProviderError(
        () =>
          normalizeAssemblyAICompletedTranscript({
            ...completedResponse(),
            ...override,
          }),
        "TRANSCRIPTION_PROVIDER_RESULT_INVALID",
      );
    }
  });

  it("does not assign one dominant language to every code-switching word", () => {
    const normalized = normalizeAssemblyAICompletedTranscript({
      ...completedResponse(),
      language_code: "en",
      language_codes: ["en", "id"],
    });

    expect(normalized.segments.every((segment) => segment.languageCode === null)).toBe(
      true,
    );
    expect(normalized.languageSummary.detectedLanguages).toEqual([
      "en",
      "id",
    ]);

    const reversed = normalizeAssemblyAICompletedTranscript({
      ...completedResponse(),
      language_code: "id",
      language_codes: ["id", "en"],
    });
    expect(reversed.languageSummary.detectedLanguages).toEqual(["en", "id"]);
  });

  it("uses deterministic safe error classes", () => {
    expect(classifyAssemblyAIJobError("download error: url expired")).toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE",
      retryable: true,
    });
    expect(classifyAssemblyAIJobError("unsupported file format")).toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE",
      retryable: false,
    });
    expect(classifyAssemblyAIJobError("internal server timeout")).toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(classifyAssemblyAIJobError("language not available")).toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED",
      retryable: false,
    });
    expect(classifyAssemblyAIJobError("unknown provider failure")).toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_JOB_FAILED",
      retryable: false,
    });
  });

  it("keeps secrets, logs, signed URLs, and provider execution out of mobile code", () => {
    const adapterSource = readFileSync(
      resolve(
        process.cwd(),
        "../supabase/functions/_shared/transcription/assemblyai.ts",
      ),
      "utf8",
    );
    const providerSource = readFileSync(
      resolve(
        process.cwd(),
        "../supabase/functions/_shared/transcription/provider.ts",
      ),
      "utf8",
    );
    const mobileSource = readFileSync(
      resolve(process.cwd(), "src/services/transcription/contracts.ts"),
      "utf8",
    );
    const mobileRuntimeSource = [
      readSourceTree(resolve(process.cwd(), "app")),
      readSourceTree(resolve(process.cwd(), "src")),
    ].join("\n");

    expect(adapterSource).not.toContain("console.");
    expect(adapterSource).not.toContain("Deno.env");
    expect(adapterSource).not.toContain("EXPO_PUBLIC_");
    expect(adapterSource).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(
      JSON.stringify(
        new AssemblyAITranscriptionProvider({ apiKey: TEST_API_KEY }),
      ),
    ).not.toContain(TEST_API_KEY);
    expect(providerSource).not.toContain("EXPO_PUBLIC_");
    expect(mobileSource).not.toContain("ASSEMBLYAI");
    expect(mobileSource).not.toContain("audioUrl");
    expect(mobileRuntimeSource.toLowerCase()).not.toContain("assemblyai");
    expect(mobileRuntimeSource).not.toContain("ASSEMBLYAI_API_KEY");
  });
});
