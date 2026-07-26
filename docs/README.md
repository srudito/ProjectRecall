# Project Recall — Milestone 1

**Tagline:** *Capture every conversation. Remember every detail.*

Android-first multimodal recording and knowledge-capture application. Milestone 1
delivers a reliable **local-to-cloud recording workflow** with no AI features.

---

## What Milestone 1 delivers

- Real Supabase email/password authentication (sign-up, verify, sign-in, forgot & reset password, persistent session, sign out).
- Automatic personal workspace + owner membership on new user (Supabase trigger).
- Project + session CRUD with expected spoken-language preferences (Auto Detect, Single, Multilingual).
- Real microphone recording with pause/resume/stop, timer, and offset tracking that excludes paused time.
- Add evidence: take/select photo, select existing video, select document (system picker), text notes, timestamped bookmarks.
- Chronological session timeline sorted by `recording_offset_ms → created_at → id`.
- Post-recording review with playback path, counts, and re-edit affordances.
- Durable local persistence (SQLite metadata + app-controlled file directory).
- Upload queue with idempotency keys, exponential backoff, and manual retry.
- Private Supabase Storage bucket `session-assets` scoped by workspace via RLS.
- Full English + Bahasa Indonesia localization with English fallback.

Explicitly **out of scope** for Milestone 1 (see `docs/ROADMAP.md`):
transcription, live transcription, OCR, AI summaries, Ask AI, embeddings,
speaker diarization, billing, advertising, admin control panel, team
collaboration.

## Repository layout

```
/app/
├── frontend/                  # Expo React Native (mobile)
├── backend/                   # FastAPI (Milestone 1: health, config, JWT helper)
├── supabase/                  # SQL migrations (schema, RLS, storage, triggers)
├── docs/                      # This folder: architecture, database, security, etc.
└── .env.example
```

## Prerequisites

- Node 20+ / Expo SDK 54
- Python 3.11+
- A Supabase project
- Android device or emulator for real recording

## Environment variables

See `/app/.env.example`. Mobile only reads `EXPO_PUBLIC_*`; the service role key
must NEVER be exposed to the mobile bundle.

## Applying Supabase migrations

```bash
supabase link --project-ref YOUR_PROJECT_REF
psql < supabase/migrations/0001_init_schema.sql
psql < supabase/migrations/0002_rls_policies.sql
psql < supabase/migrations/0003_storage_bucket.sql
psql < supabase/migrations/0004_triggers.sql
```

Or paste each file into the Supabase SQL editor in order.

## Running

```bash
# Restart services in the Emergent preview:
sudo supervisorctl restart backend expo

# Backend health check:
curl "$EXPO_PUBLIC_BACKEND_URL/api/v1/health"
```

## Creating an Android development build

Milestone 1 requires a dev build for real microphone recording, background
recording, and the foreground-service notification. **Expo Go is NOT sufficient.**

On the Emergent platform, users deploy by pressing **Publish** in the top-right
of the Emergent UI which triggers `eas build`. `eas.json` is Emergent-managed —
do not edit it. See `docs/RECORDING.md` for device-specific caveats.

## Running tests

```bash
# Mobile
cd /app/frontend && npx jest

# Backend
cd /app/backend && python -m pytest test_server.py -v
```

## Known limitations

- Android background recording, foreground-service notification, screen lock,
  Bluetooth microphone, and call-interruption behaviour require a physical
  Android device on a development build. Implemented, not device-verified.
- SQLite is unavailable on web preview — the local persistence layer degrades
  gracefully to no-op.
- Checksum computation is deferred (see `RECORDING.md`).
- No AI features are implemented, called, or configured.

See `ROADMAP.md` for later milestones.
