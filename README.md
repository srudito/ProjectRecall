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
persistence. Milestone 2B.3B adds a read-only, offline-capable transcript tab;
editing, search, export, and timestamped browsing remain later milestones.

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
