# Milestone 2B.4A.3 - EN–ID Language Metadata Shape Diagnostics v1 Test Plan

## Automated gates

Run from `frontend` with Node `20.19.4` and Yarn `1.22.22`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/assemblyai-provider.test.ts \
  __tests__/transcription-request-worker.test.ts \
  __tests__/transcription-worker-migration.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  ./__tests__/assemblyai-provider.test.ts \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then run `git diff --check` from the repository root.

## Required behavior

- null or omitted `language_code` maps to
  `TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING`;
- malformed or unsupported primary language maps to
  `TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_INVALID`;
- non-array, sparse, or over-cardinality `language_codes` maps to
  `TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_SHAPE_INVALID`;
- a present empty language-code array maps to
  `TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_EMPTY`;
- null, malformed, unsupported, or unrelated members map to
  `TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_MEMBER_INVALID`;
- canonical duplicates map to
  `TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_DUPLICATE`;
- a valid primary absent from a non-empty returned language set maps to
  `TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_NOT_IN_LANGUAGE_CODES`;
- omitted or null `language_codes` remains accepted;
- valid EN–ID, English-locale, single-language, words, text, model, and claim
  behavior remains unchanged;
- completed polling preserves the bounded code and provider artifact identity
  needed for cleanup;
- the safe user-facing message remains generic;
- no raw provider metadata or secret enters the diagnostic.

## Security and source boundary

Verify that the changed source adds no:

- provider response logging;
- raw language value persistence;
- transcript text persistence outside existing transcript tables;
- signed audio URL persistence;
- AssemblyAI key, worker token, service-role key, or secret exposure;
- migration, package, lockfile, native, mobile UI, feature-flag, or Cron change.

## Development deployment gate

After automated validation:

1. commit and push the exact source set;
2. confirm the failed `M2B4A EN–ID Gate 3 Retry` run has
   `provider_cleanup_status = succeeded`;
3. delete only that test session through the app;
4. verify jobs, runs, versions, segments, unresolved artifacts, and
   manual-review rows return to zero;
5. deploy only `transcription-worker` to the linked development project;
6. verify Cron calls the new version with HTTP 200 while the backend remains
   empty.

No migration is applied or rerun.

## Controlled diagnostic rerun

Create one fresh, non-sensitive session:

```text
Title: M2B4A EN–ID Gate 3 Diagnostic
Mode: MULTILINGUAL
Expected languages: en, id
```

Use one 15-25 second English and Bahasa Indonesia recording. Wait for private
upload synchronization and request transcription exactly once.

If the run succeeds, verify the transcript, local persistence, timestamped view,
and provider cleanup. If it fails, stop without pressing Retry. Audit only:

- job and run status;
- the bounded `last_error_code`;
- provider cleanup status;
- unresolved-provider and manual-review counts.

Do not retain or print raw provider payloads.
