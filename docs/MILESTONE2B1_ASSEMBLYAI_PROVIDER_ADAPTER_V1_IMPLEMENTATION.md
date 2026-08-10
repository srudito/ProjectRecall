# Milestone 2B.1A — AssemblyAI Provider Adapter Foundation v1

## Objective

Add the first reviewed server-side transcription provider adapter without
creating a request endpoint, worker, Cron schedule, live provider call, mobile
UI, or feature activation.

This phase keeps the Milestone 2A database and local-first contracts unchanged:

```text
transcription_enabled=false
```

## Provider decision

The first provider is AssemblyAI asynchronous pre-recorded Speech-to-Text:

```text
Provider key: assemblyai
Model: Universal-2
Default region: EU
Transport: REST + JSON
Completion model: polling
```

Universal-2 is selected for broad language coverage, including Bahasa
Indonesia, while the EU endpoint preserves the initial regional boundary. The
adapter still exposes a provider-neutral interface so a later provider can be
added without changing canonical transcript storage.

Reference documentation:

- <https://www.assemblyai.com/docs/api-reference/transcripts/submit>
- <https://www.assemblyai.com/docs/api-reference/transcripts/get>
- <https://www.assemblyai.com/docs/api-reference/overview>
- <https://www.assemblyai.com/docs/pre-recorded-audio/code-switching>
- <https://www.assemblyai.com/docs/pre-recorded-audio/label-speakers>
- <https://www.assemblyai.com/docs/api-reference/transcripts/delete>

## Shared server contracts

`supabase/functions/_shared/transcription/provider.ts` defines:

- provider submission input;
- provider job status;
- normalized transcript and word-segment output;
- safe provider failures, retry metadata, and known provider job IDs;
- provider artifact deletion result;
- `TranscriptionProvider` interface;
- injected `FetchLike` transport for deterministic unit tests.

The contract is server-only. It does not import mobile modules and it contains
no provider key, signed URL, Supabase privileged key, or environment lookup.

## AssemblyAI adapter

`supabase/functions/_shared/transcription/assemblyai.ts` implements:

```text
POST   /v2/transcript
GET    /v2/transcript/{provider_job_id}
DELETE /v2/transcript/{provider_job_id}
```

The default base URL is:

```text
https://api.eu.assemblyai.com
```

US routing is available only through an explicit constructor region. Invalid
runtime regions are rejected and arbitrary base URLs are not accepted. The
resolved region is included in safe provider metadata for later auditability.

### Request mapping

Every submission sets:

```json
{
  "speech_models": ["universal-2"],
  "punctuate": true,
  "format_text": true,
  "disfluencies": false
}
```

Initial language capability is deliberately narrow:

```text
AUTO_DETECT
  → language_detection=true
  → optional expected-language hints

SINGLE_LANGUAGE
  → en, en-US, en-GB/en-UK, en-AU, or id

MULTILINGUAL
  → exactly one reviewed English code/variant + Bahasa Indonesia
  → unsupported or arbitrary `en-*` variants fail closed
  → language_codes=["en","id"]
```

The provider-neutral mobile contract can represent more languages. The
AssemblyAI adapter rejects unsupported configurations with a stable safe error
until they are separately benchmarked and reviewed. Manual single-language and
multilingual modes require the exact raw entry count and reject duplicate
selections rather than silently deduplicating caller state. Runtime allowlist
lookup uses own properties only, so prototype-inherited names such as
`constructor` cannot be mistaken for supported provider language codes.

Speaker diarization is opt-in per request through `speaker_labels=true`. This
phase does not enable speaker identification or infer real person names.

### Input URL safety

The adapter accepts only an HTTPS URL without embedded URL userinfo and with:

- non-empty host;
- no URL username or password;
- no fragment;
- no edge whitespace.

A later worker will generate a short-lived private Storage signed URL only
after it owns a durable job lease. The adapter sends that URL to AssemblyAI but
never returns or persists it in provider metadata or normalized results. Raw
ASCII control characters are rejected rather than silently normalized by the
URL parser, and equivalent provider language hints are deduplicated after
provider-code mapping.

## Result normalization

A completed provider response is first required to be a non-null JSON object;
malformed top-level values fail with a stable provider error rather than a raw
runtime exception. A valid completed response is converted into:

- provider key and verified actual/requested model;
- provider job ID;
- canonical plain text;
- a required primary language from the reviewed snapshot of AssemblyAI's
  documented language-code enumeration, provider-reported language codes, and
  confidence; newly introduced provider codes fail closed until reviewed;
- one canonical segment per provider word;
- millisecond timestamps;
- word confidence;
- generic speaker label when diarization is enabled;
- deterministic provider segment ID;
- bounded safe provider metadata.

The normalizer fails closed if:

- provider ID is not a valid AssemblyAI transcript UUID;
- provider status is invalid;
- word payload or optional arrays/booleans/text fields have invalid types, or
  an array contains sparse/inherited entries that cannot originate from valid
  provider JSON;
