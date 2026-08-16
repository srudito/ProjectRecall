# Project Recall

**Capture every conversation. Remember every detail.**

Project Recall is an Android-first Expo/React Native application for local-first
recording, evidence capture, project/session organization, and private
Supabase synchronization.

## Current status

Milestone 1 engineering and production-binary verification are complete.
Milestone 2A establishes the provider-neutral batch-transcription data, queue,
scope, and retry contracts. Milestone 2B.1A adds the server-only AssemblyAI
Universal-2 adapter, and Milestone 2B.1B adds the durable authenticated request,
Cron-driven worker, signed-URL, atomic-ingestion, and provider-cleanup control
plane. Its development rollout has passed controlled live validation; production
remains untouched. Milestone 2B.2 connects the native local-first request queue
to the authenticated request endpoint and recording UI. Milestone 2B.3A adds
authenticated RLS result synchronization and atomic local SQLite transcript
persistence. Milestone 2B.3B adds a read-only, offline-capable transcript tab,
Milestone 2B.3C adds local timestamped segment browsing, Milestone 2B.4A
aligns session setup and local request contracts with the reviewed manual English,
Bahasa Indonesia, and EN–ID code-switching rollout. Milestone 2B.4A.1 makes
durable transcription progress/retry states explicit without presenting normal
background retries as terminal failures. Milestone 2B.4A.2 hardens the
server-only EN–ID completed-result boundary with explicit nullable-shape
coverage, English-locale compatibility, and sanitized diagnostics. Its
controlled rerun isolated the remaining failure to provider language metadata.
Milestone 2B.4A.3 then proved that manual EN–ID completed responses may omit a
provider primary language. Milestone 2B.4A.4 adds narrow nullable-primary
compatibility across the provider adapter, worker claim validation, and
append-only migration 0015 while preserving the user-confirmed EN–ID pair.
Development migration validation, worker v8 deployment, authenticated Cron HTTP
200 checks, one controlled mixed-language transcription, local Full Text and
Timestamps, provider cleanup, and final backend-zero cleanup all passed.
Production remains untouched. Playback seeking, editing, search, and export
remain later milestones.

## Source of truth

- Repository branch: `milestone1sync`
- Current committed source and tests override historical patches or chat notes.
- Applied Supabase migrations must never be edited or rerun on an existing
  environment.

## Local setup

```bash
cd frontend
nvm use
corepack disable 2>/dev/null || true
yarn install --frozen-lockfile
cp .env.example .env
npx expo start --dev-client
```

Only public/publishable values belong in `frontend/.env`. Supabase secret or
service-role keys, Google client secrets, JWT secrets, database passwords,
access tokens, and signing credentials must remain server-side and must never
be committed.

See [`docs/README.md`](docs/README.md) for architecture, migrations, validation,
Android build, and release instructions.
