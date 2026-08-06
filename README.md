# Project Recall

**Capture every conversation. Remember every detail.**

Project Recall is an Android-first Expo/React Native application for local-first
recording, evidence capture, project/session organization, and private
Supabase synchronization.

## Current status

Milestone 1 feature development is complete. The current release-closure pass
covers Android backup policy, permission minimization, reproducible build tool
versions, public legal/support configuration, version display, and final
release verification. Milestone 2 transcription has not started.

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
