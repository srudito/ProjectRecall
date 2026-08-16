# Milestone 2B.4A — Supported Language Modes v1 Test Plan

## Automated gates

Run from `frontend` with Node `20.19.4` and Yarn `1.22.22`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/transcription-language-capabilities.test.ts \
  __tests__/transcription-language-setup-source.test.ts \
  __tests__/transcription-contracts.test.ts \
  __tests__/transcription-request-mobile.test.ts \
  __tests__/transcription-request-worker.test.ts \
  __tests__/assemblyai-provider.test.ts \
  __tests__/localization.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  ./app/record/setup.tsx \
  ./src/services/session/service.ts \
  ./src/services/transcription/language-capabilities.ts \
  ./src/services/transcription/contracts.ts \
  ./__tests__/transcription-language-capabilities.test.ts \
  ./__tests__/transcription-language-setup-source.test.ts \
  ./__tests__/transcription-contracts.test.ts \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then run `git diff --check` from repository root.

## Required automated behavior

- the transcription setup does not import or render the unrestricted spoken
  language catalog;
- only canonical `en` and `id` are offered for manual transcription selection;
- reviewed English aliases normalize to `en`;
- canonical Bahasa Indonesia remains `id` and unsupported regional/manual tags
  fail closed;
- Auto detect saves no required manual selection;
- Single language requires exactly one supported value;
- Multilingual requires exactly English + Bahasa Indonesia;
- mode transitions cannot leave a stale unsupported combination;
- request preparation and idempotency use the same canonical capability result;
- malformed and unsupported values retain distinct safe error codes;
- frontend setup/contract code contains no provider secret, service-role key,
  worker token, provider URL, or direct provider execution;
- English and Indonesian localization keys remain in parity.

## Controlled UI acceptance

After commit and push, use the existing development build through Metro.
Confirm on Record Setup:

1. Auto detect has no unrestricted catalog and no manual language requirement.
2. One language exposes only English and Bahasa Indonesia and permits only one
   selection.
3. English + Bahasa Indonesia presents a fixed code-switching pair.
4. Switching among all three modes produces deterministic selections and no
   stale error.

No provider call is needed for this UI-only acceptance.

## Controlled live acceptance gates

Live validation is deliberately split into three independent development gates.
Do not run them in one batch and do not use sensitive speech.

### Gate 1 — English single-language

- create one short session with One language -> English;
- upload and request transcription once;
- verify durable job/run success, local result synchronization, transcript read,
  and provider cleanup;
- verify request payload and detected language evidence are consistent with the
  reviewed English path;
- clean only the generated transcription artifacts before the next gate.

### Gate 2 — Bahasa Indonesia single-language

Repeat the isolated flow with One language -> Bahasa Indonesia. Verify the
canonical request language is `id`, the result is locally persisted/readable,
and provider cleanup succeeds before cleanup.

### Gate 3 — English + Bahasa Indonesia code-switching

Use one short clip containing only non-sensitive English and Bahasa Indonesia
speech. Verify the canonical request pair is `["en", "id"]`, the durable worker
completes, detected-language metadata remains bounded to the reviewed pair, the
local transcript is readable offline, and provider cleanup succeeds.

For every live gate:

- development project only;
- one recording and one request;
- no second tap;
- no production action;
- no migration rerun;
- no secret output;
- stop on failed/cancelled work or unresolved provider artifacts.
