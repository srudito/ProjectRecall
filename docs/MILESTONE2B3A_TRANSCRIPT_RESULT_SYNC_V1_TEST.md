# Milestone 2B.3A — Transcript Result Sync v1 Test Plan

## Automated gates

Run from `frontend` with Node `20.19.4` and Yarn `1.22.22`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/transcription-result-client.test.ts \
  __tests__/transcription-result-worker.test.ts \
  __tests__/transcription-result-repository.test.ts \
  __tests__/transcription-result-mobile-source.test.ts \
  __tests__/transcription-request-mobile.test.ts \
  __tests__/sqlite-migrations.test.ts \
  __tests__/local-account-cleanup-repository.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  ./src/services/transcription/result-types.ts \
  ./src/services/transcription/result-client.ts \
  ./src/services/sync/transcription-result-worker.ts \
  ./src/services/sync/transcription-request-worker.ts \
  ./src/services/sync/transcription-sync-events.ts \
  ./src/services/sync/ProjectSyncCoordinator.tsx \
  ./src/services/sqlite/repository.ts \
  ./__tests__/transcription-result-client.test.ts \
  ./__tests__/transcription-result-worker.test.ts \
  ./__tests__/transcription-result-repository.test.ts \
  ./__tests__/transcription-result-mobile-source.test.ts \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then run `git diff --check` from repository root.

## Required behavior

- offline result sync performs no remote reads;
- authenticated/RLS job scope is revalidated before local writes;
- pending server state is persisted without transcript rows;
- successful completion is ingested in one SQLite transaction;
- prior local current version is demoted before the new current upsert;
- segments are fetched in pages and replaced idempotently;
- transport failure preserves submitted intent and retries;
- membership loss/not-found cancels only the local poll anchor;
- provider cleanup must be succeeded before final result ingestion;
- no frontend provider/worker secrets or provider calls.

## Controlled device acceptance

After automated gates and commit review, create one short non-sensitive
development transcription. Keep the app open until the request becomes
submitted, then verify local SQLite contains one succeeded job/run/current
version and the exact remote segment count. Turn connectivity off and prove the
current version/segments remain readable from SQLite. Transcript text UI is not
part of this milestone.
