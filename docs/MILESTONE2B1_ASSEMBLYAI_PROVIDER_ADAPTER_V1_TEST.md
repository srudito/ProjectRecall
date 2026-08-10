# Milestone 2B.1A — AssemblyAI Provider Adapter Foundation v1 Test Plan

## Additional fail-closed runtime cases

The adapter tests also verify that:

- prototype-inherited property names such as `constructor` are rejected as
  unsupported language hints in automatic, single-language, and multilingual
  modes;
- null, undefined, primitive, and array top-level completed responses produce
  `TRANSCRIPTION_PROVIDER_RESULT_INVALID` rather than a raw JavaScript error.

## Automated validation

From `/app/frontend`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/assemblyai-provider.test.ts \
  __tests__/transcription-contracts.test.ts \
  __tests__/transcription-foundation-migration.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./__tests__/assemblyai-provider.test.ts" \
  "./__tests__/transcription-contracts.test.ts" \
  "./__tests__/transcription-foundation-migration.test.ts" \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

The frontend TypeScript/Jest graph imports the pure shared provider modules and
therefore type-checks and executes them. The frontend ESLint base path does not
cover `supabase/functions/_shared`.

When Deno is available, additionally run from `/app`:

```bash
deno check \
  supabase/functions/_shared/transcription/provider.ts \
  supabase/functions/_shared/transcription/assemblyai.ts

deno lint \
  supabase/functions/_shared/transcription/provider.ts \
  supabase/functions/_shared/transcription/assemblyai.ts
```

If Deno is unavailable, record:

```text
DENO_LOCAL_CHECK=UNAVAILABLE
```

and require API-based Edge Function bundling before the adapter is used by a
deployed function.

From `/app`:

```bash
git diff --check
git status --short
```

Expected:

```text
TypeScript      0 errors
Focused Jest    passed
Full Jest       passed
ESLint          0 errors, 0 warnings
Release check   passed
Expo Doctor     18/18 passed
git diff check  no output
```

## Request mapping tests

Tests must verify:

- EU is the default endpoint and US routing requires explicit configuration;
- malformed runtime provider configuration fails closed;
- model is pinned to `universal-2`;
- automatic detection supports optional normalized hints and deduplicates
  equivalent provider codes after mapping;
- single-language mapping supports initial English variants and Indonesian;
- code switching accepts only reviewed English codes/variants + Indonesian
  and rejects arbitrary `en-*` values;
- unsupported language configurations fail with a stable non-retryable code;
- diarization is opt-in;
- punctuation/text formatting are enabled;
- disfluencies remain disabled;
- unsafe HTTP, URL-userinfo-bearing, fragment-bearing, edge-whitespace,
  raw-control-character, or malformed-Unicode URLs are rejected;
- blank language hints are rejected rather than silently widening automatic
  language detection;
- all provider requests disable redirect following;
- malformed runtime request shapes fail with a stable safe error.

## Transport and polling tests

Tests must verify:

- POST submission uses the Authorization header and EU endpoint;
- submission result does not contain signed audio URL or API key;
- queued and processing states remain pending;
- completed state is normalized;
- provider `error` state returns a stable safe failure;
- raw provider errors are not persisted or returned;
- HTTP `429` honors only bounded RFC decimal/IMF-fixdate `Retry-After` values,
  ignores malformed, non-finite, non-decimal, or over-24-hour delays, and remains
  retryable;
- polling network failure, unreadable successful polling JSON, and parsed but
  incomplete polling envelopes map to a stable retryable error while preserving
  the canonical provider job ID;
- valid mismatched provider IDs and unknown provider statuses fail closed;
- completed-result normalization failures retain the known provider job ID;
- ambiguous submission network/HTTP `408`/`5xx`/malformed-success outcomes are
  non-retryable and never trigger blind duplicate submission;
- a valid provider transcript ID is preserved when a failed or malformed submit
  response exposes one;
- provider UUID casing is canonicalized consistently for polling and cleanup;
- cleanup treats HTTP `404` as idempotent already-absent success;
- cleanup validates that a successful deletion response contains the requested
  provider transcript ID;
- malformed or mismatched successful deletion responses and retryable deletion
  transport failures preserve the provider transcript ID.

## Result normalization tests

Tests must verify:

- canonical plain text;
- primary language and confidence;
- word timestamp ordering across the complete response;
- confidence bounds;
- malformed optional response fields and non-UUID transcript IDs fail closed;
- deterministic provider segment IDs;
- speaker labels when present;
- malformed completed payloads fail closed;
- empty, sparse, malformed, duplicate, inconsistent, unsupported single-code,
  or out-of-scope multilingual language-code collections fail closed;
- provider-reported code-switching languages are preserved in the normalized
  language summary;
- NUL characters and malformed Unicode surrogate sequences in transcript or word
  text are rejected before database ingestion;
- timestamps must be safe integers;
- completed responses require a primary language from the reviewed snapshot
  of AssemblyAI's documented language-code enumeration;
- completed responses must exactly confirm
  `speech_model_used=universal-2` without whitespace normalization;
- provider audio duration must remain within the safe numeric range;
- normalized metadata excludes audio URL, raw response, and secrets.

## Source safety checks

The test must confirm:

- no `console.*` logging in the adapter;
- no `Deno.env` lookup in the pure adapter;
- no `EXPO_PUBLIC_*` provider configuration;
- no Supabase privileged key name in the adapter;
- no AssemblyAI provider execution or key reference anywhere in mobile runtime
  source.

A fake API key and fake signed URL may appear only in test fixtures.

## Manual checks

No live AssemblyAI request is allowed in Milestone 2B.1A. Do not create a
provider API key or Supabase provider secret for this phase.

Confirm:

```text
transcription_enabled=false
no migration 0014
no new Edge Function
no Cron schedule
no mobile UI change
no live provider spend
```

## Exit criteria

The phase is complete only when:

```text
ASSEMBLYAI_ADAPTER_SOURCE_REVIEW=APPROVE
AUTOMATED_VALIDATION=PASS
PROVIDER_SECRET_CREATED=false
LIVE_PROVIDER_CALLS=0
TRANSCRIPTION_FEATURE_ENABLED=false
```
