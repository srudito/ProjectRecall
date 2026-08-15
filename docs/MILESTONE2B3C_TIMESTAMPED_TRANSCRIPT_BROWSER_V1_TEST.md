# Milestone 2B.3C — Timestamped Transcript Browser v1 Test Plan

## Automated gates

Run from `frontend` with Node `20.19.4` and Yarn `1.22.22`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/transcript-read-model.test.ts \
  __tests__/transcript-read-ui-source.test.ts \
  __tests__/transcription-result-client.test.ts \
  __tests__/transcription-result-worker.test.ts \
  __tests__/transcription-result-repository.test.ts \
  __tests__/transcription-result-mobile-source.test.ts \
  __tests__/localization.test.ts \
  __tests__/local-account-cleanup-repository.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  ./src/components/SessionTranscriptPanel.tsx \
  ./src/services/transcription/read-model.ts \
  ./__tests__/transcript-read-model.test.ts \
  ./__tests__/transcript-read-ui-source.test.ts \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then run `git diff --check` from the repository root.

## Required behavior

- Continuous remains the default mode and keeps selectable local transcript
  text;
- Timestamped mode renders ordered local segments with start/end ranges;
- timestamp formatting supports minute and hour durations;
- optional speaker/language labels are normalized locally and provider-only
  identifiers do not enter the UI model;
- only the first 100 timestamped segments render initially;
- `Show more segments` reveals the next bounded batch without remote reads;
- invalid local timestamp ranges, empty segment text, duplicate identities, or
  invalid indexes fail closed;
- both modes remain available offline;
- no recording playback seek/control is introduced;
- no Supabase client, Edge Function, provider API, worker endpoint, or privileged
  credential is referenced by the browser;
- English and Indonesian localization keys remain in parity.

## Controlled device acceptance

Use a non-sensitive development session whose transcript is already cached
locally.

1. Start the existing development build through Metro at the reviewed commit.
2. Open Session Detail -> Transcript.
3. Confirm Full text still shows the same selectable transcript.
4. Switch to Timestamps and confirm every visible row has a time range and
   selectable text.
5. If cached speaker/language metadata exists, confirm it is displayed without
   exposing a provider identifier.
6. For a transcript with more than 100 segments, confirm the initial visible
   count is 100 and `Show more segments` increases it by 100.
7. Disable Wi-Fi and mobile data, navigate away, reopen the session, and confirm
   both modes still work from SQLite.
8. Re-enable connectivity and confirm browsing created no processing job,
   transcript row, or provider call.

Do not use sensitive conversation content during acceptance testing.
