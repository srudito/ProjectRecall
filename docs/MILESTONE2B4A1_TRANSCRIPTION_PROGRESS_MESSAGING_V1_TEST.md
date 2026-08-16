# Milestone 2B.4A.1 — Transcription Progress Messaging UX v1 Test Plan

## Automated gates

Run from `frontend` with Node `20.19.4` and Yarn `1.22.22`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/transcription-request-presentation.test.ts \
  __tests__/transcription-progress-ui-source.test.ts \
  __tests__/transcription-result-worker.test.ts \
  __tests__/transcription-mobile-source.test.ts \
  __tests__/localization.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  ./src/components/RecordingTranscriptionRequestControl.tsx \
  ./src/services/transcription/request-presentation.ts \
  ./__tests__/transcription-request-presentation.test.ts \
  ./__tests__/transcription-progress-ui-source.test.ts \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then run `git diff --check` from repository root.

## Required automated behavior

- accepted requests without a result diagnostic use neutral waiting copy;
- processing, commit-pending, and cleanup-pending codes map to explicit progress
  phases rather than terminal error treatment;
- retryable result-sync diagnostics use warning/automatic-retry presentation;
- retrying request intents do not expose raw diagnostics as red failures;
- failed and cancelled rows retain terminal error treatment;
- a locally persisted current transcript changes the presentation to ready;
- the UI ready signal reads only the existing SQLite transcript cache;
- result-worker polling delays and retry/backoff logic remain unchanged;
- English and Indonesian localization keys remain in parity;
- no provider credential, worker token, service-role key, or direct provider call
  enters the React Native UI.

## Controlled UI acceptance

No provider call is required solely to validate this patch. After commit/push,
load the existing development build through Metro and confirm existing sessions
still render normally.

The next controlled live language gate can also serve as the dynamic progress
acceptance. During that one recording/request, observe that:

1. accepted work clearly communicates waiting/processing rather than looking
   failed;
2. a temporary retryable result-sync delay is not shown as a red terminal alert;
3. finalizing/cleanup wording may appear when those durable states are observed;
4. after local result persistence, the recording control shows `Transcript
   ready` / `Transkrip siap`;
5. actual terminal failed/cancelled work would still retain red alert treatment.

Do not manufacture a provider failure just to test terminal styling; automated
coverage is authoritative for that branch.
