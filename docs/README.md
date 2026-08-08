# Project Recall — Milestone 1

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

Milestone 1 does **not** include transcription, OCR, AI summaries, Ask AI,
embeddings, diarization, billing, advertising, or team collaboration.

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
`0012`. Existing environments must not rerun or edit applied migrations.

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

## Release gates before Milestone 2

- Configure real support, privacy-policy, and terms URLs in EAS production.
- Build and test a new native binary after Android backup/permission changes.
- Inspect the merged Android manifest.
- Run preview APK regression without Metro.
- Run a fresh migration smoke test on an isolated project/database.
- Complete the final Milestone 1 release checklist.

See `ROADMAP.md` and `MILESTONE1_RELEASE_READINESS_V1_TEST.md`.

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