- the primary language is absent, has edge whitespace, or is not one of the
  documented AssemblyAI language-code values;
- provider language-code collections are empty, contain nulls or duplicates,
  exceed two values, contain a single code outside `en`/`id`, are inconsistent
  with the primary language, or are not within the reviewed English–Indonesian
  code-switching boundary;
- the completed response omits `speech_model_used`, changes its exact value with
  whitespace, or reports a model other than the requested `universal-2`;
- transcript or word text contains a NUL character or malformed Unicode surrogate
  sequence that cannot be persisted in PostgreSQL text/JSON safely;
- a word has blank text;
- timestamps are missing, negative, unsafe integers, reversed, or out of
  chronological order;
- provider audio duration is negative, non-finite, or outside JavaScript's safe
  numeric range;
- confidence is outside `[0,1]`;
- no usable word segments or canonical plain text can be produced.

The normalized result excludes `audio_url`, Authorization headers, API keys,
raw provider errors, and full raw provider responses.

## Safe error model

Transport and provider errors map to stable codes such as:

```text
TRANSCRIPTION_PROVIDER_AUTH_FAILED
TRANSCRIPTION_PROVIDER_RATE_LIMITED
TRANSCRIPTION_PROVIDER_UNAVAILABLE
TRANSCRIPTION_PROVIDER_AUDIO_UNAVAILABLE
TRANSCRIPTION_PROVIDER_LANGUAGE_UNSUPPORTED
TRANSCRIPTION_PROVIDER_RESULT_INVALID
TRANSCRIPTION_PROVIDER_JOB_FAILED
```

Only fixed safe messages may cross into durable `last_safe_error` fields.
Provider response bodies, signed URLs, API keys, and network exception messages
are never included.

Polling and cleanup network failures, unreadable successful polling bodies,
parsed but incomplete polling envelopes, HTTP `408`/`5xx`, provider
server/timeout failures, and provider download/unreachable failures can remain
retryable. A valid mismatched provider ID or unknown provider status still fails
closed as an invalid result. Known polling/deletion job IDs are canonicalized to
lowercase and retained on every safe failure after the caller supplies them.
HTTP `429` remains retryable. `Retry-After` is accepted only as an RFC decimal
second count or IMF-fixdate whose delay is a finite safe integer no greater than
24 hours; malformed or larger hints are ignored so the durable worker can apply
its own bounded backoff policy.

Submission is different: a network failure, HTTP `408`/`5xx`, malformed JSON,
or malformed successful response can occur after the provider accepted and
billed the job. The AssemblyAI submit API does not expose an idempotency key in
the reviewed request contract, so the adapter returns
`TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN` with `retryable=false`.
A future worker must not blindly resubmit that job; it must move it into an
explicit reconciliation/manual-review path. When a malformed or failed submission
response still contains a valid provider transcript ID, that ID is preserved in
the safe failure so the worker can poll or delete the known artifact. Request,
authentication,
unsupported language, unsupported/empty audio, not-found, and invalid-result
conditions are also non-retryable at this adapter layer.

## Provider artifact deletion

Deletion uses the same regional base URL. HTTP `404` is treated as an
idempotent already-absent result. A successful response must contain the exact
requested transcript ID before cleanup is reported as complete. A malformed or
mismatched successful response is classified as
`TRANSCRIPTION_PROVIDER_DELETION_OUTCOME_UNKNOWN` with `retryable=true`, because
DELETE is idempotent and HTTP `404` is already treated as completed cleanup. Other
non-success responses are classified through the same safe transport error model.

A future worker must call deletion only after the canonical transcript has been
committed successfully. Cleanup retry orchestration is outside this phase.

## Security boundary

This phase does not create or read `ASSEMBLYAI_API_KEY`.

A future Edge Function will read the key from Supabase project secrets and pass
it to the adapter constructor. The key must never appear in:

```text
frontend code
EXPO_PUBLIC variables
EAS public environment variables
Git
SQL migrations
job payloads
provider metadata
safe error messages
logs
API responses
```

## Deliberately excluded

Milestone 2B.1A does not include:

- migration `0014`;
- transcription request Edge Function;
- transcription worker Edge Function;
- private Storage signed-URL creation;
- durable job claim or lease mutation;
- database result ingestion;
- provider cleanup retry queue;
- Cron scheduling;
- AssemblyAI account or API key creation;
- live provider requests;
- mobile request worker;
- transcript synchronization or UI;
- summary, action-item, rewrite, or LLM Gateway integration;
- feature flag activation.

## Next phase

Milestone 2B.1B will add reviewed database RPCs, authenticated intake, durable
worker claiming, signed private Storage input, atomic result ingestion, and
provider cleanup retry behavior. It must reuse this adapter without exposing
provider secrets to the mobile app. The worker must also wrap provider calls in
a bounded timeout/AbortSignal that is shorter than its durable lease.
