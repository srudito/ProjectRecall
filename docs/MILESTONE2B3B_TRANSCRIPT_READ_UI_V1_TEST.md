# Milestone 2B.3B — Transcript Read UI v1 Test Plan

## Automated gates

Run from `frontend` with Node `20.19.4` and Yarn `1.22.22`:

```bash
npx tsc --noEmit

npx jest   __tests__/transcript-read-model.test.ts   __tests__/transcript-read-ui-source.test.ts   __tests__/transcription-result-client.test.ts   __tests__/transcription-result-worker.test.ts   __tests__/transcription-result-repository.test.ts   __tests__/transcription-result-mobile-source.test.ts   __tests__/localization.test.ts   __tests__/local-account-cleanup-repository.test.ts   --runInBand

npx jest --runInBand

npx eslint   ./app/session/[id].tsx   ./src/components/SessionTranscriptPanel.tsx   ./src/services/transcription/read-model.ts   ./__tests__/transcript-read-model.test.ts   ./__tests__/transcript-read-ui-source.test.ts   --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then run `git diff --check` from repository root.

## Required behavior

- Session Detail retains Overview, Timeline, and Evidence and adds a native-only
  Transcript tab;
- the transcript tab reads only the current version and ordered segments from
  SQLite;
- continuous text prefers current `plain_text` and falls back to segment text;
- cross-session, cross-version, duplicate, or out-of-order segments fail closed;
- synchronized transcript text remains visible with connectivity disabled;
- successful result-sync events refresh an already open tab;
- a background refresh failure preserves previously rendered local text;
- no Supabase client, provider API, worker endpoint, or privileged credential is
  referenced by the reader;
- English and Indonesian localization keys remain in parity;
- no editing, timestamped browser, search, export, or sharing is introduced.

## Controlled device acceptance

Use one development session whose transcript has already been synchronized by
Milestone 2B.3A.

1. Start the existing development build through Metro at the reviewed commit.
2. Open Session Detail and select Transcript.
3. Confirm selectable text, version number, segment count, and the offline badge.
4. Disable Wi-Fi and mobile data, navigate away, and reopen the same session.
5. Confirm the same version, count, and text remain visible.
6. Re-enable connectivity and confirm reading the tab created no new processing
   job or provider call.

Do not use sensitive conversation content during acceptance testing.
