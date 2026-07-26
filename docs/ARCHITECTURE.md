# Architecture

Project Recall Milestone 1 is a two-tier mobile + backend architecture with
Supabase as the cloud data platform.

## Layers

```
┌───────────────────────────────────────────────┐
│  Mobile (Expo React Native + expo-router)     │
│  ├─ Screens (app/*)                           │
│  ├─ Providers (Theme, i18n, Query, Keyboard)  │
│  ├─ Stores (zustand: auth, recording)         │
│  ├─ Services                                  │
│  │  ├─ recording/  (state machine, offset)    │
│  │  ├─ session/    (CRUD + timeline events)   │
│  │  ├─ files/      (validation, sanitisation) │
│  │  ├─ language/   (precedence, validation)   │
│  │  ├─ timeline/   (ordering)                 │
│  │  ├─ upload-queue/ (backoff, idempotency)   │
│  │  ├─ sqlite/     (durable local metadata)   │
│  │  └─ supabase/   (auth, client)             │
│  └─ Domain (enums, Zod models, error codes)   │
├───────────────────────────────────────────────┤
│  Backend (FastAPI /api/v1)                    │
│  ├─ /health                                   │
│  ├─ /config    (public runtime config)        │
│  ├─ /me        (JWT-verified whoami)          │
│  └─ Supabase JWT verification helper          │
├───────────────────────────────────────────────┤
│  Supabase (managed)                           │
│  ├─ Auth        (email/password + triggers)   │
│  ├─ Postgres    (schema + RLS)                │
│  └─ Storage     (private `session-assets`)    │
└───────────────────────────────────────────────┘
```

## Mobile architecture

- **File-based routing** via `expo-router`. Grouped routes:
  `(auth)`, `(onboarding)`, `(tabs)`, `record/*`, `session/[id]`, `project/[id]`.
- **Theme** is a pure token layer (`src/theme/tokens.ts`) exposed through a
  provider that supports light/dark/system.
- **i18n** wraps `i18n-js` with a namespaced translator and English fallback.
  `Localization.getLocales()` seeds the initial value; user choice persists via
  `@/src/utils/storage`.
- **State**: `zustand` for local UI state (auth session, recording snapshot);
  `@tanstack/react-query` reserved for cloud fetches.

## Local persistence

- `expo-sqlite` for durable metadata (`local_sessions`, `local_notes`,
  `local_bookmarks`, `local_media_assets`, `local_timeline_events`,
  `local_upload_queue`, etc.).
- Files (recording audio, images, videos, documents) live on disk in the
  application-controlled directory (`FileSystem.documentDirectory + sessions/<id>/…`).
- The same UUIDs are used locally and in Supabase so uploads can reconcile.

## Cloud synchronisation

- Upload queue is persisted in SQLite. On sync:
  1. Attempt file upload to `session-assets/{workspace_id}/{session_id}/{asset_id}/{filename}`.
  2. Insert metadata row via Supabase JS with RLS.
  3. Only when both succeed and the session/asset row can be re-read is the
     item marked `synchronized`.
- Retries use exponential backoff with jitter (`services/upload-queue/backoff.ts`).
- Idempotency keys prevent duplicates across retries.

## Authentication flow

1. Root layout initializes `useAuthStore` via `supabase.auth.getSession()` +
   `onAuthStateChange`. Session tokens are stored in `expo-secure-store`.
2. `app/index.tsx` redirects to `(auth)/welcome` if unauthenticated and
   `(tabs)/home` otherwise.
3. Sign-up triggers a Supabase database trigger that creates the profile,
   personal workspace, and owner membership atomically.

## Storage architecture

- Bucket: `session-assets`, private, 500 MB per-object limit.
- Path convention: `{workspace_id}/{session_id}/{asset_id}/{sanitized_filename}`.
- RLS policies on `storage.objects` enforce workspace membership by parsing the
  first folder segment as a UUID and passing it to `public.is_workspace_member`.

## Future AI boundary

- **Nothing** in Milestone 1 calls an AI provider or exposes AI menus.
- Extension points exist as future foundation tables (`processing_jobs`,
  `transcription_runs`, `transcript_versions`) and the language metadata fields
  already on `sessions`.
- Feature flags gate the corresponding UI in later milestones.
