# Project Recall — Milestone 1

**Tagline:** *Capture every conversation. Remember every detail.*

Android-first multimodal recording and knowledge-capture application. Milestone 1
delivers a reliable **local-to-cloud recording workflow** with no AI features.

See `/app/docs/` for the complete architecture, database, recording, sync,
language, security, navigation, and roadmap documents.

## Quickstart

1. Create a Supabase project. Copy the URL, anon key, service role key, and JWT secret.
2. Populate `/app/frontend/.env` (public only) and `/app/backend/.env` (private).
3. Apply migrations from `/app/supabase/migrations/` in order.
4. `sudo supervisorctl restart backend expo`
5. Sign up an account in the app to receive an auto-created personal workspace.
6. To exercise real microphone recording, generate an Android dev build (see docs).

The full README is in `/app/docs/README.md`.
