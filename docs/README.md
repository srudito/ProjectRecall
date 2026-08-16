# Project Recall — Milestone 1 + Milestone 2 transcription foundations

**Tagline:** *Capture every conversation. Remember every detail.*

Project Recall is an Android-first, local-first recording and evidence
management application built with Expo/React Native, TypeScript, SQLite, and
Supabase.

## What Milestone 1 delivers

- Supabase email/password authentication, Google sign-in, connected-account
  visibility, safe Google linking/unlinking, hardened recovery, route guards,
  and permanent Delete Account.
- Automatic personal workspace and owner membership for new users.
- Offline-first project/session persistence with stable UUIDs, durable queues,
  idempotency, safe retry, and cloud restoration.
- Real microphone recording, pause/resume/stop, background recording, timer,
  playback, and offset tracking that excludes paused time.
- Image, video, document, note, and bookmark evidence with timeline ordering.
- Private `session-assets` Storage, signed access, Wi-Fi-only upload, orphan
  cleanup, and cloud-aware session deletion.
- Library timestamps, sorting, grouping, Card/Compact layouts, starred
  sessions, improved Sessions scrolling, and conditional Back to top.
- Crash-safe account deletion with distributed server gating, Storage/database
  cleanup, scoped SQLite/file cleanup, worker quiescence, and restart recovery.
- English and Bahasa Indonesia localization with key-parity tests.

Milestone 1 does **not** include functional transcription, OCR, AI summaries,
Ask AI, embeddings, diarization, billing, advertising, or team collaboration.
Milestone 2A adds the disabled, provider-neutral transcription schema, local
queue/cache, scope validation, and test contracts. Milestone 2B.1A adds only a
server-side AssemblyAI Universal-2 adapter with EU-default routing and mock
transport tests. No live provider is called and no transcription UI is exposed.

## Repository layout

```text
/app/
├── frontend/           Expo React Native app
├── backend/            FastAPI support service
├── supabase/           migrations and Edge Functions
└── docs/               architecture, implementation, and verification docs
```

## Toolchain

- Node `20.19.4` (`/app/frontend/.nvmrc`)
- Yarn `1.22.22`
- Expo SDK `54`
- React Native `0.81`
- TypeScript `5.9`

```bash
cd /app/frontend
nvm use
yarn install --frozen-lockfile
```

## Public environment configuration

Copy the safe template:

```bash
cd /app/frontend
cp .env.example .env
```

`EXPO_PUBLIC_*` values are embedded in the client bundle. Never put a
service-role/secret key, Google client secret, JWT signing secret, database
password, access token, refresh token, or signing credential in them.

Production EAS environment variables must include real values for:

```text
EXPO_PUBLIC_APP_ENV=production
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY
EXPO_PUBLIC_SUPPORT_EMAIL
EXPO_PUBLIC_PRIVACY_POLICY_URL
EXPO_PUBLIC_TERMS_OF_SERVICE_URL
```

The production EAS build hook fails closed when required public release values
are missing or still use example/reserved domains.

## Supabase migrations

Fresh environments apply migrations in filename order from `0001` through
`0013`. Existing environments must not rerun or edit applied migrations. An
existing Milestone 1 environment applies only new migration `0013` once after
review; it must not rerun `0001–0012`.

The development project's remote CLI migration ledger is not authoritative
because migrations were applied manually through SQL Editor. Do not run
`db push`, `migration repair`, or `db reset --linked` as a shortcut. Fresh
migration smoke testing belongs in an isolated disposable environment.

## Validation

```bash
cd /app/frontend
npx tsc --noEmit
npx jest --runInBand
npx expo-doctor
node ./scripts/validate-release-readiness.js --production
```

Run targeted ESLint on every changed TypeScript/JavaScript file. The
production release check requires production public environment variables.

## Android builds

Real microphone/background behavior requires a development, preview, or
production build; Expo Go is not sufficient.

```bash
cd /app/frontend
npx eas-cli@latest build --platform android --profile development
npx eas-cli@latest build --platform android --profile preview
npx eas-cli@latest build --platform android --profile production
```

The preview APK runs without Metro and is the minimum final release-mode
verification artifact. Production uses remote app-version management with
`autoIncrement: true`.

## Milestone transition

Milestone 1 engineering, runtime, migration, legal-page, and production-binary
verification are complete at tag `milestone1-release-candidate-v1`. Google Play
testing is deferred until the broader product is closer to public release.

Milestone 2A is complete at tag
`milestone2a-transcription-foundation-v1`, and Milestone 2B.1A is complete at
`milestone2b1a-assemblyai-provider-adapter-v1`. Milestone 2B.1B has completed its
controlled development rollout: migration/runtime validation, same-commit Edge
Function deployment, development-only secrets, live provider cleanup, durable
worker execution, authenticated Cron, and development feature activation all
passed. Production remains untouched.

Milestone 2B.2 connects the native app to that backend through the existing
SQLite v10 request queue. Milestone 2B.3A synchronizes completed transcript
results through authenticated RLS reads and stores them atomically in SQLite.
Milestone 2B.3B adds a native read-only Transcript tab that reads only that local
cache and remains available offline. Milestone 2B.3C adds a local timestamped
segment browser with bounded rendering. Milestone 2B.4A constrains manual
transcription setup to English, Bahasa Indonesia, or the fixed EN–ID
code-switching pair and canonicalizes the same capability in local request
contracts. Milestone 2B.4A.1 separates ordinary transcription progress/retry
messages from terminal errors and reports local transcript readiness without
changing worker semantics. Milestone 2B.4A.2 hardens the server-only EN–ID
completed-result boundary with explicit nullable-shape coverage and English-locale
compatibility, and adds bounded diagnostic codes without retaining raw provider
responses. The app
never receives AssemblyAI or worker secrets, and the server-side feature flag
remains authoritative. The controlled EN–ID rerun remains pending. Playback
seeking, editing, and user-created immutable versions remain later milestones.

