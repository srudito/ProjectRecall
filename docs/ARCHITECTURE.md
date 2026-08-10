# Architecture

Project Recall is a local-first mobile application with Supabase as the cloud
data platform. Milestone 2A adds a provider-neutral batch-transcription control
plane. Milestone 2B.1A adds a pure server-side AssemblyAI adapter without
enabling transcription or making a live provider call.

## Layers

```text
┌─────────────────────────────────────────────────────────┐
│  Mobile (Expo React Native + expo-router)               │
│  ├─ Screens (app/*)                                     │
│  ├─ Providers (Theme, i18n, Query, Keyboard)            │
│  ├─ Stores (zustand: auth, recording)                   │
│  ├─ Services                                            │
│  │  ├─ recording/     state machine and offsets         │
│  │  ├─ session/       CRUD and timeline events          │
│  │  ├─ files/         validation and sanitisation       │
│  │  ├─ language/      precedence and validation         │
│  │  ├─ transcription/ provider-neutral request contract │
│  │  ├─ upload-queue/  backoff and idempotency            │
│  │  ├─ sqlite/        durable local metadata/queues     │
│  │  └─ supabase/      Auth and data repositories        │
│  └─ Domain (enums, Zod models, error codes)             │
├─────────────────────────────────────────────────────────┤
│  Backend (FastAPI /api/v1)                              │
│  ├─ /health                                             │
│  ├─ /config    public runtime config                    │
│  ├─ /me        JWT-verified whoami                      │
│  └─ Supabase JWT verification helper                    │
├─────────────────────────────────────────────────────────┤
│  Supabase (managed)                                     │
│  ├─ Auth        email/password + provider metadata      │
│  ├─ Postgres    schema, RLS, durable processing state   │
│  ├─ Storage     private `session-assets`                │
│  └─ Edge Functions (Delete Account; future job intake)  │
└─────────────────────────────────────────────────────────┘
```

## Mobile architecture

- **File-based routing** via `expo-router`. Grouped routes:
  `(auth)`, `(onboarding)`, `(tabs)`, `record/*`, `session/[id]`, `project/[id]`.
- **Theme** is a pure token layer (`src/theme/tokens.ts`) exposed through a
  provider that supports light/dark/system.
- **i18n** wraps `i18n-js` with a namespaced translator and English fallback.
- **State** uses `zustand` for local UI/auth/recording state.
- **Cloud query support** uses `@tanstack/react-query` where appropriate.

## Local persistence

- `expo-sqlite` stores durable metadata, sync queues, deletion queues, and the
  Milestone 2A transcription request/cache tables.
- Files live under the application-controlled document directory.
- Stable UUIDs are reused locally and in Supabase so offline work can reconcile
  without generating duplicate cloud entities.
- SQLite migration version `10` creates:
  - `local_processing_jobs`;
  - `local_transcription_runs`;
  - `local_transcript_versions`;
  - `local_transcript_segments`;
  - `local_transcription_request_queue`.
- Session deletion and scoped Delete Account cleanup remove these tables'
  relevant rows before deleting parent sessions or profiles.

## Cloud synchronisation

- Upload queues are persisted in SQLite.
- Recording/evidence files are uploaded to private Storage before metadata is
  considered synchronized.
- Retries use exponential backoff with jitter.
- Idempotency keys prevent duplicates across app restarts and safe retries.

## Authentication flow

1. Root layout initializes auth state through Supabase Auth.
2. Session tokens are stored in `expo-secure-store`.
3. Route guards suppress private routes while unauthenticated or during
   crash-safe account deletion.
4. Sign-up bootstrap creates a profile, personal workspace, and owner
   membership atomically.

## Storage architecture

- Bucket: `session-assets`, private, 500 MB per-object limit.
- Path convention:
  `{workspace_id}/{session_id}/{asset_id}/{sanitized_filename}`.
- Storage policies enforce active workspace membership and account-deletion
  write gating.

## Milestone 2A transcription boundary

Phase 2A is a control-plane and data-contract milestone only:

1. A recording must already be marked `synchronized` and have a private Storage
   path matching its workspace/session/recording scope.
2. Language hints are normalized before an idempotency key is generated.
3. The mobile request contract never includes a local file URI, provider key,
   provider secret, or privileged Supabase credential.
4. Postgres stores jobs, retry/lease state, provider attempts, transcript
   versions, and timestamped segments.
5. Authenticated clients may read workspace-visible processing/transcript data
   but cannot directly insert, update, or delete those cloud tables.
6. A reviewed server-side worker in Phase 2B will use privileged server
   credentials and private Storage access; no provider secret belongs in the
   mobile bundle or `EXPO_PUBLIC_*`.
7. The `transcription_enabled` feature flag remains false, so no transcription
   UI or provider execution path is exposed.

## Milestone 2B.1A provider boundary

The first provider adapter lives under:

```text
supabase/functions/_shared/transcription/
```

The provider-neutral module defines submission, polling, normalization, safe
failure, and cleanup contracts. The AssemblyAI adapter:

1. defaults to `https://api.eu.assemblyai.com`;
2. pins `speech_models=["universal-2"]`;
3. maps initial English/Bahasa Indonesia language configurations;
4. optionally enables speaker diarization;
5. normalizes completed word results into canonical timestamped segments;
6. excludes signed URLs, API keys, and raw provider responses from returned
   metadata;
7. treats provider deletion as idempotent.

The adapter receives an API key through constructor injection but does not read
environment variables itself. This keeps the pure provider module testable and
prevents an accidental mobile import from implicitly acquiring provider
credentials.

## Future provider execution

Phase 2B.1B will create the authenticated request endpoint and durable polling
worker. The worker must claim durable jobs by lease, generate a short-lived
private Storage signed URL only after claim, record each provider attempt,
avoid holding long-running work inside a mobile request, and write only stable
safe error codes/messages to user-visible state. Provider credentials remain
server-side. No Cron schedule or feature activation occurs until controlled
live verification passes.
