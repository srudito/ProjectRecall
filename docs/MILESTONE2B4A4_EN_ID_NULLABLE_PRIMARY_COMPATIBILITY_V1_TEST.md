# Milestone 2B.4A.4 — EN–ID Nullable Primary Compatibility v1 Test Plan

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
  ./__tests__/transcription-request-worker.test.ts \
  ./__tests__/transcription-worker-migration.test.ts \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then run `git diff --check` from the repository root.

## Required behavior

- missing primary plus canonical returned EN–ID pair is normalized successfully;
- normalized summary preserves `primaryLanguage = null`;
- code-switching segment language labels remain null;
- missing primary without the full pair remains invalid;
- single-language and automatic-detection worker claims reject null primary;
- manual EN–ID worker claims accept null primary and exact pair;
- string-primary and English-locale behavior remains unchanged;
- retry, cleanup, checksum, and database-failure boundaries remain unchanged;
- no raw provider data or secret enters diagnostics or mobile code.

## Migration validation

Migration 0015 must be the only new migration and must not edit migration 0014.
Before applying it to development:

```text
local/remote commit aligned
backend jobs/runs/versions/segments = 0
unresolved provider artifacts = 0
manual-review runs = 0
```

Use `supabase migration list` first. Apply only the pending migration with the
reviewed linked-development command. Do not run or rewrite migration 0014.

Then run:

```bash
npx supabase db query \
  --linked \
  --agent yes \
  -f supabase/tests/0015_transcription_nullable_primary_en_id_behavior.sql
```

Required markers:

```text
TRANSCRIPTION_NULLABLE_PRIMARY_MULTILINGUAL_CHECK=PASS
TRANSCRIPTION_NULLABLE_PRIMARY_SINGLE_LANGUAGE_REJECTION_CHECK=PASS
TRANSCRIPTION_NULLABLE_PRIMARY_AUTO_DETECT_REJECTION_CHECK=PASS
TRANSCRIPTION_NULLABLE_PRIMARY_PAIR_REQUIREMENT_CHECK=PASS
TRANSCRIPTION_NULLABLE_PRIMARY_DETECTION_REJECTION_CHECK=PASS
TRANSCRIPTION_STRING_PRIMARY_REGRESSION_CHECK=PASS
PROJECT_RECALL_TRANSCRIPTION_NULLABLE_PRIMARY_BEHAVIOR=PASS
```

The test is transaction-wrapped and rolls back.

## Development deployment gate

After migration validation, deploy only `transcription-worker` from the same
committed source. Verify a new function version, authenticated Cron HTTP 200,
and an otherwise empty backend. Do not deploy `transcription-request`, change
Cron, rotate secrets, or touch production.

## Controlled live rerun

Create exactly one fresh session:

```text
Title: M2B4A EN-ID Gate 3 Nullable Primary
Mode: MULTILINGUAL
Expected languages: en, id
```

Record 15–25 seconds containing clear English and Bahasa Indonesia. Wait for the
private recording upload to synchronize, then request transcription once.

Required result:

- canonical request remains `MULTILINGUAL` with `["en", "id"]`;
- job and run succeed;
- run detected languages are EN–ID;
- primary detected language is null;
- language detection status is `USER_CONFIRMED`;
- current transcript version and segments are created;
- full-text and timestamped local views are readable;
- provider cleanup succeeds;
- unresolved-provider and manual-review counts remain zero.

If the run fails, do not retry. Read only the bounded diagnostic code and confirm
provider cleanup before defining another change.