See `ROADMAP.md`, `MILESTONE2_BATCH_TRANSCRIPTION_FOUNDATION_V1_IMPLEMENTATION.md`,
`MILESTONE2_BATCH_TRANSCRIPTION_FOUNDATION_V1_TEST.md`,
`MILESTONE2B1_ASSEMBLYAI_PROVIDER_ADAPTER_V1_IMPLEMENTATION.md`,
`MILESTONE2B1_ASSEMBLYAI_PROVIDER_ADAPTER_V1_TEST.md`,
`MILESTONE2B1_DURABLE_REQUEST_WORKER_V1_IMPLEMENTATION.md`,
`MILESTONE2B1_DURABLE_REQUEST_WORKER_V1_TEST.md`,
`MILESTONE2B2_MOBILE_TRANSCRIPTION_REQUEST_V1_IMPLEMENTATION.md`,
`MILESTONE2B2_MOBILE_TRANSCRIPTION_REQUEST_V1_TEST.md`,
`MILESTONE2B3A_TRANSCRIPT_RESULT_SYNC_V1_IMPLEMENTATION.md`,
`MILESTONE2B3A_TRANSCRIPT_RESULT_SYNC_V1_TEST.md`,
`MILESTONE2B3B_TRANSCRIPT_READ_UI_V1_IMPLEMENTATION.md`,
`MILESTONE2B3B_TRANSCRIPT_READ_UI_V1_TEST.md`,
`MILESTONE2B3C_TIMESTAMPED_TRANSCRIPT_BROWSER_V1_IMPLEMENTATION.md`,
`MILESTONE2B3C_TIMESTAMPED_TRANSCRIPT_BROWSER_V1_TEST.md`,
`MILESTONE2B4A_SUPPORTED_LANGUAGE_MODES_V1_IMPLEMENTATION.md`,
`MILESTONE2B4A_SUPPORTED_LANGUAGE_MODES_V1_TEST.md`,
`MILESTONE2B4A1_TRANSCRIPTION_PROGRESS_MESSAGING_V1_IMPLEMENTATION.md`,
`MILESTONE2B4A1_TRANSCRIPTION_PROGRESS_MESSAGING_V1_TEST.md`,
`MILESTONE2B4A2_EN_ID_PROVIDER_RESULT_COMPATIBILITY_V1_IMPLEMENTATION.md`, and
`MILESTONE2B4A2_EN_ID_PROVIDER_RESULT_COMPATIBILITY_V1_TEST.md`.

## Public legal pages

Static, tracking-free legal pages are stored under `docs/legal/` and can be
published with GitHub Pages.

Recommended GitHub Pages settings:

```text
Source: Deploy from a branch
Branch: milestone1sync
Folder: /docs
```

Expected public URLs:

```text
https://srudito.github.io/ProjectRecall/legal/privacy-policy/
https://srudito.github.io/ProjectRecall/legal/terms-of-service/
https://srudito.github.io/ProjectRecall/legal/account-deletion/
```

The first two URLs are intended for the public Expo/EAS variables used by the
Profile screen. The account-deletion URL is intended for the Google Play Data
Safety account-deletion field. Confirm all three URLs load over HTTPS without a
login before configuring production EAS or Play Console.


## Milestone 2B.3A transcript result sync

- Implementation: `MILESTONE2B3A_TRANSCRIPT_RESULT_SYNC_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B3A_TRANSCRIPT_RESULT_SYNC_V1_TEST.md`
- Scope: authenticated RLS result reads, durable polling, paginated segments, and atomic SQLite persistence. Transcript UI remains deferred.

## Milestone 2B.3B transcript read UI

- Implementation: `MILESTONE2B3B_TRANSCRIPT_READ_UI_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B3B_TRANSCRIPT_READ_UI_V1_TEST.md`
- Scope: native read-only transcript display from the existing local SQLite result cache, including offline availability. Editing, search, and export remain deferred.

## Milestone 2B.3C timestamped transcript browser

- Implementation: `MILESTONE2B3C_TIMESTAMPED_TRANSCRIPT_BROWSER_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B3C_TIMESTAMPED_TRANSCRIPT_BROWSER_V1_TEST.md`
- Scope: local-only timestamp ranges and ordered selectable segment browsing with bounded rendering. Playback seeking and editing remain deferred.


## Milestone 2B.4A supported transcription language modes

- Implementation: `MILESTONE2B4A_SUPPORTED_LANGUAGE_MODES_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B4A_SUPPORTED_LANGUAGE_MODES_V1_TEST.md`
- Scope: native setup and local request canonicalization for automatic detection, English, Bahasa Indonesia, and the reviewed EN–ID code-switching pair. No server or provider deployment change.


## Milestone 2B.4A.1 transcription progress messaging

- Implementation: `MILESTONE2B4A1_TRANSCRIPTION_PROGRESS_MESSAGING_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B4A1_TRANSCRIPTION_PROGRESS_MESSAGING_V1_TEST.md`
- Scope: distinguish recoverable waiting/processing/finalizing/cleanup/retry states from terminal failures and show local transcript readiness without changing backend or retry behavior.


## Milestone 2B.4A.2 EN–ID provider result compatibility

- Implementation: `MILESTONE2B4A2_EN_ID_PROVIDER_RESULT_COMPATIBILITY_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B4A2_EN_ID_PROVIDER_RESULT_COMPATIBILITY_V1_TEST.md`
- Scope: server-only English-locale compatibility, explicit nullable-response regression coverage, narrow manual EN–ID claim reconciliation, and sanitized failure diagnostics. No migration or mobile change.
