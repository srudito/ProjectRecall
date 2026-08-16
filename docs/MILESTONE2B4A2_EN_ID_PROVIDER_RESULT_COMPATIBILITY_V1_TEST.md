# Milestone 2B.4A.2 — EN–ID Provider Result Compatibility v1 Test Plan

## Automated gates

Run from `frontend` with Node `20.19.4` and Yarn `1.22.22`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/assemblyai-provider.test.ts \
  __tests__/transcription-request-worker.test.ts \
  __tests__/transcription-worker-migration.test.ts \
  __tests__/transcription-contracts.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  ./__tests__/assemblyai-provider.test.ts \
  ./__tests__/transcription-request-worker.test.ts \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then run `git diff --check` from the repository root.

## Required automated behavior

- the existing nullable `language_codes` response behavior is retained and
  explicitly regression-tested;
- reviewed response locales `en_au`, `en_uk`, and `en_us` canonicalize to `en`
  for the EN–ID pair;
- canonical alias duplicates remain invalid;
- a single English response locale preserves the exact primary in a
  single-language summary;
- manual EN–ID claim reconciliation accepts either the full provider pair or
  only a reviewed provider primary;
- the provider primary remains in the durable summary;
- reconciled code-switching segments have `languageCode = null` rather than a
  false dominant-language label;
- unrelated languages and automatic-detection mismatches remain invalid;
- sanitized diagnostic codes persist without raw provider payload data;
- database completion failures remain distinct from provider failures;
- cleanup and idempotency semantics remain unchanged.

## Security/source boundary

Verify that the patch adds no:

- console logging of provider responses;
- raw response persistence;
- signed audio URL persistence;
- AssemblyAI key exposure;
- service-role or worker token exposure;
- direct provider execution from React Native;
- migration, package, lockfile, or native configuration change.

## Development deployment gate

After automated validation, commit and push the exact source set. Before
redeployment:

1. confirm the failed `M2B4A EN-ID Gate 3` provider cleanup is `succeeded`;
2. delete only that test session through the app;
3. verify processing jobs, runs, versions, segments, unresolved artifacts, and
   manual-review rows all return to zero;
4. confirm the linked project is the development project;
5. redeploy only `transcription-worker` from the committed source;
6. verify the authenticated Cron invocation still succeeds and the backend
   remains empty before the new request.

No migration is applied or rerun.

## Controlled EN–ID rerun

Create one fresh non-sensitive session after deployment:

```text
Title: M2B4A EN-ID Gate 3 Retry
Mode: MULTILINGUAL
Expected languages: en, id
```

Use one 15–25 second recording containing clear English and Bahasa Indonesia.
Wait for private upload synchronization, then request transcription exactly
once.

Required result:

- canonical request payload remains `MULTILINGUAL` with `["en", "id"]`;
- job and run succeed;
- current transcript version and segments are created;
- local result synchronization completes;
- full-text and timestamped transcript views are readable;
- provider cleanup succeeds;
- no unresolved provider artifact or manual-review row remains.

The completed durable language summary may preserve an English locale primary
such as `en-us`, but its normalized user-confirmed set must remain exactly EN–ID.
Per-word language labels may be null.

If the rerun fails, stop. Do not press Retry. Read only the sanitized
`last_error_code`, confirm provider cleanup, and use the diagnostic category to
determine the next bounded change.
