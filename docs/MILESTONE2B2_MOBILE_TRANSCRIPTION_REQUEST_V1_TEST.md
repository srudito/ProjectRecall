# Milestone 2B.2 — Mobile Transcription Request Integration v1 Test Plan

## Automated validation

Run from `/app/frontend` using the repository-pinned Node/Yarn toolchain:

```bash
npx tsc --noEmit

npx jest \
  __tests__/transcription-request-mobile.test.ts \
  __tests__/transcription-mobile-source.test.ts \
  __tests__/transcription-contracts.test.ts \
  __tests__/sqlite-migrations.test.ts \
  __tests__/recording-upload-worker.test.ts \
  __tests__/project-sync-worker.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./src/components/SessionRecordingPanel.tsx" \
  "./src/components/RecordingTranscriptionRequestControl.tsx" \
  "./src/services/sqlite/repository.ts" \
  "./src/services/sync/ProjectSyncCoordinator.tsx" \
  "./src/services/sync/transcription-request-worker.ts" \
  "./src/services/sync/transcription-sync-events.ts" \
  "./src/services/transcription/feature-availability.ts" \
  "./src/services/transcription/request-client.ts" \
  "./src/services/transcription/service.ts" \
  "./__tests__/transcription-request-mobile.test.ts" \
  "./__tests__/transcription-mobile-source.test.ts" \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then from `/app`:

```bash
git --no-pager diff --no-ext-diff --check
```

Required: every command exits `0`, the full Jest suite passes, and Expo Doctor
reports all checks passing.

## Required focused behavior coverage

The mobile request tests must prove:

- a stable provider-neutral local queue record is built;
- request intent can be persisted before binary upload finishes;
- failed/cancelled upload state cannot be queued until upload is retried;
- offline execution does not claim queued work;
- pending metadata/upload dependencies defer without consuming retry budget;
- a successful request stores the server job ID;
- an idempotent `created=false` active server response is accepted;
- a terminal remote failed job is not mislabeled as submitted;
- stale `submitting` rows are recovered before each worker run;
- feature-disabled/authentication conditions preserve durable local intent;
- retryable network errors use bounded backoff;
- retry exhaustion becomes terminal locally;
- server response scope mismatch fails closed;
- deleted sessions cancel the local intent;
- a queue row for another signed-in user is never submitted.

The static source test must also prove that frontend source contains no
AssemblyAI API key, worker token, or direct `transcription-worker` invocation.

## Manual development-build verification

Do this only after automated validation and patch review/commit.

Use the development Supabase project whose Milestone 2B.1B backend activation
has already been validated. Do not use production.

### Online synchronized recording

1. Sign in with a development account.
2. Open a session with a synchronized short non-sensitive recording.
3. Confirm `Request transcription` is visible.
4. Request transcription once.
5. Confirm the local status progresses from queued/submitting to requested.
6. Confirm repeated taps cannot create duplicate local requests.
7. Confirm the backend Cron continues to process the accepted job and provider
   cleanup reaches `succeeded` before deleting any test transcription graph.

### Offline-first request before upload completion

1. Start/save a short non-sensitive recording while offline or before its
   upload has completed.
2. With a previously cached enabled feature state, request transcription.
3. Confirm the UI immediately reports a local queued request and explains that
   cloud upload must finish first.
4. Confirm no remote request is attempted while offline.
5. Restore connectivity.
6. Confirm normal metadata/recording upload synchronization completes first.
7. Confirm the transcription request is then submitted without a second user
   action.

### Kill-switch safety

The client cache is intentionally non-authoritative. If the development server
feature is disabled during a test, an existing/stale mobile `true` cache must
not create provider work: the server returns `TRANSCRIPTION_FEATURE_DISABLED`
and the local request remains deferred for a later sync cycle.

Do not leave development `transcription_enabled=false` accidentally after a
kill-switch test unless that state is intentionally being reviewed.

## Scope boundary

A `submitted` mobile request is the end of Milestone 2B.2. This test plan does
not require transcript content to appear in React Native. Transcript result
synchronization/display is a separate later milestone.
